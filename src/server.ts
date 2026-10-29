import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { activeMarks, flattenSingleGame, nextOccurrence, parseConfigs, showsNow, type Config } from "./config.ts";
import { iconZip, kitZip } from "./bundle.ts";
import { readHistory, recording } from "./history.ts";
import { discordNotifier, isWebhookUrl, postDiscord } from "./notify.ts";
import { moderationStatus, submitForModeration } from "./moderation.ts";
import { preflight } from "./preflight.ts";
import { fetchCurrentIcon, HOURGLASS_STYLES, ICON_SIZE, renderIcon, stylePath } from "./icons.ts";
import { checkKey } from "./doctor.ts";
import { pageReport } from "./gamePage.ts";
import { cancelGift, DEFAULT_GIFT_STORE, pendingGifts, sendGift } from "./gifts.ts";
import { entryKey, listBackups, listDataStores, lookupPlayer, readBackup, readEntry, saveEntry } from "./playerData.ts";
import { OpenCloud } from "./openCloud.ts";
import { endCountdown, restorePrices, tick, type RunContext } from "./runner.ts";
import { buildSchedule, type Step } from "./schedule.ts";
import { loadState, saveState } from "./state.ts";

const HOST = "127.0.0.1";
const UI_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../ui/index.html");
const UPLOAD_DIR = "updateday-images";
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const ICON_CACHE_MS = 10 * 60 * 1000;
const WATCH_INTERVAL_MS = 30 * 1000;
const LOG_LIMIT = 500;
const RENDER_CACHE_LIMIT = 300;
const ITEM_CACHE_MS = 60 * 1000;
const ASSET_THUMBS_URL = "https://thumbnails.roblox.com/v1/assets";
const ART_DIR = "updateday-art";
const ART_MARK = /^(\d+[smhd]|now|default)$/;
const ZIP_TYPE = "application/zip";

type RunMode = "idle" | "watching" | "experimenting";

type Server = {
	configPath: string;
	baseDir: string;
	port: number;
	draft: any;
	draftConfigs: (Config | null)[];
	draftError: string | null;
	revision: number;
	iconCache: Map<number, { at: number; image: Buffer }>;
	renderCache: Map<string, Buffer>;
	itemCache: Map<number, { at: number; items: object[] }>;
	mode: RunMode;
	stopRequested: boolean;
	log: string[];
	sessionKeys: Record<string, string>;
};

function emptyDraft(): any {
	return { updateAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), games: [] };
}

function toMulti(raw: any): any {
	if (Array.isArray(raw.games)) {
		return raw;
	}
	const { universeId, name, apiKeyEnv, ...shared } = raw;
	const game: Record<string, unknown> = { universeId };
	if (name !== undefined) {
		game.name = name;
	}
	if (apiKeyEnv !== undefined) {
		game.apiKeyEnv = apiKeyEnv;
	}
	return { ...shared, games: universeId === undefined ? [] : [game] };
}

function readDraft(configPath: string): any {
	if (!existsSync(configPath)) {
		return emptyDraft();
	}
	return toMulti(JSON.parse(readFileSync(configPath, "utf8")));
}

function applyDraft(server: Server, draft: any): void {
	server.draft = draft;
	server.revision++;
	try {
		const games: any[] = draft.games ?? [];
		const complete = games.filter(isComplete);
		const asSaved = flattenSingleGame({ ...draft, games: complete });
		const parsed = complete.length ? parseConfigs(asSaved, server.baseDir) : [];
		server.draftConfigs = games.map((game) => (isComplete(game) ? parsed[complete.indexOf(game)] : null));
		server.draftError = null;
	} catch (error) {
		server.draftConfigs = [];
		server.draftError = error instanceof Error ? error.message : String(error);
	}
}

function isComplete(game: any): boolean {
	return Number.isInteger(game?.universeId);
}

function incompleteGameError(draft: any): string | null {
	const games: any[] = draft.games ?? [];
	if (games.length === 0) {
		return "Add at least one game";
	}
	const index = games.findIndex((game) => !isComplete(game));
	return index >= 0 ? `${games[index].name || `Game ${index + 1}`} needs a universe ID` : null;
}

function pushLog(server: Server, line: string): void {
	server.log.push(line);
	if (server.log.length > LOG_LIMIT) {
		server.log.splice(0, server.log.length - LOG_LIMIT);
	}
}

