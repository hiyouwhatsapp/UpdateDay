import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HOURGLASS_STYLES, type OverlayAnchor } from "./icons.ts";

export type NewIconTiming = "now" | "end";

export type IconMethod = "languageSwap" | "reminder";

export type CountdownConfig = {
	marks: string[];
	overlayDir?: string;
	customDir?: string;
	skip: string[];
	newIcon?: string;
	newIconAt: NewIconTiming;
	iconMethod: IconMethod;
	uploadLeadSeconds: number;
	swapLanguage?: string;
	localizeLabels: boolean;
	style: string;
	hourglassSize: number;
	hourglassY: number;
	textSize: number;
	textY: number;
	labels?: Record<string, string>;
	anchor: OverlayAnchor;
	scale: number;
	dim: number;
	label: boolean;
	labelColor: string;
	labelOutline: string;
};

export type SaleConfig = {
	percentOff: number;
	durationHours: number;
	startsAt?: string;
	endsAt?: string;
	gamePasses: "all" | number[];
	developerProducts: "all" | number[];
	nameTag?: string;
	nameTagPosition?: "prefix" | "suffix";
};

export type NameChange = {
	at: string;
	name?: string;
	description?: string;
};

export type EventConfig = {
	title: string;
	subtitle: string;
	description?: string;
	durationHours: number;
	visibility: "Public" | "Private";
};

export type BroadcastConfig = {
	topic: string;
	marks: string[];
};

export type PlayerDataConfig = {
	dataStore: string;
	keyFormat: string;
};

export type GiftCategory = {
	items: string[];
	tiers?: string[];
};

export type GiftsConfig = {
	dataStore?: string;
	catalog: Record<string, GiftCategory>;
};

export type TitleConfig = {
	format: string;
	nowFormat: string;
	afterFormat: string;
	marks?: string[];
};

export type RepeatEvery = "day" | "week" | "2weeks" | "month";

export type RepeatConfig = {
	every: RepeatEvery;
	until?: string;
};

export type NotifyEvent = "reminders" | "failures" | "live" | "finished" | "steps";

export type NotifyConfig = {
	discordWebhookEnv: string;
	events: NotifyEvent[];
	mention?: string;
};

export type PublishConfig = {
	placeId: number;
	file: string;
};

export type Config = {
	name: string;
	universeId: number;
	apiKeyEnv: string;
	languageCode: string;
	updateAt: string;
	adminAbuseMinutes: number;
	countdown?: CountdownConfig;
	sale?: SaleConfig;
	nameChanges?: NameChange[];
	event?: EventConfig;
	broadcast?: BroadcastConfig;
	publish?: PublishConfig;
	restartServers?: { bleedOffMinutes: number };
	playerData?: PlayerDataConfig;
	gifts?: GiftsConfig;
	repeat?: RepeatConfig;
	title?: TitleConfig;
	repeatIndex: number;
	baseUpdateAt: string;
	notify?: NotifyConfig;
	statePath: string;
	snapshotPath: string;
	baseDir: string;
};

const DEFAULT_LANGUAGE = "en";
const DEFAULT_API_KEY_ENV = "UPDATEDAY_API_KEY";
const DEFAULT_ADMIN_ABUSE_MINUTES = 60;
const STATE_PREFIX = "updateday";
const STATE_SUFFIX = ".state.json";
const MERGED_SECTIONS = ["countdown", "sale", "event", "broadcast", "restartServers", "title"];
const DEFAULT_TITLE: TitleConfig = { format: "[{time}] {name}", nowFormat: "[LIVE] {name}", afterFormat: "{name}" };
const NAME_TOKEN = "{name}";
const SNAPSHOT_SUFFIX = ".original-icon.png";
const NOW_MARK = "now";
const NEW_ICON_TIMINGS: NewIconTiming[] = ["now", "end"];
const REPEAT_PERIODS_MS: Record<string, number> = { day: 864e5, week: 7 * 864e5, "2weeks": 14 * 864e5 };
const REPEAT_GRACE_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_MONTH_STEPS = 1200;
export const DEFAULT_WEBHOOK_ENV = "UPDATEDAY_DISCORD_WEBHOOK";
export const DEFAULT_NOTIFY_EVENTS: NotifyEvent[] = ["reminders", "failures", "live", "finished"];
const NOTIFY_EVENTS: NotifyEvent[] = ["reminders", "failures", "live", "finished", "steps"];

export const DEFAULT_MARKS = ["24h", "12h", "6h", "5h", "4h", "3h", "2h", "1h", "45m", "30m", "15m", "10m", "5m"];

const DEFAULT_COUNTDOWN: CountdownConfig = {
	marks: DEFAULT_MARKS,
	skip: [],
	newIconAt: "end",
	iconMethod: "reminder",
	uploadLeadSeconds: 90,
	localizeLabels: true,
	style: "original",
	hourglassSize: 0.66,
	hourglassY: 0.4,
	textSize: 0.15,
	textY: 0.85,
	anchor: "center",
	scale: 0.88,
	dim: 0.45,
	label: true,
	labelColor: "#ffffff",
	labelOutline: "#000000",
};

