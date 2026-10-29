import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import { nextOccurrence, type Config } from "./config.ts";
import { checkKey } from "./doctor.ts";
import { fetchCurrentIcon, ICON_SIZE, renderIcon } from "./icons.ts";
import { iconMarks } from "./bundle.ts";
import type { OpenCloud } from "./openCloud.ts";
import { moderationStatus } from "./moderation.ts";
import { titleFor } from "./runner.ts";
import { buildSchedule } from "./schedule.ts";

export type PreflightLevel = "ok" | "warn" | "bad" | "info";

export type PreflightCheck = {
	level: PreflightLevel;
	title: string;
	detail?: string;
};

export type PreflightReport = {
	game: string;
	universeId: number;
	ready: boolean;
	checks: PreflightCheck[];
};

const EVENT_LEAD_MS = 15 * 60 * 1000;

type Inputs = {
	config: Config;
	cloud: OpenCloud | null;
	webhook: string | undefined;
	now: Date;
};

function when(date: Date): string {
	return date.toUTCString().replace(" GMT", " UTC");
}

function timingChecks({ config, now }: Inputs): PreflightCheck[] {
	const checks: PreflightCheck[] = [];
	const updateAt = new Date(config.updateAt);
	if (updateAt <= now) {
		checks.push({ level: "warn", title: "The update time has passed", detail: `It was ${when(updateAt)}. Steps that are still due run right away.` });
	} else {
		checks.push({ level: "ok", title: `Update at ${when(updateAt)}` });
	}
	const steps = buildSchedule(config).filter((step) => step.at.getTime() > 0);
	const missed = steps.filter((step) => step.at <= now && step.action.type === "icon");
	if (missed.length > 1 && updateAt > now) {
		checks.push({ level: "info", title: "The countdown starts part-way", detail: `${missed.length - 1} earlier stage${missed.length === 2 ? " is" : "s are"} already past and will be skipped.` });
	}
	const next = nextOccurrence(config);
	if (config.repeat) {
		checks.push({ level: "info", title: `Repeats every ${config.repeat.every === "2weeks" ? "2 weeks" : config.repeat.every}`, detail: next ? `After this one: ${when(next)}` : "This is the last one." });
	}
	return checks;
}

function fileChecks({ config }: Inputs): PreflightCheck[] {
	const checks: PreflightCheck[] = [];
	const files: [string | undefined, string][] = [
		[config.countdown?.newIcon, "The new game icon"],
		[config.publish ? resolve(config.baseDir, config.publish.file) : undefined, "The place file to publish"],
	];
	for (const [path, what] of files) {
		if (path && !existsSync(path)) {
			checks.push({ level: "bad", title: `${what} is missing`, detail: path });
		}
	}
	const artDir = config.countdown?.overlayDir;
	if (artDir && !existsSync(artDir)) {
		checks.push({ level: "warn", title: "No hourglass art uploaded yet", detail: "The built-in hourglass is used until you add your own." });
	}
	return checks;
}