function captureConsole(server: Server): void {
	const original = { log: console.log, error: console.error };
	console.log = (...args: unknown[]) => {
		pushLog(server, args.join(" "));
		original.log(...args);
	};
	console.error = (...args: unknown[]) => {
		pushLog(server, `ERROR ${args.join(" ")}`);
		original.error(...args);
	};
}

function apiKeyFor(server: Server, config: Config): string | undefined {
	return server.sessionKeys[config.apiKeyEnv] ?? process.env[config.apiKeyEnv];
}

function webhookFor(server: Server, config: Config): string | undefined {
	if (!config.notify) {
		return undefined;
	}
	return server.sessionKeys[config.notify.discordWebhookEnv] ?? process.env[config.notify.discordWebhookEnv];
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
	const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
	res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Upload too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolveBody(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function isLocalRequest(req: IncomingMessage, port: number): boolean {
	const allowed = [`${HOST}:${port}`, `localhost:${port}`];
	if (!allowed.includes(req.headers.host ?? "")) {
		return false;
	}
	const origin = req.headers.origin;
	return !origin || allowed.some((host) => origin === `http://${host}`);
}

async function baseIcon(server: Server, config: Config): Promise<Buffer> {
	if (existsSync(config.snapshotPath)) {
		return readFileSync(config.snapshotPath);
	}
	const cached = server.iconCache.get(config.universeId);
	if (cached && Date.now() - cached.at < ICON_CACHE_MS) {
		return cached.image;
	}
	const image = await sharp(await fetchCurrentIcon(config.universeId)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();
	server.iconCache.set(config.universeId, { at: Date.now(), image });
	return image;
}

function describeStep(step: Step, state: RunContext["state"]): object {
	const mark = step.action.type === "icon" ? step.action.mark : null;
	return {
		id: step.id,
		at: step.at.getTime() === 0 ? null : step.at.toISOString(),
		label: step.label,
		type: step.action.type,
		mark,
		done: state.done[step.id] ?? null,
	};
}

function scheduleView(server: Server): (object | null)[] {
	return server.draftConfigs.map((config) => {
		if (!config) {
			return null;
		}
		const state = loadState(config.statePath, config.updateAt);
		const steps = buildSchedule(config).map((step) => describeStep(step, state));
		return {
			name: config.name,
			universeId: config.universeId,
			updateAt: config.updateAt,
			apiKeyEnv: config.apiKeyEnv,
			hasKey: Boolean(apiKeyFor(server, config)),
			repeat: config.repeat ?? null,
			nextUpdateAt: nextOccurrence(config)?.toISOString() ?? null,
			webhookEnv: config.notify?.discordWebhookEnv ?? null,
			hasWebhook: Boolean(webhookFor(server, config)),
			marks: config.countdown ? activeMarks(config.countdown) : [],
			showsNow: config.countdown ? showsNow(config.countdown) : false,
			prices: state.prices,
			reminders: (state.reminders ?? []).map((text) => {
				const file = text.slice(text.lastIndexOf(": ") + 2);
				return { text: text.slice(0, text.lastIndexOf(": ")), file: relative(server.baseDir, file).replace(/\\/g, "/") };
			}),
			swap: state.swap ?? null,
			steps,
		};
	});
}

async function handleIcon(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const config = server.draftConfigs[Number(url.searchParams.get("game"))];
	const mark = url.searchParams.get("mark") ?? "now";
	if (!config?.countdown) {
		send(res, 404, { error: "No countdown for that game" });
		return;
	}
	const base = await baseIcon(server, config);
	if (url.searchParams.get("raw")) {
		send(res, 200, base, "image/png");
		return;
	}
	const key = `${config.universeId}|${mark}|${base.length}|${JSON.stringify(config.countdown)}`;
	let image = server.renderCache.get(key);
	if (!image) {
		image = await renderIcon(base, mark, config.countdown);
		if (server.renderCache.size >= RENDER_CACHE_LIMIT) {
			server.renderCache.clear();
		}
		server.renderCache.set(key, image);
	}
	send(res, 200, image, "image/png");
}

async function handleUpload(server: Server, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const universeId = Number(url.searchParams.get("universeId")) || "game";
	const body = await readBody(req);
	const png = await sharp(body).resize(ICON_SIZE, ICON_SIZE, { fit: "cover" }).png().toBuffer();
	const folder = join(server.baseDir, UPLOAD_DIR);
	mkdirSync(folder, { recursive: true });
	const fileName = `${universeId}-new-icon-${Date.now()}.png`;
	writeFileSync(join(folder, fileName), png);
	send(res, 200, { path: relative(server.baseDir, join(folder, fileName)).replace(/\\/g, "/") });
}

function handleFile(server: Server, url: URL, res: ServerResponse): void {
	const path = resolve(server.baseDir, url.searchParams.get("path") ?? "");
	const inside = relative(server.baseDir, path);
	if (!inside || inside.startsWith("..") || isAbsolute(inside) || !/\.(png|jpe?g|webp)$/i.test(path) || !existsSync(path)) {
		send(res, 404, { error: "Not found" });
		return;
	}
	send(res, 200, readFileSync(path), "image/png");
}

function isPlaceholderName(name: string | null): boolean {
	return !name || /^\[.*\]$/.test(name.trim());
}

async function lookupGame(query: string): Promise<{ universeId: number; name: string | null }> {
	const placeMatch = /games\/(\d+)/.exec(query) ?? /^(\d+)$/.exec(query.trim());
	if (!placeMatch) {
		throw new Error("Paste a roblox.com/games/... link or a place ID");
	}
	const universe = await fetch(`https://apis.roblox.com/universes/v1/places/${placeMatch[1]}/universe`);
	const universeId = (await universe.json()).universeId;
	if (!Number.isInteger(universeId)) {
		throw new Error("No game found for that place");
	}
	const details = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
	const name = details.ok ? (await details.json()).data?.[0]?.name ?? null : null;
	return { universeId, name: isPlaceholderName(name) ? null : name };
}

async function iconUrls(assetIds: number[]): Promise<Map<number, string>> {
	const urls = new Map<number, string>();
	for (let i = 0; i < assetIds.length; i += 100) {
		const batch = assetIds.slice(i, i + 100);
		const response = await fetch(`${ASSET_THUMBS_URL}?assetIds=${batch.join(",")}&size=150x150&format=Png`);
		if (!response.ok) {
			continue;
		}
		for (const entry of (await response.json()).data ?? []) {
			if (entry.imageUrl) {
				urls.set(entry.targetId, entry.imageUrl);
			}
		}
	}
	return urls;
}

async function handleItems(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const config = server.draftConfigs[Number(url.searchParams.get("game"))];
	if (!config) {
		send(res, 404, { error: "Pick a game with a universe ID first" });
		return;
	}
	const apiKey = apiKeyFor(server, config);
	if (!apiKey) {
		send(res, 400, { error: `Add the API key (${config.apiKeyEnv}) to load this game's passes and products` });
		return;
	}
	const cached = server.itemCache.get(config.universeId);
	if (cached && Date.now() - cached.at < ITEM_CACHE_MS && !url.searchParams.get("refresh")) {
		send(res, 200, { items: cached.items });
		return;
	}
	const cloud = new OpenCloud(apiKey, config.universeId);
	const items = [...(await cloud.listItems("gamePass")), ...(await cloud.listItems("developerProduct"))];
	const icons = await iconUrls(items.flatMap((item) => (item.iconAssetId ? [item.iconAssetId] : [])));
	const view = items.map((item) => ({ ...item, iconUrl: item.iconAssetId ? icons.get(item.iconAssetId) ?? null : null }));
	server.itemCache.set(config.universeId, { at: Date.now(), items: view });
	send(res, 200, { items: view });
}

function gameCloud(server: Server, url: URL): { config: Config; cloud: OpenCloud | null } | null {
	const config = server.draftConfigs[Number(url.searchParams.get("game"))];
	if (!config) {
		return null;
	}
	const apiKey = apiKeyFor(server, config);
	return { config, cloud: apiKey ? new OpenCloud(apiKey, config.universeId) : null };
}

async function handlePage(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const target = gameCloud(server, url);
	if (!target) {
		send(res, 404, { error: "Pick a game with a universe ID first" });
		return;
	}
	send(res, 200, await pageReport(target.config, target.cloud));
}

const EVENT_FIELDS = ["title", "subtitle", "description", "startTime", "endTime", "visibility", "categories", "thumbnails", "tagline"];

function eventBody(raw: any): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const field of EVENT_FIELDS) {
		if (raw[field] !== undefined) {
			body[field] = raw[field];
		}
	}
	return body;
}

async function handleEvents(server: Server, method: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const target = gameCloud(server, url);
	if (!target?.cloud) {
		send(res, 400, { error: target ? `Add the API key (${target.config.apiKeyEnv}) to manage events` : "Pick a game first" });
		return;
	}
	const { cloud, config } = target;
	const id = url.searchParams.get("id");
	if (method === "GET") {
		const json = await cloud.request("GET", `/virtual-events/v3/universes/${config.universeId}/game-events`, "list events");
		send(res, 200, { events: json?.gameEvents ?? [] });
		return;
	}
	if (method === "DELETE" && id) {
		await cloud.request("DELETE", `/virtual-events/v3/game-events/${encodeURIComponent(id)}`, "delete event");
		send(res, 200, { ok: true });
		return;
	}
	const body = eventBody(JSON.parse((await readBody(req)).toString("utf8")));
	if (method === "PATCH" && id) {
		send(res, 200, await cloud.json("PATCH", `/virtual-events/v3/game-events/${encodeURIComponent(id)}`, "update event", body));
		return;
	}
	if (method === "POST") {
		send(res, 200, await cloud.json("POST", `/virtual-events/v3/universes/${config.universeId}/game-events`, "create event", body));
		return;
	}
	send(res, 400, { error: "Unsupported event request" });
}

async function jsonBody(req: IncomingMessage): Promise<any> {
	const text = (await readBody(req)).toString("utf8");
	return text ? JSON.parse(text) : {};
}

function needCloud(server: Server, url: URL, res: ServerResponse, what: string): { config: Config; cloud: OpenCloud } | null {
	const target = gameCloud(server, url);
	if (!target?.cloud) {
		send(res, 400, { error: target ? `Add the API key (${target.config.apiKeyEnv}) to ${what}` : "Pick a game first" });
		return null;
	}
	return { config: target.config, cloud: target.cloud };
}

async function handlePlayer(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const player = await lookupPlayer(url.searchParams.get("q") ?? "");
	const target = gameCloud(server, url);
	const result: Record<string, unknown> = { player };
	if (target?.cloud && target.config.playerData) {
		const key = entryKey(target.config.playerData.keyFormat, player.id);
		result.dataKey = key;
		result.entry = await readEntry(target.cloud, target.config.playerData.dataStore, key);
		result.backups = listBackups(server.baseDir, target.config.universeId, target.config.playerData.dataStore, key);
	}
	if (target?.cloud) {
		result.gifts = await pendingGifts(target.cloud, target.config.gifts?.dataStore ?? DEFAULT_GIFT_STORE, player.id);
	}
	send(res, 200, result);
}

async function handleEntry(server: Server, method: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const target = needCloud(server, url, res, "edit player data");
	if (!target) {
		return;
	}
	const dataStore = url.searchParams.get("ds") ?? "";
	const key = url.searchParams.get("key") ?? "";
	if (!dataStore || !key) {
		send(res, 400, { error: "Pick a data store and key" });
		return;
	}
	if (method === "GET") {
		send(res, 200, {
			entry: await readEntry(target.cloud, dataStore, key),
			backups: listBackups(server.baseDir, target.config.universeId, dataStore, key),
		});
		return;
	}
	const body = await jsonBody(req);
	if (method === "PUT") {
		const entry = await saveEntry(target.cloud, server.baseDir, dataStore, key, body.value, body.etag ?? null, "edit from UpdateDay");
		send(res, 200, { entry, backups: listBackups(server.baseDir, target.config.universeId, dataStore, key) });
		return;
	}
	if (method === "POST" && body.restore) {
		const value = readBackup(server.baseDir, target.config.universeId, dataStore, key, String(body.restore));
		const entry = await saveEntry(target.cloud, server.baseDir, dataStore, key, value, null, `restore ${body.restore}`);
		send(res, 200, { entry, backups: listBackups(server.baseDir, target.config.universeId, dataStore, key) });
		return;
	}
	send(res, 400, { error: "Unsupported entry request" });
}

async function handleGifts(server: Server, method: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const target = needCloud(server, url, res, "send gifts");
	if (!target) {
		return;
	}
	const userId = Number(url.searchParams.get("userId"));
	if (!Number.isInteger(userId) || userId <= 0) {
		send(res, 400, { error: "Look up a player first" });
		return;
	}
	const store = target.config.gifts?.dataStore ?? DEFAULT_GIFT_STORE;
	if (method === "GET") {
		send(res, 200, { gifts: await pendingGifts(target.cloud, store, userId) });
		return;
	}
	if (method === "POST") {
		const gift = await sendGift(target.cloud, server.baseDir, store, userId, await jsonBody(req));
		send(res, 200, { gift, gifts: await pendingGifts(target.cloud, store, userId) });
		return;
	}
	if (method === "DELETE") {
		send(res, 200, { gifts: await cancelGift(target.cloud, server.baseDir, store, userId, url.searchParams.get("id") ?? "") });
		return;
	}
	send(res, 400, { error: "Unsupported gift request" });
}

function savedConfigs(server: Server): Config[] {
	const raw = JSON.parse(readFileSync(server.configPath, "utf8"));
	return parseConfigs(raw, server.baseDir);
}

function makeContext(server: Server, config: Config): RunContext {
	const apiKey = apiKeyFor(server, config);
	return {
		config,
		state: loadState(config.statePath, config.updateAt),
		cloud: apiKey ? new OpenCloud(apiKey, config.universeId) : null,
		now: new Date(),
		notify: discordNotifier(config, webhookFor(server, config)),
	};
}

async function tickAll(server: Server, configs: Config[], dryRun: boolean): Promise<number> {
	let remaining = 0;
	for (const config of configs) {
		if (configs.length > 1) {
			console.log(`-- ${config.name}`);
		}
		try {
			const ctx = makeContext(server, config);
			if (!dryRun && !ctx.cloud) {
				throw new Error(`no API key (${config.apiKeyEnv})`);
			}
			const run = () => tick(buildSchedule(config), ctx, dryRun);
			const left = dryRun ? await run() : await recording(config, run);
			remaining += left;
		} catch (error) {
			console.error(`${config.name}: ${error instanceof Error ? error.message : error}`);
			remaining++;
		}
	}
	return remaining;
}

async function watchLoop(server: Server): Promise<void> {
	server.mode = "watching";
	server.stopRequested = false;
	console.log("Started. Checking every 30 seconds.");
	let waitingLogged = false;
	try {
		while (!server.stopRequested) {
			const configs = savedConfigs(server);
			const remaining = await tickAll(server, configs, false);
			const repeating = configs.filter((config) => config.repeat);
			if (remaining === 0 && repeating.length === 0) {
				console.log("Every schedule is complete.");
				break;
			}
			if (remaining === 0 && !waitingLogged) {
				const next = repeating.map((config) => nextOccurrence(config)).filter((date): date is Date => date !== null).sort((a, b) => a.getTime() - b.getTime())[0];
				if (!next) {
					console.log("Every schedule is complete.");
					break;
				}
				console.log(`This update day is done. Waiting for the next one (${next.toUTCString()}).`);
				waitingLogged = true;
			}
			if (remaining > 0) {
				waitingLogged = false;
			}
			for (let waited = 0; waited < WATCH_INTERVAL_MS && !server.stopRequested; waited += 1000) {
				await new Promise((done) => setTimeout(done, 1000));
			}
		}
	} finally {
		server.mode = "idle";
		console.log("Stopped.");
	}
}

const EXPERIMENTS_URL = new URL(`./experiments${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url).href;

async function runSwapExperiment(server: Server, swapTo: string, holdMs: number, approvalWaitMs: number): Promise<void> {
	const config = savedConfigs(server)[0];
	const ctx = makeContext(server, config);
	if (!ctx.cloud) {
		console.error(`no API key (${config.apiKeyEnv})`);
		return;
	}
	server.mode = "experimenting";
	server.stopRequested = false;
	try {
		const base = await baseIcon(server, config);
		const style = { ...(config.countdown ?? parseConfigs({ universeId: 1, updateAt: config.updateAt }, server.baseDir)[0].countdown!), skip: [] };
		const icon = await renderIcon(base, "10m", style);
		const { languageSwapExperiment } = await import(`${EXPERIMENTS_URL}?v=${Date.now()}`);
		await languageSwapExperiment({
			cloud: ctx.cloud,
			universeId: config.universeId,
			icon: new Blob([new Uint8Array(icon)], { type: "image/png" }),
			holdMs,
			approvalWaitMs,
			swapTo,
			log: (line: string) => console.log(line),
			shouldStop: () => server.stopRequested,
		});
	} catch (error) {
		console.error(`[swap] ${error instanceof Error ? error.message : error}`);
	} finally {
		server.mode = "idle";
		console.log("[swap] experiment finished");
	}
}

async function runExperiment(server: Server, params: URLSearchParams): Promise<void> {
	const config = savedConfigs(server)[0];
	const ctx = makeContext(server, config);
	const name = params.get("name") ?? "";
	if (!ctx.cloud) {
		console.error(`no API key (${config.apiKeyEnv})`);
		return;
	}
	server.mode = "experimenting";
	server.stopRequested = false;
	try {
		const experiments = await import(`${EXPERIMENTS_URL}?v=${Date.now()}`);
		if (typeof experiments[name] !== "function") {
			throw new Error(`No experiment called "${name}"`);
		}
		await experiments[name]({
			cloud: ctx.cloud,
			universeId: config.universeId,
			params,
			log: (line: string) => console.log(line),
			shouldStop: () => server.stopRequested,
		});
	} catch (error) {
		console.error(`[${name}] ${error instanceof Error ? error.message : error}`);
	} finally {
		server.mode = "idle";
		console.log(`[${name}] experiment finished`);
	}
}

async function handleRun(server: Server, action: string, query: string, res: ServerResponse): Promise<void> {
	if (action === "stop") {
		server.stopRequested = true;
		send(res, 200, { ok: true });
		return;
	}
	if (server.mode !== "idle") {
		send(res, 409, { error: "Already running. Stop it first." });
		return;
	}
	if (action === "swap-experiment") {
		const params = new URL(`http://x/?${query}`).searchParams;
		const holdMs = (Number(params.get("hold")) || 180) * 1000;
		const approvalWaitMs = (Number(params.get("wait")) || 900) * 1000;
		runSwapExperiment(server, params.get("swapTo") || "de", holdMs, approvalWaitMs);
		send(res, 200, { ok: true });
		return;
	}
	if (action === "experiment") {
		runExperiment(server, new URLSearchParams(query));
		send(res, 200, { ok: true });
		return;
	}
	if (action === "start") {
		watchLoop(server);
		send(res, 200, { ok: true });
		return;
	}
	if (action === "dryrun") {
		console.log("Dry run: what would happen right now");
		await tickAll(server, savedConfigs(server), true);
		send(res, 200, { ok: true });
		return;
	}
	if (action === "restore") {
		for (const config of savedConfigs(server)) {
			const ctx = makeContext(server, config);
			if (!ctx.cloud) {
				console.error(`${config.name}: no API key (${config.apiKeyEnv})`);
				continue;
			}
			await recording(config, async () => {
				await restorePrices(ctx);
				await endCountdown(ctx);
			});
			saveState(config.statePath, ctx.state);
		}
		send(res, 200, { ok: true });
		return;
	}
	send(res, 400, { error: `Unknown action ${action}` });
}

