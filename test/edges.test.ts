import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfigs } from "../src/config.ts";
import { kindOf } from "../src/history.ts";
import { mergePatch } from "../src/mcp.ts";
import { isWebhookUrl } from "../src/notify.ts";
import { taggedName } from "../src/runner.ts";
import { buildSchedule } from "../src/schedule.ts";
import { startServer } from "../src/server.ts";
import { crc32, zip } from "../src/zip.ts";

const HOUR = 60 * 60 * 1000;
const ALL_STAGES = ["24h", "12h", "6h", "5h", "4h", "3h", "2h", "1h", "45m", "30m", "15m", "10m", "5m", "now"];

function plan(extra: object = {}): any {
	return { universeId: 5, name: "Edge", updateAt: "2026-03-29T01:30:00Z", countdown: {}, ...extra };
}

test("stages stay exact across a daylight-saving change", () => {
	const config = parseConfigs(plan(), tmpdir())[0];
	const steps = buildSchedule(config);
	const at = (id: string) => steps.find((step) => step.id === id)!.at.getTime();
	const update = Date.parse("2026-03-29T01:30:00Z");
	assert.equal(update - at("icon:24h"), 24 * HOUR);
	assert.equal(update - at("icon:1h"), HOUR);
	assert.equal(at("icon:final") - update, HOUR);
});

test("skipping every stage leaves only saving and restoring the icon", () => {
	const config = parseConfigs(plan({ countdown: { skip: ALL_STAGES } }), tmpdir())[0];
	assert.deepEqual(buildSchedule(config).map((step) => step.id), ["icon:snapshot", "icon:final"]);
	const final = buildSchedule(config).find((step) => step.id === "icon:final")!;
	assert.equal(final.at.toISOString(), "2026-03-29T01:30:00.000Z", "with no NOW stage the icon comes back at the update");
});

test("an unknown stage in skip is a clear error", () => {
	assert.throws(() => parseConfigs(plan({ countdown: { skip: ["7h"] } }), tmpdir()), /isn't|aren't in the countdown/);
});

test("name tags never break Roblox's 50-character limit and are never doubled", () => {
	const long = "Ultimate Mega Legendary Super Pack Of Everything!!";
	const tagged = taggedName(long, "[{percent}% OFF]", "prefix", 30);
	assert.ok(tagged.length <= 50, tagged);
	assert.ok(tagged.startsWith("[30% OFF] "));
	assert.equal(taggedName("[30% OFF] VIP", "[{percent}% OFF]", "prefix", 30), "[30% OFF] VIP");
	assert.equal(taggedName("VIP", "SALE!", "suffix", 30), "VIP SALE!");
});

test("several games can each use their own API key and update time", () => {
	const configs = parseConfigs({
		updateAt: "2026-11-01T17:00:00Z",
		sale: { percentOff: 25, durationHours: 1, gamePasses: "all", developerProducts: "all" },
		games: [
			{ universeId: 1, name: "One" },
			{ universeId: 2, name: "Two", apiKeyEnv: "GROUP_KEY", updateAt: "2026-11-02T17:00:00Z", sale: false },
		],
	}, tmpdir());
	assert.equal(configs[0].apiKeyEnv, "UPDATEDAY_API_KEY");
	assert.equal(configs[1].apiKeyEnv, "GROUP_KEY");
	assert.equal(configs[1].updateAt, "2026-11-02T17:00:00Z");
	assert.equal(configs[1].sale, undefined);
	assert.notEqual(configs[0].statePath, configs[1].statePath);
	assert.throws(() => parseConfigs({ updateAt: "2026-11-01T17:00:00Z", games: [{ universeId: 1 }, { universeId: 1 }] }, tmpdir()), /twice/);
});

test("alerts default to the useful events, and only real Discord webhooks are accepted", () => {
	const config = parseConfigs(plan({ notify: {} }), tmpdir())[0];
	assert.deepEqual(config.notify?.events, ["reminders", "failures", "live", "finished"]);
	assert.equal(config.notify?.discordWebhookEnv, "UPDATEDAY_DISCORD_WEBHOOK");
	assert.ok(isWebhookUrl("https://discord.com/api/webhooks/123/abc_DEF-1"));
	assert.ok(isWebhookUrl("https://canary.discord.com/api/webhooks/1/x"));
	assert.ok(!isWebhookUrl("https://discord.com.evil.io/api/webhooks/1/x"));
	assert.ok(!isWebhookUrl("http://discord.com/api/webhooks/1/x"));
	assert.ok(!isWebhookUrl("https://example.com/hook"));
});

