import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { loadConfigs } from "../src/config.ts";
import { OpenCloud } from "../src/openCloud.ts";
import { restorePrices, taggedName, tick, type RunContext } from "../src/runner.ts";
import { buildSchedule } from "../src/schedule.ts";
import { loadState } from "../src/state.ts";

const UNIVERSE = 42;
const HOUR = 60 * 60 * 1000;

type Call = { method: string; path: string };

const FAKE_ICON_URL = "https://tr.rbxcdn.com/fake-icon/512/512/Image/Png";

async function fakeIconPng(): Promise<Buffer> {
	return sharp({ create: { width: 512, height: 512, channels: 4, background: "#3366ff" } }).png().toBuffer();
}

function fakeRoblox(prices: Map<string, number>, iconPng: Buffer, names = new Map<string, string>()) {
	const calls: Call[] = [];
	const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
		if (String(url).startsWith("https://thumbnails.roblox.com/")) {
			return Response.json({ data: [{ targetId: UNIVERSE, state: "Completed", imageUrl: FAKE_ICON_URL }] });
		}
		if (String(url) === FAKE_ICON_URL) {
			return new Response(new Uint8Array(iconPng));
		}
		const path = String(url).replace("https://apis.roblox.com", "");
		const method = init.method ?? "GET";
		calls.push({ method, path });
		const priceMatch = /\/(game-passes|developer-products)\/(\d+)(\/creator)?$/.exec(path);
		if (priceMatch) {
			const key = `${priceMatch[1]}:${priceMatch[2]}`;
			if (method === "PATCH") {
				const form = init.body as FormData;
				if (form.has("price")) {
					prices.set(key, Number(form.get("price")));
				}
				if (form.has("name")) {
					names.set(key, String(form.get("name")));
				}
				return new Response(null, { status: 204 });
			}
			return Response.json({ name: names.get(key) ?? key, isForSale: true, priceInformation: { defaultPriceInRobux: prices.get(key) } });
		}
		if (path.endsWith("/game-passes/creator")) {
			return Response.json({ gamePasses: [{ gamePassId: 1 }, { gamePassId: 2 }] });
		}
		return Response.json({ id: "evt-1" });
	};
	return { calls, fetchImpl };
}

function setup(updateAt: Date) {
	const dir = mkdtempSync(join(tmpdir(), "updateday-"));
	const configPath = join(dir, "updateday.json");
	writeFileSync(configPath, JSON.stringify({
		universeId: UNIVERSE,
		updateAt: updateAt.toISOString(),
		adminAbuseMinutes: 60,
		countdown: { marks: ["24h", "1h"] },
		sale: { percentOff: 25, durationHours: 2, gamePasses: "all", developerProducts: [9] },
		broadcast: { topic: "UpdateDay", marks: ["5m"] },
	}));
	return loadConfigs(configPath)[0];
}

function context(config: ReturnType<typeof setup>, now: Date): RunContext {
	return {
		config,
		state: loadState(config.statePath, config.updateAt),
		cloud: new OpenCloud("test-key", UNIVERSE),
		now,
	};
}

test("runs a full update day and restores prices", async () => {
	const prices = new Map([["game-passes:1", 100], ["game-passes:2", 399], ["developer-products:9", 50]]);
	const { calls, fetchImpl } = fakeRoblox(prices, await fakeIconPng());
	globalThis.fetch = fetchImpl as typeof fetch;
	const updateAt = new Date(Date.now() + 30 * 60 * 1000);
	const config = setup(updateAt);
	const steps = buildSchedule(config);

	await tick(steps, context(config, new Date(updateAt.getTime() - 2 * HOUR)), false);
	assert.equal(calls.filter((call) => call.path.includes("game-icon")).length, 0, "reminder mode never touches the icon");
	assert.ok(existsSync(join(config.baseDir, "updateday-icons", String(UNIVERSE), "24h.png")), "the due countdown icon is saved for upload");
	assert.ok(existsSync(config.snapshotPath), "the original icon is saved before the countdown");

	await tick(steps, context(config, new Date(updateAt.getTime() + 61 * 60 * 1000)), false);
	assert.equal(prices.get("game-passes:1"), 75);
	assert.equal(prices.get("game-passes:2"), 299);
	assert.equal(prices.get("developer-products:9"), 38);
	assert.ok(calls.some((call) => call.path.endsWith(":publishMessage")) === false, "a 1h-late warning is skipped");

	const remaining = await tick(steps, context(config, new Date(updateAt.getTime() + 3 * HOUR)), false);
	assert.equal(remaining, 0);
	assert.deepEqual([...prices.values()], [100, 399, 50]);
	assert.equal(calls.filter((call) => call.path.includes("game-icon")).length, 0);
});

