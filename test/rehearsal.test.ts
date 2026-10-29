import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { loadConfigs, type Config } from "../src/config.ts";
import { readHistory, recording } from "../src/history.ts";
import { discordNotifier } from "../src/notify.ts";
import { OpenCloud } from "../src/openCloud.ts";
import { endCountdown, restorePrices, tick, titleFor, type RunContext } from "../src/runner.ts";
import { moderationStatus, submitForModeration } from "../src/moderation.ts";
import { buildSchedule } from "../src/schedule.ts";
import { loadState } from "../src/state.ts";

const UNIVERSE = 77;
const API_KEY = "test-key-SECRET-1234567890";
const WEBHOOK = "https://discord.com/api/webhooks/123/abc-DEF";
const ICON_URL = "https://tr.rbxcdn.com/rehearsal/512/512/Image/Png";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

type Item = { name: string; price: number; forSale: boolean };

type Fault = { method: string; path: RegExp; status?: number; reject?: boolean; times: number };

class FakeRoblox {
	passes = new Map<number, Item>([
		[1, { name: "2x Power", price: 100, forSale: true }],
		[2, { name: "VIP", price: 499, forSale: true }],
		[3, { name: "Old Pass", price: 50, forSale: false }],
	]);
	products = new Map<number, Item>([
		[10, { name: "100 Gems", price: 25, forSale: true }],
		[11, { name: "A Very Long Developer Product Name That Fills It", price: 999, forSale: true }],
	]);
	original = new Map<string, Item>();
	events: object[] = [];
	messages: { topic: string; message: string }[] = [];
	restarts = 0;
	alerts: { title: string; event: string; hasImage: boolean }[] = [];
	faults: Fault[] = [];
	icon: Buffer;
	title = "Superhero Simulator";
	titles: string[] = [];
	assets = new Map<number, string>();
	uploads = 0;
	rejectNextUpload = false;

	constructor(icon: Buffer) {
		this.icon = icon;
		for (const [id, item] of this.passes) {
			this.original.set(`pass:${id}`, { ...item });
		}
		for (const [id, item] of this.products) {
			this.original.set(`product:${id}`, { ...item });
		}
	}

	fault(method: string, path: RegExp, times: number, how: { status?: number; reject?: boolean }): void {
		this.faults.push({ method, path, times, ...how });
	}

	private item(kind: string, id: number): Item | undefined {
		return kind === "game-passes" ? this.passes.get(id) : this.products.get(id);
	}

	private list(kind: "game-passes" | "developer-products"): Response {
		const source = kind === "game-passes" ? this.passes : this.products;
		const rows = [...source].map(([id, item]) => ({
			[kind === "game-passes" ? "gamePassId" : "productId"]: id,
			name: item.name,
			isForSale: item.forSale,
			priceInformation: item.forSale ? { defaultPriceInRobux: item.price } : null,
		}));
		return Response.json(kind === "game-passes" ? { gamePasses: rows } : { developerProducts: rows });
	}