function countdownConfig(raw: any, baseDir: string): CountdownConfig | undefined {
	if (raw === false) {
		return undefined;
	}
	const merged = { ...DEFAULT_COUNTDOWN, ...(raw ?? {}) };
	const resolvePath = (path?: string) => (path ? resolve(baseDir, path) : undefined);
	const known = new Set([...merged.marks, NOW_MARK]);
	const unknown = merged.skip.filter((mark: string) => !known.has(mark));
	if (unknown.length > 0) {
		fail(`countdown.skip has stages that aren't in the countdown: ${unknown.join(", ")}`);
	}
	if (!["languageSwap", "reminder"].includes(merged.iconMethod)) {
		fail(`countdown.iconMethod must be "languageSwap" or "reminder"`);
	}
	if (!HOURGLASS_STYLES.includes(merged.style)) {
		fail(`countdown.style must be one of ${HOURGLASS_STYLES.join(", ")}`);
	}
	if (!NEW_ICON_TIMINGS.includes(merged.newIconAt)) {
		fail(`countdown.newIconAt must be "now" or "end"`);
	}
	return {
		...merged,
		overlayDir: resolvePath(merged.overlayDir),
		customDir: resolvePath(merged.customDir),
		newIcon: resolvePath(merged.newIcon ?? merged.finalIcon),
	};
}

export function activeMarks(countdown: CountdownConfig): string[] {
	return countdown.marks.filter((mark) => !countdown.skip.includes(mark));
}

export function showsNow(countdown: CountdownConfig): boolean {
	return !countdown.skip.includes(NOW_MARK);
}

export function occurrence(base: Date, every: RepeatEvery, index: number): Date {
	if (every === "month") {
		const date = new Date(base);
		date.setUTCMonth(date.getUTCMonth() + index);
		return date;
	}
	return new Date(base.getTime() + index * REPEAT_PERIODS_MS[every]);
}

function occurrenceTailMs(raw: any): number {
	let tail = (raw.adminAbuseMinutes ?? DEFAULT_ADMIN_ABUSE_MINUTES) * MINUTE_MS;
	const base = Date.parse(raw.updateAt);
	if (raw.sale) {
		const start = raw.sale.startsAt ? Date.parse(raw.sale.startsAt) : base;
		const end = raw.sale.endsAt ? Date.parse(raw.sale.endsAt) : start + (raw.sale.durationHours ?? 48) * HOUR_MS;
		tail = Math.max(tail, end - base);
	}
	if (raw.event) {
		tail = Math.max(tail, (raw.event.durationHours ?? 2) * HOUR_MS);
	}
	return tail + REPEAT_GRACE_MS;
}

function repeatIndexFor(raw: any, now: Date): number {
	const every: RepeatEvery = raw.repeat.every;
	const base = new Date(raw.updateAt);
	const tail = occurrenceTailMs(raw);
	let index = 0;
	if (every === "month") {
		while (index < MAX_MONTH_STEPS && occurrence(base, every, index).getTime() + tail < now.getTime()) {
			index++;
		}
	} else {
		index = Math.max(0, Math.ceil((now.getTime() - tail - base.getTime()) / REPEAT_PERIODS_MS[every]));
	}
	const until = raw.repeat.until ? Date.parse(raw.repeat.until) : NaN;
	while (index > 0 && !Number.isNaN(until) && occurrence(base, every, index).getTime() > until) {
		index--;
	}
	return index;
}

function shiftIso(value: string | undefined, deltaMs: number): string | undefined {
	return value ? new Date(Date.parse(value) + deltaMs).toISOString() : value;
}

function applyRepeat(raw: any, now: Date): { raw: any; index: number } {
	if (!raw.repeat) {
		return { raw, index: 0 };
	}
	if (!["day", "week", "2weeks", "month"].includes(raw.repeat.every)) {
		fail(`repeat.every must be "day", "week", "2weeks" or "month"`);
	}
	const index = repeatIndexFor(raw, now);
	if (index === 0) {
		return { raw, index };
	}
	const updateAt = occurrence(new Date(raw.updateAt), raw.repeat.every, index);
	const delta = updateAt.getTime() - Date.parse(raw.updateAt);
	const sale = raw.sale ? { ...raw.sale, startsAt: shiftIso(raw.sale.startsAt, delta), endsAt: shiftIso(raw.sale.endsAt, delta) } : raw.sale;
	return { raw: { ...raw, updateAt: updateAt.toISOString(), sale }, index };
}

function titleConfig(raw: any, label: string): TitleConfig | undefined {
	if (!raw) {
		return undefined;
	}
	const merged: TitleConfig = { ...DEFAULT_TITLE, ...raw };
	for (const key of ["format", "nowFormat"] as const) {
		if (!merged[key].includes(NAME_TOKEN)) {
			fail(`${label}: title.${key} must include {name}`);
		}
	}
	return merged;
}