test("restore puts prices back after a crash mid-sale", async () => {
	const prices = new Map([["game-passes:1", 100], ["game-passes:2", 200], ["developer-products:9", 10]]);
	const { fetchImpl } = fakeRoblox(prices, await fakeIconPng());
	globalThis.fetch = fetchImpl as typeof fetch;
	const updateAt = new Date(Date.now() + 10 * 60 * 1000);
	const config = setup(updateAt);
	const steps = buildSchedule(config).filter((step) => step.id === "sale:start");

	await tick(steps, context(config, new Date(updateAt.getTime() + 1000)), false);
	assert.equal(prices.get("game-passes:2"), 150);

	const fresh = context(config, new Date());
	await restorePrices(fresh);
	assert.deepEqual([...prices.values()], [100, 200, 10]);
});

test("multi-game configs share defaults and keep separate state", () => {
	const dir = mkdtempSync(join(tmpdir(), "updateday-multi-"));
	const configPath = join(dir, "updateday.json");
	writeFileSync(configPath, JSON.stringify({
		updateAt: "2026-11-07T17:00:00Z",
		countdown: { dim: 0.3 },
		sale: { percentOff: 20, durationHours: 24, gamePasses: "all", developerProducts: [] },
		games: [
			{ name: "Main", universeId: 1 },
			{ name: "Side", universeId: 2, updateAt: "2026-11-08T17:00:00Z", sale: false, countdown: { scale: 0.7 }, apiKeyEnv: "SIDE_KEY" },
		],
	}));
	const [main, side] = loadConfigs(configPath);
	assert.equal(main.sale?.percentOff, 20);
	assert.equal(side.sale, undefined);
	assert.equal(side.updateAt, "2026-11-08T17:00:00Z");
	assert.equal(main.countdown?.dim, 0.3);
	assert.equal(side.countdown?.dim, 0.3);
	assert.equal(side.countdown?.scale, 0.7);
	assert.equal(main.apiKeyEnv, "UPDATEDAY_API_KEY");
	assert.equal(side.apiKeyEnv, "SIDE_KEY");
	assert.notEqual(main.statePath, side.statePath);
	assert.notEqual(main.snapshotPath, side.snapshotPath);
	assert.ok(!buildSchedule(side).some((step) => step.id.startsWith("sale")));
});

function scheduleFor(countdown: object) {
	const dir = mkdtempSync(join(tmpdir(), "updateday-skip-"));
	const configPath = join(dir, "updateday.json");
	writeFileSync(configPath, JSON.stringify({ universeId: 7, updateAt: "2026-11-07T17:00:00Z", countdown }));
	return buildSchedule(loadConfigs(configPath)[0]);
}