	async handle(url: string, init: RequestInit = {}): Promise<Response> {
		const method = init.method ?? "GET";
		if (url.startsWith("https://thumbnails.roblox.com/")) {
			return Response.json({ data: [{ targetId: UNIVERSE, state: "Completed", imageUrl: ICON_URL }] });
		}
		if (url === ICON_URL) {
			return new Response(new Uint8Array(this.icon));
		}
		if (url.startsWith("https://discord.com/")) {
			const form = init.body instanceof FormData ? init.body : null;
			const payload = JSON.parse(form ? String(form.get("payload_json")) : String(init.body));
			const title = payload.embeds[0].title as string;
			const event = ({ 0xf0b232: "reminders", 0xf0555a: "failures", 0x2fbf71: "live", 0x4c8dff: "finished" } as Record<number, string>)[payload.embeds[0].color] ?? "steps";
			this.alerts.push({ title, event, hasImage: Boolean(form?.get("files[0]")) });
			return new Response(null, { status: 204 });
		}
		assert.equal(new Headers(init.headers).get("x-api-key"), API_KEY);
		const path = url.replace("https://apis.roblox.com", "");
		const fault = this.faults.find((item) => item.times > 0 && item.method === method && item.path.test(path));
		if (fault) {
			fault.times--;
			if (fault.reject) {
				throw new TypeError("fetch failed: connection reset");
			}
			return new Response("fake failure", { status: fault.status });
		}
		const list = /\/(game-passes|developer-products)\/creator$/.exec(path);
		if (list && method === "GET") {
			return this.list(list[1] as "game-passes" | "developer-products");
		}
		const single = /\/(game-passes|developer-products)\/(\d+)(\/creator)?$/.exec(path);
		if (single) {
			const item = this.item(single[1], Number(single[2]));
			if (!item) {
				return new Response("not found", { status: 404 });
			}
			if (method === "PATCH") {
				const form = init.body as FormData;
				if (form.has("price")) {
					item.price = Number(form.get("price"));
				}
				if (form.has("name")) {
					item.name = String(form.get("name"));
				}
				return new Response(null, { status: 204 });
			}
			return Response.json({ name: item.name, isForSale: item.forSale, priceInformation: item.forSale ? { defaultPriceInRobux: item.price } : null });
		}
		if (path.endsWith("/game-events") && method === "POST") {
			this.events.push(JSON.parse(String(init.body)));
			return Response.json({ id: `evt-${this.events.length}` });
		}
		if (path.endsWith(":publishMessage")) {
			this.messages.push(JSON.parse(String(init.body)));
			return Response.json({});
		}
		if (path === `/cloud/v2/universes/${UNIVERSE}` && method === "GET") {
			return Response.json({ user: "users/9", rootPlace: `universes/${UNIVERSE}/places/555`, displayName: this.title });
		}
		if (path.startsWith(`/cloud/v2/universes/${UNIVERSE}/places/555`)) {
			if (method === "PATCH") {
				const body = JSON.parse(String(init.body));
				this.title = body.displayName ?? this.title;
				this.titles.push(this.title);
			}
			return Response.json({ displayName: this.title, description: "" });
		}
		if (path === "/assets/v1/assets" && method === "POST") {
			this.uploads++;
			const id = 9000 + this.uploads;
			this.assets.set(id, this.rejectNextUpload ? "Rejected" : "Approved");
			this.rejectNextUpload = false;
			return Response.json({ done: true, response: { assetId: String(id) } });
		}
		const asset = /^\/assets\/v1\/assets\/(\d+)/.exec(path);
		if (asset && method === "GET") {
			return Response.json({ moderationResult: { moderationState: this.assets.get(Number(asset[1])) ?? "Reviewing" } });
		}
		if (path.endsWith(":restartServers")) {
			this.restarts++;
			return Response.json({});
		}
		return new Response(`unexpected ${method} ${path}`, { status: 418 });
	}
}

async function fakeIcon(): Promise<Buffer> {
	return sharp({ create: { width: 512, height: 512, channels: 4, background: "#ff5533" } }).png().toBuffer();
}

function writePlan(dir: string, plan: object): string {
	const path = join(dir, "updateday.json");
	writeFileSync(path, JSON.stringify(plan, null, "\t"));
	return path;
}

function basePlan(updateAt: Date): Record<string, unknown> {
	return {
		universeId: UNIVERSE,
		name: "Rehearsal",
		updateAt: updateAt.toISOString(),
		adminAbuseMinutes: 60,
		countdown: {},
		sale: { percentOff: 30, durationHours: 2, gamePasses: "all", developerProducts: "all", nameTag: "[{percent}% OFF]" },
		event: { title: "New update!", subtitle: "Come play", durationHours: 2, visibility: "Public" },
		broadcast: { topic: "UpdateDay", marks: ["10m", "5m", "1m"] },
		restartServers: { bleedOffMinutes: 0 },
		notify: {},
	};
}

function context(config: Config, now: Date): RunContext {
	return {
		config,
		state: loadState(config.statePath, config.updateAt),
		cloud: new OpenCloud(API_KEY, config.universeId),
		now,
		notify: discordNotifier(config, WEBHOOK),
	};
}

async function checkAt(configPath: string, now: Date): Promise<{ left: number; error: string | null }> {
	const config = loadConfigs(configPath, now)[0];
	const ctx = context(config, now);
	try {
		const left = await recording(config, () => tick(buildSchedule(config), ctx, false));
		return { left, error: null };
	} catch (error) {
		return { left: -1, error: error instanceof Error ? error.message : String(error) };
	}
}