function notifyConfig(raw: any): NotifyConfig | undefined {
	if (!raw) {
		return undefined;
	}
	const events: NotifyEvent[] = (raw.events ?? DEFAULT_NOTIFY_EVENTS).filter((event: NotifyEvent) => NOTIFY_EVENTS.includes(event));
	return { discordWebhookEnv: raw.discordWebhookEnv || DEFAULT_WEBHOOK_ENV, events, mention: raw.mention || undefined };
}

function fail(message: string): never {
	throw new Error(`Config: ${message}`);
}

function mergeSection(shared: any, own: any): any {
	if (own === false || own === null) {
		return false;
	}
	if (own === undefined) {
		return shared;
	}
	if (shared && typeof shared === "object" && typeof own === "object" && !Array.isArray(own)) {
		return { ...shared, ...own };
	}
	return own;
}

function mergeGame(shared: any, game: any): any {
	const merged = { ...shared, ...game };
	for (const section of MERGED_SECTIONS) {
		merged[section] = mergeSection(shared[section], game[section]);
	}
	return merged;
}

function enabledSections(raw: any): Record<string, unknown> {
	const sections: Record<string, unknown> = {};
	for (const section of MERGED_SECTIONS) {
		sections[section] = raw[section] === false ? undefined : raw[section];
	}
	return sections;
}

function statePathFor(raw: any, baseDir: string, multi: boolean): string {
	if (raw.statePath) {
		return resolve(baseDir, raw.statePath);
	}
	const fileName = multi ? `${STATE_PREFIX}.${raw.universeId}${STATE_SUFFIX}` : STATE_PREFIX + STATE_SUFFIX;
	return resolve(baseDir, fileName);
}

function buildConfig(original: any, baseDir: string, multi: boolean, now: Date): Config {
	const label = original.name ?? original.universeId ?? "game";
	if (Number.isNaN(Date.parse(original.updateAt ?? ""))) {
		fail(`${label}: updateAt must be an ISO date with a timezone, e.g. 2026-11-01T17:00:00Z`);
	}
	const { raw, index } = applyRepeat(original, now);
	return buildOccurrence(raw, baseDir, multi, index, original.updateAt);
}

function buildOccurrence(raw: any, baseDir: string, multi: boolean, repeatIndex: number, baseUpdateAt: string): Config {
	const label = raw.name ?? raw.universeId ?? "game";
	if (!Number.isInteger(raw.universeId)) {
		fail(`${label}: universeId must be a number`);
	}
	if (Number.isNaN(Date.parse(raw.updateAt ?? ""))) {
		fail(`${label}: updateAt must be an ISO date with a timezone, e.g. 2026-11-01T17:00:00Z`);
	}
	if (raw.sale && !(raw.sale.percentOff > 0 && raw.sale.percentOff < 100)) {
		fail(`${label}: sale.percentOff must be between 1 and 99`);
	}
	if (raw.sale?.startsAt && raw.sale?.endsAt && Date.parse(raw.sale.endsAt) <= Date.parse(raw.sale.startsAt)) {
		fail(`${label}: the sale has to end after it starts`);
	}
	const statePath = statePathFor(raw, baseDir, multi);
	return {
		...raw,
		...enabledSections(raw),
		name: String(raw.name ?? raw.universeId),
		apiKeyEnv: raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		languageCode: raw.languageCode ?? DEFAULT_LANGUAGE,
		adminAbuseMinutes: raw.adminAbuseMinutes ?? DEFAULT_ADMIN_ABUSE_MINUTES,
		countdown: countdownConfig(raw.countdown, baseDir),
		notify: notifyConfig(raw.notify),
		title: titleConfig(raw.title, label),
		repeatIndex,
		baseUpdateAt,
		statePath,
		snapshotPath: statePath.replace(/\.json$/, "") + SNAPSHOT_SUFFIX,
		baseDir,
	};
}

export function parseConfigs(raw: any, baseDir: string, now = new Date()): Config[] {
	if (!Array.isArray(raw.games)) {
		return [buildConfig(raw, baseDir, false, now)];
	}
	const { games, ...shared } = raw;
	const configs = games.map((game: any) => buildConfig(mergeGame(shared, game), baseDir, true, now));
	const ids = configs.map((config: Config) => config.universeId);
	if (new Set(ids).size !== ids.length) {
		fail("the same universeId is listed twice in games");
	}
	return configs;
}

export function flattenSingleGame(raw: any): any {
	if (!Array.isArray(raw.games) || raw.games.length !== 1) {
		return raw;
	}
	const { games, ...shared } = raw;
	return mergeGame(shared, games[0]);
}

export function nextOccurrence(config: Config): Date | null {
	if (!config.repeat) {
		return null;
	}
	const next = occurrence(new Date(config.baseUpdateAt), config.repeat.every, config.repeatIndex + 1);
	const until = config.repeat.until ? Date.parse(config.repeat.until) : NaN;
	return !Number.isNaN(until) && next.getTime() > until ? null : next;
}

export function loadConfigs(path: string, now = new Date()): Config[] {
	const fullPath = resolve(path);
	const raw = JSON.parse(readFileSync(fullPath, "utf8"));
	return parseConfigs(raw, dirname(fullPath), now);
}