async function handlePreflight(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const picked = url.searchParams.get("game");
	const configs = picked === null ? server.draftConfigs : [server.draftConfigs[Number(picked)]];
	const reports = [];
	for (const config of configs) {
		if (!config) {
			continue;
		}
		const apiKey = apiKeyFor(server, config);
		reports.push(await preflight(config, apiKey ? new OpenCloud(apiKey, config.universeId) : null, webhookFor(server, config)));
	}
	send(res, 200, { reports, error: server.draftError });
}

function fileSafe(text: string): string {
	return text.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "game";
}

async function handleIconZip(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const config = server.draftConfigs[Number(url.searchParams.get("game"))];
	if (!config?.countdown) {
		send(res, 404, { error: "No countdown for that game" });
		return;
	}
	const data = await iconZip(config, await baseIcon(server, config), url.searchParams.get("languages") === "1");
	res.writeHead(200, {
		"content-type": ZIP_TYPE,
		"content-disposition": `attachment; filename="${fileSafe(config.name)}-countdown-icons.zip"`,
		"cache-control": "no-store",
	});
	res.end(data);
}

function artFolder(server: Server): string {
	return join(server.baseDir, ART_DIR);
}

async function handleArt(server: Server, method: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const folder = artFolder(server);
	if (method === "GET") {
		const files = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".png")).map((name) => name.slice(0, -4)) : [];
		send(res, 200, { dir: ART_DIR, marks: files });
		return;
	}
	const mark = url.searchParams.get("mark") ?? "";
	if (!ART_MARK.test(mark)) {
		send(res, 400, { error: "Pick a stage for this art" });
		return;
	}
	const path = join(folder, `${mark}.png`);
	if (method === "DELETE") {
		rmSync(path, { force: true });
	} else if (method === "POST") {
		const art = await sharp(await readBody(req)).resize(ICON_SIZE, ICON_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
		mkdirSync(folder, { recursive: true });
		writeFileSync(path, art);
	} else {
		send(res, 400, { error: "Unsupported art request" });
		return;
	}
	server.renderCache.clear();
	send(res, 200, { ok: true, dir: ART_DIR });
}