function checkpoints(configPath: string, from: Date, to: Date): Date[] {
	const config = loadConfigs(configPath, from)[0];
	const times = new Set<number>([from.getTime(), to.getTime()]);
	for (const step of buildSchedule(config)) {
		const at = step.at.getTime();
		if (at > from.getTime() && at < to.getTime()) {
			times.add(at + 20 * 1000);
		}
	}
	return [...times].sort((a, b) => a - b).map((time) => new Date(time));
}

function allFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? allFiles(path) : [path];
	});
}

test("a whole update day against a fake Roblox, with rate limits, a server error and a crash mid-sale", { timeout: 120000 }, async () => {
	const roblox = new FakeRoblox(await fakeIcon());
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => roblox.handle(String(url), init)) as typeof fetch;
	const log = console.log;
	const error = console.error;
	console.log = () => {};
	console.error = () => {};
	try {
		const dir = mkdtempSync(join(tmpdir(), "updateday-rehearsal-"));
		const updateAt = new Date(Date.now() + 26 * HOUR);
		const configPath = writePlan(dir, basePlan(updateAt));
		roblox.fault("PATCH", /game-passes\/1$/, 2, { status: 429 });
		roblox.fault("POST", /:publishMessage$/, 1, { status: 500 });
		roblox.fault("PATCH", /developer-products\/10$/, 1, { reject: true });

		const start = new Date(updateAt.getTime() - 25 * HOUR);
		const end = new Date(updateAt.getTime() + 3 * HOUR);
		const errors: string[] = [];
		let saleChecked = false;
		for (const now of checkpoints(configPath, start, end)) {
			let result = await checkAt(configPath, now);
			if (result.error) {
				errors.push(result.error);
				result = await checkAt(configPath, new Date(now.getTime() + 30 * 1000));
			}
			assert.equal(result.error, null, `second try at ${now.toISOString()} failed: ${result.error}`);
			if (!saleChecked && now.getTime() > updateAt.getTime() + 30 * MINUTE) {
				saleChecked = true;
				for (const [key, before] of roblox.original) {
					const [kind, id] = key.split(":");
					const live = kind === "pass" ? roblox.passes.get(Number(id))! : roblox.products.get(Number(id))!;
					if (!before.forSale) {
						assert.deepEqual(live, before, `${before.name} isn't for sale and must not change`);
						continue;
					}
					assert.equal(live.price, Math.max(1, Math.round(before.price * 0.7)), `${before.name} should be 30% off during the sale`);
					assert.ok(live.name.startsWith("[30% OFF] "), `${before.name} should carry the tag, got "${live.name}"`);
					assert.ok(live.name.length <= 50, `"${live.name}" is over Roblox's 50-character limit`);
				}
			}
		}

		assert.ok(saleChecked, "the sale was checked while it ran");
		assert.equal(errors.length, 1, `exactly the injected crash should surface: ${errors.join(" | ")}`);
		for (const [key, before] of roblox.original) {
			const [kind, id] = key.split(":");
			const live = kind === "pass" ? roblox.passes.get(Number(id))! : roblox.products.get(Number(id))!;
			assert.deepEqual(live, before, `${key} must be exactly as it was after the sale`);
		}
		assert.equal(roblox.events.length, 1, "one event");
		assert.deepEqual(roblox.messages.map((item) => JSON.parse(item.message).mark), ["10m", "5m", "1m"], "every warning sent once, the failed one retried");
		assert.equal(roblox.restarts, 1, "servers restarted once");

		const config = loadConfigs(configPath, end)[0];
		const state = loadState(config.statePath, config.updateAt);
		const steps = buildSchedule(config);
		assert.deepEqual(steps.filter((step) => !state.done[step.id]).map((step) => step.id), [], "every step done");
		const reminders = readdirSync(join(dir, "updateday-icons", String(UNIVERSE)));
		assert.ok(reminders.includes("24h.png") && reminders.includes("now.png") && reminders.includes("final.png"), `reminder icons written: ${reminders}`);

		const kinds = roblox.alerts.map((alert) => alert.event);
		assert.equal(kinds.filter((kind) => kind === "live").length, 1, "one 'update is live' alert");
		assert.equal(kinds.filter((kind) => kind === "finished").length, 1, "one 'finished' alert");
		assert.ok(kinds.filter((kind) => kind === "failures").length >= 1, "the crash was reported");
		const reminderAlerts = roblox.alerts.filter((alert) => alert.event === "reminders");
		assert.equal(reminderAlerts.length, reminders.length, "one reminder alert per icon to upload");
		assert.ok(reminderAlerts.every((alert) => alert.hasImage), "every reminder alert has the icon attached");

		const history = readHistory(dir);
		assert.ok(history.some((entry) => entry.kind === "error"), "the failure is in the history");
		assert.ok(history.some((entry) => entry.kind === "sale" && /restored/.test(entry.text)), "price restores are in the history");
		assert.ok(history.some((entry) => entry.kind === "reminder"), "reminders are in the history");

		for (const file of allFiles(dir)) {
			assert.ok(!readFileSync(file).includes(API_KEY), `the API key leaked into ${file}`);
			assert.ok(!readFileSync(file).includes(WEBHOOK), `the webhook leaked into ${file}`);
		}
	} finally {
		globalThis.fetch = realFetch;
		console.log = log;
		console.error = error;
	}
});