async function baseIcon(config: Config): Promise<Buffer> {
	if (existsSync(config.snapshotPath)) {
		return readFileSync(config.snapshotPath);
	}
	return sharp(await fetchCurrentIcon(config.universeId)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();
}

async function iconChecks({ config }: Inputs): Promise<PreflightCheck[]> {
	const countdown = config.countdown;
	if (!countdown) {
		return [];
	}
	let base: Buffer;
	try {
		base = await baseIcon(config);
	} catch (error) {
		return [{ level: "bad", title: "Couldn't read the game icon", detail: error instanceof Error ? error.message : String(error) }];
	}
	const marks = iconMarks(countdown);
	const broken: string[] = [];
	for (const mark of marks) {
		try {
			await renderIcon(base, mark, countdown);
		} catch (error) {
			broken.push(`${mark}: ${error instanceof Error ? error.message : error}`);
		}
	}
	if (broken.length) {
		return [{ level: "bad", title: `${broken.length} countdown icon${broken.length === 1 ? "" : "s"} won't render`, detail: broken.join("; ") }];
	}
	const how = countdown.iconMethod === "languageSwap" ? "uploaded automatically" : "made for you to upload";
	return [{ level: "ok", title: `${marks.length} countdown icons render`, detail: `They'll be ${how}.` }];
}

async function keyChecks({ config, cloud }: Inputs): Promise<PreflightCheck[]> {
	if (!cloud) {
		return [{ level: "bad", title: "No API key", detail: `Paste one in UpdateDay or set ${config.apiKeyEnv}.` }];
	}
	const probes = await checkKey(cloud, config);
	const blocking = probes.filter((probe) => probe.used && (probe.status === "missing" || probe.status === "error"));
	if (blocking.length) {
		return [{ level: "bad", title: `The API key is missing ${blocking.length} permission${blocking.length === 1 ? "" : "s"}`, detail: blocking.map((probe) => `${probe.feature} (${probe.permission})`).join(", ") }];
	}
	return [{ level: "ok", title: "The API key has every permission the plan needs" }];
}

async function saleChecks({ config, cloud, now }: Inputs): Promise<PreflightCheck[]> {
	const sale = config.sale;
	if (!sale) {
		return [];
	}
	const checks: PreflightCheck[] = [];
	const endsAt = sale.endsAt ? Date.parse(sale.endsAt) : (sale.startsAt ? Date.parse(sale.startsAt) : Date.parse(config.updateAt)) + sale.durationHours * 36e5;
	if (endsAt <= now.getTime()) {
		checks.push({ level: "warn", title: "The sale's end time has already passed", detail: "It would start and end straight away." });
	}
	if (!cloud) {
		return checks;
	}
	try {
		const items = [...(await cloud.listItems("gamePass")), ...(await cloud.listItems("developerProduct"))];
		const picked = (kind: "gamePass" | "developerProduct", setting: "all" | number[]) => {
			const sellable = items.filter((item) => item.kind === kind && item.isForSale && item.price !== null);
			if (setting === "all") {
				return { count: sellable.length, missing: [] as number[] };
			}
			const ids = new Set(sellable.map((item) => item.id));
			return { count: setting.filter((id) => ids.has(id)).length, missing: setting.filter((id) => !ids.has(id)) };
		};
		const passes = picked("gamePass", sale.gamePasses);
		const products = picked("developerProduct", sale.developerProducts);
		const total = passes.count + products.count;
		const missing = [...passes.missing, ...products.missing];
		if (total === 0) {
			checks.push({ level: "warn", title: "Nothing would go on sale", detail: "No picked pass or product is for sale right now." });
		} else {
			checks.push({ level: "ok", title: `${total} item${total === 1 ? "" : "s"} go on sale at ${sale.percentOff}% off` });
		}
		if (missing.length) {
			checks.push({ level: "warn", title: `${missing.length} picked item${missing.length === 1 ? " isn't" : "s aren't"} for sale any more`, detail: `They'll be skipped: ${missing.join(", ")}` });
		}
	} catch (error) {
		checks.push({ level: "warn", title: "Couldn't list the passes and products", detail: error instanceof Error ? error.message : String(error) });
	}
	return checks;
}

function eventChecks({ config, now }: Inputs): PreflightCheck[] {
	if (!config.event) {
		return [];
	}
	if (Date.parse(config.updateAt) - now.getTime() < EVENT_LEAD_MS) {
		return [{ level: "warn", title: "The event will start a little late", detail: "Roblox events need 15 minutes' notice, so it starts about 20 minutes from now." }];
	}
	return [{ level: "ok", title: `Event "${config.event.title}" will be created` }];
}

function titleChecks({ config }: Inputs): PreflightCheck[] {
	if (!config.title) {
		return [];
	}
	const example = titleFor(config.title.format, config.name, "6H");
	return [{ level: "info", title: "Title countdown is on", detail: `For example "${example}", then "${titleFor(config.title.nowFormat, config.name, "LIVE")}". The real title is saved first and put back.` }];
}

async function moderationChecks({ config, cloud }: Inputs): Promise<PreflightCheck[]> {
	if (!config.countdown || !cloud) {
		return [];
	}
	try {
		const stages = await moderationStatus(config, cloud, await baseIcon(config));
		const rejected = stages.filter((stage) => stage.state === "Rejected").map((stage) => stage.mark);
		const reviewing = stages.filter((stage) => stage.state === "Reviewing").length;
		const unchecked = stages.filter((stage) => stage.state === "unchecked").length;
		if (rejected.length) {
			return [{ level: "bad", title: `Roblox moderation rejected ${rejected.length} icon${rejected.length === 1 ? "" : "s"}`, detail: `Change the look of: ${rejected.join(", ")}` }];
		}
		if (unchecked === stages.length) {
			return [{ level: "info", title: "Icons not checked with Roblox moderation yet", detail: "Optional: Countdown → Stages → Check with moderation." }];
		}
		if (reviewing || unchecked) {
			return [{ level: "info", title: "Moderation check in progress", detail: `${reviewing} in review, ${unchecked} not checked since the last change.` }];
		}
		return [{ level: "ok", title: `Roblox moderation approved all ${stages.length} icons` }];
	} catch (error) {
		return [{ level: "warn", title: "Couldn't read the moderation status", detail: error instanceof Error ? error.message : String(error) }];
	}
}

function notifyChecks({ config, webhook }: Inputs): PreflightCheck[] {
	if (!config.notify) {
		return [];
	}
	if (!webhook) {
		return [{ level: "warn", title: "Discord alerts are on, but there's no webhook", detail: `Paste one in UpdateDay or set ${config.notify.discordWebhookEnv}.` }];
	}
	return [{ level: "ok", title: "Discord alerts are ready" }];
}

export async function preflight(config: Config, cloud: OpenCloud | null, webhook: string | undefined, now = new Date()): Promise<PreflightReport> {
	const inputs = { config, cloud, webhook, now };
	const checks = [
		...timingChecks(inputs),
		...(await keyChecks(inputs)),
		...fileChecks(inputs),
		...(await iconChecks(inputs)),
		...(await saleChecks(inputs)),
		...eventChecks(inputs),
		...titleChecks(inputs),
		...(await moderationChecks(inputs)),
		...notifyChecks(inputs),
	];
	return { game: config.name, universeId: config.universeId, ready: !checks.some((check) => check.level === "bad"), checks };
}