async function handleModeration(server: Server, method: string, url: URL, res: ServerResponse): Promise<void> {
	const target = gameCloud(server, url);
	if (!target?.config.countdown) {
		send(res, 404, { error: "No countdown for that game" });
		return;
	}
	const base = await baseIcon(server, target.config);
	if (method === "POST") {
		if (!target.cloud) {
			send(res, 400, { error: `Add the API key (${target.config.apiKeyEnv}) to check icons with moderation` });
			return;
		}
		const sent = await submitForModeration(target.config, target.cloud, base);
		send(res, 200, { sent, stages: await moderationStatus(target.config, target.cloud, base) });
		return;
	}
	send(res, 200, { stages: await moderationStatus(target.config, target.cloud, base) });
}

async function handleNotifyTest(server: Server, url: URL, res: ServerResponse): Promise<void> {
	const config = server.draftConfigs[Number(url.searchParams.get("game"))] ?? server.draftConfigs.find(Boolean);
	if (!config?.notify) {
		send(res, 400, { error: "Turn on Discord alerts first" });
		return;
	}
	const webhook = webhookFor(server, config);
	if (!webhook) {
		send(res, 400, { error: "Paste the Discord webhook link first" });
		return;
	}
	await postDiscord(webhook, { event: "finished", title: "UpdateDay test", text: "Alerts for your update days will arrive here." }, config.notify.mention);
	send(res, 200, { ok: true });
}