test("restoring twice is safe and the second time changes nothing", async () => {
	const roblox = new FakeRoblox(await fakeIcon());
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => roblox.handle(String(url), init)) as typeof fetch;
	const log = console.log;
	console.log = () => {};
	try {
		const dir = mkdtempSync(join(tmpdir(), "updateday-restore-"));
		const updateAt = new Date(Date.now() - 10 * MINUTE);
		const configPath = writePlan(dir, { ...basePlan(updateAt), countdown: false, event: false, broadcast: false, restartServers: false, notify: false });
		await checkAt(configPath, new Date());
		assert.equal(roblox.passes.get(1)!.price, 70);
		const config = loadConfigs(configPath)[0];
		await restorePrices(context(config, new Date()));
		assert.equal(roblox.passes.get(1)!.price, 100);
		const patchesBefore = roblox.passes.get(1)!.name;
		let writes = 0;
		globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "PATCH") {
				writes++;
			}
			return roblox.handle(String(url), init);
		}) as typeof fetch;
		const again = loadConfigs(configPath)[0];
		await restorePrices(context(again, new Date()));
		assert.equal(writes, 0, "nothing is written the second time");
		assert.equal(roblox.passes.get(1)!.name, patchesBefore);
	} finally {
		globalThis.fetch = realFetch;
		console.log = log;
	}
});

test("a weekly plan moves to next week once this update day is over, and its fixed sale times move with it", () => {
	const dir = mkdtempSync(join(tmpdir(), "updateday-repeat-"));
	const updateAt = new Date("2026-11-07T18:00:00Z");
	const plan = {
		...basePlan(updateAt),
		repeat: { every: "week", until: "2026-12-01T00:00:00Z" },
		sale: { percentOff: 20, durationHours: 1, startsAt: "2026-11-07T19:00:00Z", endsAt: "2026-11-08T19:00:00Z", gamePasses: "all", developerProducts: "all" },
	};
	const configPath = writePlan(dir, plan);
	const during = loadConfigs(configPath, new Date("2026-11-08T12:00:00Z"))[0];
	assert.equal(during.updateAt, "2026-11-07T18:00:00.000Z", "still this week while the sale runs");
	const after = loadConfigs(configPath, new Date("2026-11-09T12:00:00Z"))[0];
	assert.equal(after.updateAt, "2026-11-14T18:00:00.000Z");
	assert.equal(after.sale?.startsAt, "2026-11-14T19:00:00.000Z");
	assert.equal(after.sale?.endsAt, "2026-11-15T19:00:00.000Z");
	const late = loadConfigs(configPath, new Date("2027-02-01T00:00:00Z"))[0];
	assert.equal(late.updateAt, "2026-11-28T18:00:00.000Z", "stops at the last one before 'until'");
	assert.ok(!existsSync(join(dir, "updateday-history.jsonl")));
});

test("a monthly plan keeps the same day of the month", () => {
	const dir = mkdtempSync(join(tmpdir(), "updateday-month-"));
	const configPath = writePlan(dir, { ...basePlan(new Date("2026-01-15T17:00:00Z")), repeat: { every: "month" }, sale: false });
	const config = loadConfigs(configPath, new Date("2026-04-20T00:00:00Z"))[0];
	assert.equal(config.updateAt, "2026-05-15T17:00:00.000Z");
});