test("skipped stages drop out and the new icon follows its timing", () => {
	const updateAt = Date.parse("2026-11-07T17:00:00Z");
	const ids = (steps: ReturnType<typeof buildSchedule>) => steps.map((step) => step.id);
	const atOf = (steps: ReturnType<typeof buildSchedule>, id: string) => steps.find((step) => step.id === id)!.at.getTime();

	const all = scheduleFor({});
	assert.equal(all.filter((step) => step.action.type === "icon").length, 15, "13 stages + NOW + final by default");

	const skipped = scheduleFor({ skip: ["5h", "4h", "10m"] });
	assert.ok(!ids(skipped).includes("icon:5h") && !ids(skipped).includes("icon:10m"));
	assert.ok(ids(skipped).includes("icon:24h") && ids(skipped).includes("icon:now"));

	const noNow = scheduleFor({ skip: ["now"], newIcon: "new.png" });
	assert.ok(!ids(noNow).includes("icon:now"));
	assert.equal(atOf(noNow, "icon:final"), updateAt, "without NOW the new icon goes up at update time");

	const withNow = scheduleFor({ newIcon: "new.png", newIconAt: "now" });
	assert.equal(atOf(withNow, "icon:now"), updateAt);
	assert.equal(atOf(withNow, "icon:final"), updateAt + 60 * 60 * 1000);
	assert.match(withNow.find((step) => step.id === "icon:now")!.label, /new game icon/);

	assert.throws(() => scheduleFor({ skip: ["7h"] }), /aren't in the countdown/);
});

test("sale name tags go on with the discount and come off with the restore", async () => {
	const prices = new Map([["game-passes:1", 100], ["game-passes:2", 40], ["developer-products:9", 20]]);
	const names = new Map([["game-passes:1", "2x Power"], ["game-passes:2", "VIP"], ["developer-products:9", "+1 Luck"]]);
	const { fetchImpl } = fakeRoblox(prices, await fakeIconPng(), names);
	globalThis.fetch = fetchImpl as typeof fetch;
	const updateAt = new Date(Date.now() + 10 * 60 * 1000);
	const config = setup(updateAt);
	config.sale!.nameTag = "[{percent}% OFF]";
	const steps = buildSchedule(config).filter((step) => step.id === "sale:start");

	const ctx = context(config, new Date(updateAt.getTime() + 1000));
	await tick(steps, ctx, false);
	assert.equal(names.get("game-passes:1"), "[25% OFF] 2x Power");
	assert.equal(names.get("developer-products:9"), "[25% OFF] +1 Luck");
	assert.equal(prices.get("game-passes:1"), 75);

	await restorePrices(context(config, new Date()));
	assert.deepEqual([...names.values()], ["2x Power", "VIP", "+1 Luck"]);
	assert.deepEqual([...prices.values()], [100, 40, 20]);
});

test("tags respect position, the 50 character limit and existing tags", () => {
	assert.equal(taggedName("VIP", "[SALE]", "suffix", 50), "VIP [SALE]");
	assert.equal(taggedName("[50% OFF] VIP", "[{percent}% OFF]", "prefix", 50), "[50% OFF] VIP");
	const long = taggedName("A".repeat(60), "[50% OFF]", "prefix", 50);
	assert.ok(long.length <= 50 && long.startsWith("[50% OFF] "));
	assert.equal(taggedName("VIP", "   ", "prefix", 50), "VIP");
});

function fakeI18n(iconPng: Buffer) {
	const world = { source: "en", supported: ["en", "de", "es"], icons: new Map<string, string>([["en", "original"]]) };
	const calls: Call[] = [];
	const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
		const href = String(url);
		const method = init.method ?? "GET";
		if (href.startsWith("https://thumbnails.roblox.com/")) {
			return Response.json({ data: [{ targetId: UNIVERSE, state: "Completed", imageUrl: FAKE_ICON_URL }] });
		}
		if (href === FAKE_ICON_URL) {
			return new Response(new Uint8Array(iconPng));
		}
		if (href.includes("gameinternationalization.roblox.com/v1/source-language")) {
			return Response.json({ languageCode: world.source });
		}
		if (href.includes("gameinternationalization.roblox.com/v1/supported-languages")) {
			return Response.json({ data: world.supported.map((languageCode) => ({ languageCode })) });
		}
		const path = href.replace("https://apis.roblox.com", "");
		calls.push({ method, path });
		const source = /source-language\/games\/\d+\?languageCode=([\w-]+)/.exec(path);
		if (source && method === "PATCH") {
			world.source = source[1];
			return new Response(null, { status: 200 });
		}
		const icon = /game-icon\/games\/\d+(?:\/language-codes\/([\w-]+))?$/.exec(path);
		if (icon && method === "GET") {
			return Response.json({ data: [...world.icons].map(([languageCode, image]) => ({ languageCode, imageUrl: image === "original" ? null : FAKE_ICON_URL, state: "Approved" })) });
		}
		if (icon && method === "POST") {
			if (icon[1] === world.source) {
				return Response.json({ errors: [{ code: 26 }] }, { status: 400 });
			}
			world.icons.set(icon[1], "countdown");
			return new Response(null, { status: 200 });
		}
		if (icon && method === "DELETE") {
			world.icons.delete(icon[1]);
			return new Response(null, { status: 200 });
		}
		return Response.json({});
	};
	return { world, calls, fetchImpl };
}