async function route(server: Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${HOST}:${server.port}`);
	const method = req.method ?? "GET";
	if (method === "GET" && url.pathname === "/") {
		send(res, 200, readFileSync(UI_FILE), "text/html; charset=utf-8");
		return;
	}
	if (method === "GET" && /^\/ui\/[\w-]+\.js$/.test(url.pathname)) {
		const file = resolve(dirname(UI_FILE), url.pathname.slice("/ui/".length));
		if (!existsSync(file)) {
			send(res, 404, { error: "Not found" });
			return;
		}
		send(res, 200, readFileSync(file), "text/javascript; charset=utf-8");
		return;
	}
	if (method === "GET" && url.pathname === "/api/draft") {
		send(res, 200, { draft: server.draft, error: server.draftError, revision: server.revision, configPath: server.configPath });
		return;
	}
	if (method === "PUT" && url.pathname === "/api/draft") {
		applyDraft(server, toMulti(JSON.parse((await readBody(req)).toString("utf8"))));
		send(res, 200, { error: server.draftError, revision: server.revision });
		return;
	}
	if (method === "POST" && url.pathname === "/api/save") {
		const error = server.draftError ?? incompleteGameError(server.draft);
		if (error) {
			send(res, 400, { error });
			return;
		}
		writeFileSync(server.configPath, JSON.stringify(flattenSingleGame(server.draft), null, "\t"));
		send(res, 200, { ok: true, running: server.mode !== "idle" });
		return;
	}
	if (method === "GET" && url.pathname === "/api/schedule") {
		send(res, 200, { games: scheduleView(server), error: server.draftError, revision: server.revision });
		return;
	}
	if (method === "GET" && url.pathname === "/api/doctor") {
		const target = needCloud(server, url, res, "check it");
		if (target) {
			send(res, 200, { probes: await checkKey(target.cloud, target.config) });
		}
		return;
	}
	if (method === "GET" && url.pathname === "/api/player") {
		await handlePlayer(server, url, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/datastores") {
		const target = needCloud(server, url, res, "list data stores");
		if (target) {
			send(res, 200, { dataStores: await listDataStores(target.cloud) });
		}
		return;
	}
	if (url.pathname === "/api/entry") {
		await handleEntry(server, method, url, req, res);
		return;
	}
	if (url.pathname === "/api/gifts") {
		await handleGifts(server, method, url, req, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/page") {
		await handlePage(server, url, res);
		return;
	}
	if (method === "POST" && url.pathname === "/api/event-image") {
		const target = needCloud(server, url, res, "upload event images");
		if (target) {
			const png = await sharp(await readBody(req)).resize(1920, 1080, { fit: "cover" }).png().toBuffer();
			const assetId = await target.cloud.uploadImage(new Blob([new Uint8Array(png)], { type: "image/png" }), `${target.config.name} event`);
			send(res, 200, { assetId });
		}
		return;
	}
	if (url.pathname === "/api/events") {
		await handleEvents(server, method, url, req, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/items") {
		await handleItems(server, url, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/file") {
		handleFile(server, url, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/lookup") {
		send(res, 200, await lookupGame(url.searchParams.get("q") ?? ""));
		return;
	}
	if (method === "GET" && url.pathname === "/api/icon") {
		await handleIcon(server, url, res);
		return;
	}
	if (method === "POST" && url.pathname === "/api/upload") {
		await handleUpload(server, url, req, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/preflight") {
		await handlePreflight(server, url, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/icons.zip") {
		await handleIconZip(server, url, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/kit.zip") {
		res.writeHead(200, { "content-type": ZIP_TYPE, "content-disposition": 'attachment; filename="UpdateDay-roblox-kit.zip"' });
		res.end(kitZip());
		return;
	}
	if (url.pathname === "/api/art") {
		await handleArt(server, method, url, req, res);
		return;
	}
	if (url.pathname === "/api/moderation") {
		await handleModeration(server, method, url, res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/style-art") {
		const name = url.searchParams.get("name") ?? "";
		if (!HOURGLASS_STYLES.includes(name)) {
			send(res, 404, { error: "No such style" });
			return;
		}
		const file = name === "original" ? join(dirname(stylePath("classic")), "../hourglass/default.png") : stylePath(name);
		res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
		res.end(readFileSync(file));
		return;
	}
	if (method === "GET" && url.pathname === "/api/history") {
		const picked = url.searchParams.get("game");
		const config = picked === null ? null : server.draftConfigs[Number(picked)];
		send(res, 200, { entries: readHistory(server.baseDir, config?.universeId, Number(url.searchParams.get("limit")) || undefined) });
		return;
	}
	if (method === "POST" && url.pathname === "/api/notify-test") {
		await handleNotifyTest(server, url, res);
		return;
	}
	if (method === "POST" && url.pathname === "/api/key") {
		const { env, value, kind } = JSON.parse((await readBody(req)).toString("utf8"));
		if (kind === "webhook" && value && !isWebhookUrl(String(value))) {
			send(res, 400, { error: "That isn't a Discord webhook link (https://discord.com/api/webhooks/...)" });
			return;
		}
		if (typeof env === "string" && /^[A-Z0-9_]+$/i.test(env)) {
			if (value) {
				server.sessionKeys[env] = String(value);
			} else {
				delete server.sessionKeys[env];
			}
		}
		send(res, 200, { ok: true });
		return;
	}
	if (method === "POST" && url.pathname.startsWith("/api/run/")) {
		await handleRun(server, url.pathname.slice("/api/run/".length), url.search.slice(1), res);
		return;
	}
	if (method === "GET" && url.pathname === "/api/status") {
		send(res, 200, { mode: server.mode, log: server.log.slice(-200) });
		return;
	}
	send(res, 404, { error: "Not found" });
}

export type RunningServer = {
	url: string;
	close: () => Promise<void>;
};

export function startServer(configPath: string, port: number): Promise<RunningServer> {
	const fullPath = resolve(configPath);
	const server: Server = {
		configPath: fullPath,
		baseDir: dirname(fullPath),
		port,
		draft: null,
		draftConfigs: [],
		draftError: null,
		revision: 0,
		iconCache: new Map(),
		renderCache: new Map(),
		itemCache: new Map(),
		mode: "idle",
		stopRequested: false,
		log: [],
		sessionKeys: {},
	};
	applyDraft(server, readDraft(fullPath));
	captureConsole(server);
	const http = createServer((req, res) => {
		if (!isLocalRequest(req, port)) {
			send(res, 403, { error: "Local access only" });
			return;
		}
		route(server, req, res).catch((error) => {
			send(res, 500, { error: error instanceof Error ? error.message : String(error) });
		});
	});
	return new Promise((resolveServer) => {
		http.listen(port, HOST, () => resolveServer({
			url: `http://${HOST}:${port}/`,
			close: () => new Promise((done) => {
				http.closeAllConnections();
				http.close(() => done());
			}),
		}));
	});
}
