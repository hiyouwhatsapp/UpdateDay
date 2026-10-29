import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config.ts";
import { renderIcon, snapshotIcon } from "./icons.ts";
import { finishSwap, startSwap, uploadAll } from "./swap.ts";
import type { Notifier } from "./notify.ts";
import { OpenCloud, type PriceTarget } from "./openCloud.ts";
import type { Step } from "./schedule.ts";
import { logLine, saveState, type SavedPrice, type State } from "./state.ts";

const BROADCAST_MAX_LATE_MS = 2 * 60 * 1000;
const EVENT_LEAD_MS = 20 * 60 * 1000;
const PRICE_WRITE_GAP_MS = 400;
const MAX_NAME_LENGTH = 50;
const MAX_TITLE_LENGTH = 50;
const NAME_TOKEN = "{name}";
const TIME_TOKEN = /\{time\}/g;
const PERCENT_TOKEN = /\{percent\}/g;

export type RunContext = {
	config: Config;
	state: State;
	cloud: OpenCloud | null;
	now: Date;
	notify?: Notifier;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readBlob(config: Config, file: string): Blob {
	return new Blob([readFileSync(resolve(config.baseDir, file))]);
}

function salePrice(original: number, percentOff: number): number {
	return Math.max(1, Math.round(original * (1 - percentOff / 100)));
}

function requireCloud(ctx: RunContext): OpenCloud {
	if (!ctx.cloud) {
		throw new Error("No API key loaded");
	}
	return ctx.cloud;
}

async function resolveTargets(cloud: OpenCloud, ctx: RunContext): Promise<PriceTarget[]> {
	const sale = ctx.config.sale!;
	const passes = sale.gamePasses === "all"
		? await cloud.listPriceTargets("gamePass")
		: sale.gamePasses.map((id) => ({ kind: "gamePass" as const, id }));
	const products = sale.developerProducts === "all"
		? await cloud.listPriceTargets("developerProduct")
		: sale.developerProducts.map((id) => ({ kind: "developerProduct" as const, id }));
	return [...passes, ...products];
}

async function writeVerifiedPrice(cloud: OpenCloud, target: PriceTarget, price: number): Promise<void> {
	await cloud.setPrice(target, price);
	const after = await cloud.getPrice(target);
	if (after.price !== price) {
		throw new Error(`${target.kind} ${target.id}: wrote ${price} but Roblox reports ${after.price}. Check the key has the write scope.`);
	}
}

export function taggedName(name: string, tag: string, position: "prefix" | "suffix", percentOff: number): string {
	const text = tag.replace(PERCENT_TOKEN, String(percentOff)).trim();
	if (!text || name.includes(text)) {
		return name;
	}
	const room = Math.max(0, MAX_NAME_LENGTH - text.length - 1);
	const base = name.length > room ? name.slice(0, room).trimEnd() : name;
	return position === "suffix" ? `${base} ${text}` : `${text} ${base}`;
}

async function writeVerifiedName(cloud: OpenCloud, target: PriceTarget, name: string): Promise<void> {
	await cloud.setName(target, name);
	const after = await cloud.getPrice(target);
	if (after.name !== name) {
		throw new Error(`wrote name "${name}" but Roblox reports "${after.name}"`);
	}
}

async function tagName(cloud: OpenCloud, ctx: RunContext, saved: SavedPrice): Promise<void> {
	const sale = ctx.config.sale!;
	if (!sale.nameTag) {
		return;
	}
	const tagged = taggedName(saved.name, sale.nameTag, sale.nameTagPosition ?? "prefix", sale.percentOff);
	if (tagged === saved.name) {
		return;
	}
	saved.taggedName = tagged;
	saveState(ctx.config.statePath, ctx.state);
	try {
		await writeVerifiedName(cloud, saved, tagged);
		logLine(ctx.state, `    renamed to "${tagged}"`);
	} catch (error) {
		logLine(ctx.state, `    rename failed, price still discounted: ${error instanceof Error ? error.message : error}`);
	}
}

async function resumeItem(cloud: OpenCloud, ctx: RunContext, saved: SavedPrice): Promise<void> {
	const live = await cloud.getPrice(saved);
	if (live.price !== saved.salePrice) {
		await writeVerifiedPrice(cloud, saved, saved.salePrice);
		logLine(ctx.state, `  ${saved.name || saved.id}: ${saved.originalPrice} -> ${saved.salePrice} (finished after a restart)`);
	}
	if (ctx.config.sale!.nameTag && (!saved.taggedName || live.name !== saved.taggedName)) {
		await tagName(cloud, ctx, saved);
	}
}

async function startSale(ctx: RunContext): Promise<void> {
	const cloud = requireCloud(ctx);
	const sale = ctx.config.sale!;
	for (const target of await resolveTargets(cloud, ctx)) {
		const existing = ctx.state.prices.find((saved) => saved.kind === target.kind && saved.id === target.id);
		if (existing) {
			if (!existing.restored) {
				await resumeItem(cloud, ctx, existing);
			}
			continue;
		}
		const info = await cloud.getPrice(target);
		if (info.price === null || !info.isForSale) {
			logLine(ctx.state, `  skip ${target.kind} ${target.id} (not for sale)`);
			continue;
		}
		const discounted = salePrice(info.price, sale.percentOff);
		const saved: SavedPrice = {
			kind: target.kind,
			id: target.id,
			name: info.name,
			originalPrice: info.price,
			salePrice: discounted,
			restored: false,
		};
		ctx.state.prices.push(saved);
		saveState(ctx.config.statePath, ctx.state);
		await writeVerifiedPrice(cloud, target, discounted);
		logLine(ctx.state, `  ${info.name || target.id}: ${info.price} -> ${discounted}`);
		await tagName(cloud, ctx, saved);
		await sleep(PRICE_WRITE_GAP_MS);
	}
}

export async function restorePrices(ctx: RunContext): Promise<void> {
	const cloud = requireCloud(ctx);
	for (const saved of ctx.state.prices) {
		const nameOwed = Boolean(saved.taggedName) && !saved.nameRestored;
		if (saved.restored && !nameOwed) {
			continue;
		}
		if (!saved.restored) {
			await writeVerifiedPrice(cloud, saved, saved.originalPrice);
			saved.restored = true;
			saveState(ctx.config.statePath, ctx.state);
			logLine(ctx.state, `  ${saved.name || saved.id}: restored ${saved.originalPrice}`);
		}
		if (nameOwed) {
			await writeVerifiedName(cloud, saved, saved.name);
			saved.nameRestored = true;
			saveState(ctx.config.statePath, ctx.state);
			logLine(ctx.state, `    name restored to "${saved.name}"`);
		}
		await sleep(PRICE_WRITE_GAP_MS);
	}
}

const REMINDER_DIR = "updateday-icons";

function writeReminder(ctx: RunContext, mark: string, image: Buffer): void {
	const folder = resolve(ctx.config.baseDir, REMINDER_DIR, String(ctx.config.universeId));
	mkdirSync(folder, { recursive: true });
	const file = resolve(folder, `${mark}.png`);
	writeFileSync(file, image);
	const what = mark === "final" ? (ctx.config.countdown?.newIcon ? "the new game icon" : "the original game icon") : `the ${mark.toUpperCase()} countdown icon`;
	const line = `REMINDER ${ctx.config.name}: upload ${what} in Creator Hub now: ${file}`;
	ctx.state.reminders = [...(ctx.state.reminders ?? []), line];
	logLine(ctx.state, line);
	const title = mark === "final" ? "Countdown over: upload the game icon" : `Upload the ${mark === "now" ? "NOW" : mark} countdown icon`;
	ctx.notify?.({ event: "reminders", title, text: `Upload ${what} in Creator Hub now. It's attached, and also saved at ${file}`, image });
}

async function uploadIcon(ctx: RunContext, mark: string): Promise<void> {
	if (!existsSync(ctx.config.snapshotPath)) {
		throw new Error(`Original icon snapshot missing at ${ctx.config.snapshotPath}`);
	}
	const countdown = ctx.config.countdown!;
	const base = readFileSync(ctx.config.snapshotPath);
	const image = await renderIcon(base, mark, countdown);
	if (countdown.iconMethod === "reminder") {
		writeReminder(ctx, mark, image);
		return;
	}
	if (mark === "final") {
		await finishSwap(requireCloud(ctx), ctx.state, ctx.config.statePath);
		if (countdown.newIcon) {
			writeReminder(ctx, mark, image);
		}
		return;
	}
	const cloud = requireCloud(ctx);
	await startSwap(cloud, ctx.state, ctx.config.statePath, countdown.swapLanguage);
	const pngBlob = (png: Buffer) => new Blob([new Uint8Array(png)], { type: "image/png" });
	await uploadAll(cloud, ctx.state, async (languageCode) => pngBlob(await renderIcon(base, mark, countdown, languageCode)));
}

export function titleTime(mark: string): string {
	return mark === "now" ? "LIVE" : mark.toUpperCase();
}

export function titleFor(format: string, name: string, time: string): string {
	const shell = format.replace(TIME_TOKEN, time);
	if (!shell.includes(NAME_TOKEN)) {
		return shell.trim().slice(0, MAX_TITLE_LENGTH);
	}
	const room = Math.max(0, MAX_TITLE_LENGTH - (shell.length - NAME_TOKEN.length));
	const fitted = name.length > room ? name.slice(0, room).trimEnd() : name;
	return shell.replace(NAME_TOKEN, fitted).trim();
}

async function writeTitle(cloud: OpenCloud, title: string): Promise<void> {
	const result = await cloud.setNameDescription(title);
	if (result.name !== title) {
		throw new Error(`wrote the title "${title}" but Roblox reports "${result.name}"`);
	}
}

async function applyTitle(ctx: RunContext, mark: string): Promise<void> {
	const cloud = requireCloud(ctx);
	const settings = ctx.config.title!;
	if (mark === "save") {
		if (!ctx.state.title) {
			const place = await cloud.getPlace(await cloud.rootPlaceId());
			ctx.state.title = { original: String(place?.displayName ?? ""), restored: false };
			saveState(ctx.config.statePath, ctx.state);
			logLine(ctx.state, `  saved the title "${ctx.state.title.original}"`);
		}
		return;
	}
	const saved = ctx.state.title;
	if (!saved?.original) {
		throw new Error("The game's title wasn't saved yet");
	}
	const format = mark === "final" ? settings.afterFormat : mark === "now" ? settings.nowFormat : settings.format;
	const next = titleFor(format, saved.original, titleTime(mark));
	await writeTitle(cloud, next);
	if (mark === "final") {
		saved.restored = true;
		saveState(ctx.config.statePath, ctx.state);
	}
	logLine(ctx.state, `  title is now "${next}"`);
}

export async function restoreTitle(ctx: RunContext): Promise<void> {
	const saved = ctx.state.title;
	if (!saved || saved.restored || !saved.original) {
		return;
	}
	await writeTitle(requireCloud(ctx), saved.original);
	saved.restored = true;
	saveState(ctx.config.statePath, ctx.state);
	logLine(ctx.state, `  title restored to "${saved.original}"`);
}

export async function endCountdown(ctx: RunContext): Promise<void> {
	await finishSwap(requireCloud(ctx), ctx.state, ctx.config.statePath);
	await restoreTitle(ctx);
}

async function createEvent(ctx: RunContext): Promise<void> {
	const event = ctx.config.event!;
	const updateAt = new Date(ctx.config.updateAt);
	const earliest = new Date(ctx.now.getTime() + EVENT_LEAD_MS);
	const start = updateAt > earliest ? updateAt : earliest;
	const end = new Date(start.getTime() + event.durationHours * 60 * 60 * 1000);
	const created = await requireCloud(ctx).createEvent({
		title: event.title,
		subtitle: event.subtitle,
		description: event.description,
		startTime: start.toISOString(),
		endTime: end.toISOString(),
		visibility: event.visibility,
	});
	ctx.state.eventId = String(created?.id ?? created?.eventId ?? "");
}

async function perform(step: Step, ctx: RunContext): Promise<void> {
	const action = step.action;
	const config = ctx.config;
	switch (action.type) {
		case "snapshotIcon":
			await snapshotIcon(config.universeId, config.snapshotPath);
			return;
		case "icon":
			await uploadIcon(ctx, action.mark);
			return;
		case "title":
			await applyTitle(ctx, action.mark);
			return;
		case "nameDescription":
			await requireCloud(ctx).setNameDescription(action.name, action.description);
			return;
		case "saleStart":
			await startSale(ctx);
			return;
		case "saleEnd":
			await restorePrices(ctx);
			return;
		case "event":
			await createEvent(ctx);
			return;
		case "broadcast":
			await requireCloud(ctx).publishMessage(config.broadcast!.topic, action.message);
			return;
		case "publish":
			await requireCloud(ctx).publishPlace(config.publish!.placeId, readBlob(config, config.publish!.file));
			return;
		case "restartServers":
			await requireCloud(ctx).restartServers(config.restartServers!.bleedOffMinutes);
			return;
	}
}

function skipReason(step: Step, due: Step[], ctx: RunContext): string | null {
	const lateMs = ctx.now.getTime() - step.at.getTime();
	if (step.action.type === "broadcast" && lateMs > BROADCAST_MAX_LATE_MS) {
		return "too late to warn players";
	}
	if (step.action.type === "icon") {
		const laterIcon = due.some((other) => other.action.type === "icon" && other.at > step.at);
		if (laterIcon) {
			return "superseded by a later icon";
		}
	}
	if (step.action.type === "title" && step.action.mark !== "save" && step.action.mark !== "final") {
		const laterTitle = due.some((other) => other.action.type === "title" && other.action.mark !== "save" && other.at > step.at);
		if (laterTitle) {
			return "superseded by a later title";
		}
	}
	return null;
}

export async function tick(steps: Step[], ctx: RunContext, dryRun: boolean): Promise<number> {
	const due = steps.filter((step) => step.at <= ctx.now && !ctx.state.done[step.id]);
	for (const step of due) {
		const reason = skipReason(step, due, ctx);
		if (reason) {
			logLine(ctx.state, `SKIP ${step.label}: ${reason}`);
			ctx.state.done[step.id] = `skipped: ${reason}`;
			continue;
		}
		if (dryRun) {
			console.log(`WOULD RUN ${step.label}`);
			continue;
		}
		logLine(ctx.state, `RUN  ${step.label}`);
		try {
			await perform(step, ctx);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logLine(ctx.state, `FAILED ${step.label}: ${message}`);
			saveState(ctx.config.statePath, ctx.state);
			await ctx.notify?.({ event: "failures", title: `Failed: ${step.label}`, text: `${message}

UpdateDay tries again on the next check.` });
			throw error;
		}
		ctx.state.done[step.id] = new Date().toISOString();
		saveState(ctx.config.statePath, ctx.state);
		await ctx.notify?.({ event: "steps", title: step.label, text: "Done." });
	}
	const remaining = steps.filter((step) => !ctx.state.done[step.id]).length;
	if (!dryRun) {
		await announceMilestones(ctx, remaining);
		saveState(ctx.config.statePath, ctx.state);
	}
	return remaining;
}

async function announceMilestones(ctx: RunContext, remaining: number): Promise<void> {
	const notified = ctx.state.notified ?? {};
	if (!notified.live && ctx.now >= new Date(ctx.config.updateAt)) {
		notified.live = ctx.now.toISOString();
		ctx.state.notified = notified;
		await ctx.notify?.({ event: "live", title: "The update is live", text: `Update time reached (${new Date(ctx.config.updateAt).toUTCString()}).` });
	}
	if (!notified.finished && remaining === 0) {
		notified.finished = ctx.now.toISOString();
		ctx.state.notified = notified;
		await ctx.notify?.({ event: "finished", title: "Update day finished", text: "Every step ran and everything that needed putting back was put back." });
	}
}