test("language swap uploads every language and cleans up in the right order", async () => {
	const { world, calls, fetchImpl } = fakeI18n(await fakeIconPng());
	globalThis.fetch = fetchImpl as typeof fetch;
	const updateAt = new Date(Date.now() + 30 * 60 * 1000);
	const dir = mkdtempSync(join(tmpdir(), "updateday-swap-"));
	const configPath = join(dir, "updateday.json");
	writeFileSync(configPath, JSON.stringify({
		universeId: UNIVERSE,
		updateAt: updateAt.toISOString(),
		adminAbuseMinutes: 60,
		countdown: { marks: ["24h", "1h"], iconMethod: "languageSwap", uploadLeadSeconds: 0 },
	}));
	const config = loadConfigs(configPath)[0];
	const steps = buildSchedule(config);

	await tick(steps, context(config, new Date(updateAt.getTime() - 2 * HOUR)), false);
	assert.equal(world.source, "de", "source moves to the temporary language");
	assert.equal(world.icons.get("en"), "countdown");
	assert.equal(world.icons.get("es"), "countdown");
	assert.ok(!world.icons.has("de"), "the temporary source language keeps the original icon");

	await tick(steps, context(config, new Date(updateAt.getTime() + 61 * 60 * 1000)), false);
	assert.equal(world.source, "en", "source language is restored");
	assert.deepEqual([...world.icons.keys()], [], "every countdown icon is removed");
	const deleteEn = calls.findIndex((call) => call.method === "DELETE" && call.path.endsWith("/language-codes/en"));
	const restoreSource = calls.findIndex((call) => call.method === "PATCH" && call.path.includes("languageCode=en"));
	assert.ok(deleteEn >= 0 && deleteEn < restoreSource, "the English icon is deleted before English becomes the source again");
});

test("translated countdown labels follow each language's plural rules", async () => {
	const { localizedLabel } = await import("../src/labels.ts");
	assert.equal(localizedLabel("1h", "de"), "1 STUNDE");
	assert.equal(localizedLabel("24h", "de"), "24 STUNDEN");
	assert.equal(localizedLabel("1h", "ru"), "1 ЧАС");
	assert.equal(localizedLabel("2h", "ru"), "2 ЧАСА");
	assert.equal(localizedLabel("5m", "ru"), "5 МИНУТ");
	assert.equal(localizedLabel("21h", "ru"), "21 ЧАС");
	assert.equal(localizedLabel("12h", "pl"), "12 GODZIN");
	assert.equal(localizedLabel("22h", "pl"), "22 GODZINY");
	assert.equal(localizedLabel("45m", "ja"), "45分");
	assert.equal(localizedLabel("now", "zh-hant"), "現在！");
	assert.equal(localizedLabel("1h", "en"), null, "English keeps the hand-drawn art");
	assert.equal(localizedLabel("1h", "xx"), null);
});