test("history lines are sorted into the right kinds", () => {
	assert.equal(kindOf("RUN  Sale starts (30% off)"), "step");
	assert.equal(kindOf("SKIP In-game warning (10m): too late to warn players"), "skip");
	assert.equal(kindOf("REMINDER Game: upload the 1H countdown icon in Creator Hub now: x.png"), "reminder");
	assert.equal(kindOf("FAILED Sale starts: price failed (500)"), "error");
	assert.equal(kindOf("  2x Power: 100 -> 70"), "sale");
	assert.equal(kindOf("  VIP: restored 499"), "sale");
});

test("plan patches merge objects, replace lists and remove keys with null", () => {
	const before = { updateAt: "a", sale: { percentOff: 30, gamePasses: [1, 2] }, event: { title: "x" } };
	const after = mergePatch(before, { sale: { percentOff: 40, gamePasses: [3] }, event: null });
	assert.deepEqual(after, { updateAt: "a", sale: { percentOff: 40, gamePasses: [3] } });
	assert.deepEqual(before.sale.gamePasses, [1, 2], "the original isn't changed");
});

test("zip files are well formed", () => {
	assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
	const archive = zip([{ name: "a.txt", data: Buffer.from("hello") }, { name: "folder/b.png", data: Buffer.alloc(10, 7) }]);
	const end = archive.length - 22;
	assert.equal(archive.readUInt32LE(end), 0x06054b50);
	assert.equal(archive.readUInt16LE(end + 10), 2);
	const directoryAt = archive.readUInt32LE(end + 16);
	assert.equal(archive.readUInt32LE(directoryAt), 0x02014b50);
	assert.equal(archive.readUInt32LE(0), 0x04034b50);
});

test("the local server refuses other websites, other drives and files outside the plan folder", async () => {
	const dir = mkdtempSync(join(tmpdir(), "updateday-security-"));
	const outside = mkdtempSync(join(tmpdir(), "updateday-outside-"));
	writeFileSync(join(outside, "secret.png"), "not really a png");
	writeFileSync(join(dir, "inside.png"), "fine");
	const configPath = join(dir, "updateday.json");
	writeFileSync(configPath, JSON.stringify(plan()));
	const port = 47000 + Math.floor(Math.random() * 1000);
	const original = console.log;
	console.log = () => {};
	const server = await startServer(configPath, port);
	const url = server.url;
	console.log = original;
	const get = (path: string, headers: Record<string, string> = {}) => fetch(url + path.replace(/^\//, ""), { headers });
	assert.equal((await get("api/file?path=inside.png")).status, 200);
	assert.equal((await get(`api/file?path=${encodeURIComponent(join(outside, "secret.png"))}`)).status, 404, "absolute path elsewhere");
	assert.equal((await get(`api/file?path=${encodeURIComponent("../" + outside.split(/[\\/]/).pop() + "/secret.png")}`)).status, 404, "relative escape");
	assert.equal((await get("api/file?path=updateday.json")).status, 404, "only images");
	assert.equal((await get("api/draft", { origin: "https://evil.example" })).status, 403, "other websites");
	const key = await fetch(url + "api/key", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ env: "UPDATEDAY_DISCORD_WEBHOOK", value: "https://evil.example/steal", kind: "webhook" }) });
	assert.equal(key.status, 400, "webhook must be a Discord link");
	const art = await fetch(url + "api/art?mark=..%2F..%2Fevil", { method: "POST", body: "x" });
	assert.equal(art.status, 400, "art names are stage names only");
	await server.close();
});

test("every hourglass style renders, own stage text is used, and unknown styles are refused", async () => {
	const sharp = (await import("sharp")).default;
	const { renderIcon, HOURGLASS_STYLES } = await import("../src/icons.ts");
	const base = await sharp({ create: { width: 512, height: 512, channels: 4, background: "#2266aa" } }).png().toBuffer();
	for (const style of HOURGLASS_STYLES) {
		const countdown = parseConfigs(plan({ countdown: { style, labels: { "6h": "6 HRS!" } } }), tmpdir())[0].countdown!;
		const image = await renderIcon(base, "6h", countdown);
		const meta = await sharp(image).metadata();
		assert.equal(meta.width, 512, style);
		assert.equal(meta.height, 512, style);
	}
	assert.throws(() => parseConfigs(plan({ countdown: { style: "sparkly" } }), tmpdir()), /countdown.style must be one of/);
});