function quietly<T>(roblox: FakeRoblox, task: () => Promise<T>): Promise<T> {
	const realFetch = globalThis.fetch;
	const log = console.log;
	const error = console.error;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => roblox.handle(String(url), init)) as typeof fetch;
	console.log = () => {};
	console.error = () => {};
	return task().finally(() => {
		globalThis.fetch = realFetch;
		console.log = log;
		console.error = error;
	});
}

test("the title counts down stage by stage, goes LIVE, and ends on the original title", { timeout: 60000 }, async () => {
	const roblox = new FakeRoblox(await fakeIcon());
	await quietly(roblox, async () => {
		const dir = mkdtempSync(join(tmpdir(), "updateday-title-"));
		const updateAt = new Date(Date.now() + 3 * HOUR);
		const configPath = writePlan(dir, { universeId: UNIVERSE, name: "Titles", updateAt: updateAt.toISOString(), adminAbuseMinutes: 30, countdown: { marks: ["2h", "1h", "30m"] }, title: {} });
		for (const now of checkpoints(configPath, new Date(updateAt.getTime() - 3 * HOUR), new Date(updateAt.getTime() + HOUR))) {
			const result = await checkAt(configPath, now);
			assert.equal(result.error, null, result.error ?? "");
		}
		assert.deepEqual(roblox.titles, [
			"[2H] Superhero Simulator",
			"[1H] Superhero Simulator",
			"[30M] Superhero Simulator",
			"[LIVE] Superhero Simulator",
			"Superhero Simulator",
		]);
	});
});

test("Undo all in the middle of a title countdown puts the real title back", async () => {
	const roblox = new FakeRoblox(await fakeIcon());
	await quietly(roblox, async () => {
		const dir = mkdtempSync(join(tmpdir(), "updateday-title-undo-"));
		const updateAt = new Date(Date.now() + 90 * MINUTE);
		const configPath = writePlan(dir, { universeId: UNIVERSE, name: "Undo", updateAt: updateAt.toISOString(), countdown: { marks: ["2h", "1h"] }, title: { format: "{name} | {time} LEFT" } });
		await checkAt(configPath, new Date());
		assert.equal(roblox.title, "Superhero Simulator | 2H LEFT");
		const config = loadConfigs(configPath)[0];
		await endCountdown(context(config, new Date()));
		assert.equal(roblox.title, "Superhero Simulator");
		const writes = roblox.titles.length;
		await endCountdown(context(loadConfigs(configPath)[0], new Date()));
		assert.equal(roblox.titles.length, writes, "a second undo writes nothing");
	});
});

test("titles never go over 50 characters", () => {
	const long = "The Ultimate Superhero Training Simulator Remastered";
	const title = titleFor("[{time}] {name}", long, "45M");
	assert.ok(title.length <= 50, title);
	assert.ok(title.startsWith("[45M] The Ultimate"));
	assert.equal(titleFor("{name} [UPDATE 5]", "Short", ""), "Short [UPDATE 5]");
});

test("the moderation check sends only changed icons and reports what Roblox decided", { timeout: 60000 }, async () => {
	const roblox = new FakeRoblox(await fakeIcon());
	await quietly(roblox, async () => {
		const dir = mkdtempSync(join(tmpdir(), "updateday-moderation-"));
		const plan = { universeId: UNIVERSE, name: "Mod", updateAt: new Date(Date.now() + 26 * HOUR).toISOString(), countdown: { marks: ["1h", "5m"] } };
		const configPath = writePlan(dir, plan);
		const config = loadConfigs(configPath)[0];
		const cloud = new OpenCloud(API_KEY, UNIVERSE);
		const base = await fakeIcon();
		assert.ok((await moderationStatus(config, cloud, base)).every((stage) => stage.state === "unchecked"));
		roblox.rejectNextUpload = true;
		assert.equal(await submitForModeration(config, cloud, base), 3, "1h, 5m and NOW");
		const first = await moderationStatus(config, cloud, base);
		assert.deepEqual(first.map((stage) => stage.state), ["Rejected", "Approved", "Approved"]);
		assert.equal(await submitForModeration(config, cloud, base), 1, "only the rejected one goes again");
		assert.ok((await moderationStatus(config, cloud, base)).every((stage) => stage.state === "Approved"));
		writePlan(dir, { ...plan, countdown: { ...plan.countdown, dim: 0.7 } });
		const changed = loadConfigs(configPath)[0];
		assert.ok((await moderationStatus(changed, cloud, base)).every((stage) => stage.state === "unchecked"), "a new look needs a new check");
	});
});
