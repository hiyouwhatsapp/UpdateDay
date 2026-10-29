import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { iconMarks } from "./bundle.ts";
import { loadConfigs, nextOccurrence, type Config } from "./config.ts";
import { recording } from "./history.ts";
import { fetchCurrentIcon, renderIcon } from "./icons.ts";
import { startMcp } from "./mcp.ts";
import { discordNotifier } from "./notify.ts";
import { preflight, type PreflightReport } from "./preflight.ts";
import { OpenCloud } from "./openCloud.ts";
import { endCountdown, restorePrices, tick, type RunContext } from "./runner.ts";
import { checkKey } from "./doctor.ts";
import { startServer } from "./server.ts";
import { buildSchedule, type Step } from "./schedule.ts";
import { loadState, saveState } from "./state.ts";

const DEFAULT_CONFIG = "updateday.json";
const WATCH_INTERVAL_MS = 30 * 1000;
const PREVIEW_DIR = "preview";
const KEY_COMMANDS = ["tick", "watch", "restore"];
const DEFAULT_UI_PORT = 4747;

const USAGE = `UpdateDay - schedule a Roblox update day with an Open Cloud API key

Usage: updateday <command> [config.json] [--game <name or universeId>] [--dry-run]

Commands:
  ui        Open the setup page in your browser (http://127.0.0.1:4747)
  doctor    Check the API key has every permission this config needs
  plan      Show the full schedule and what has already run
  check     Pre-flight: check the key, times, files, icons, sale items and alerts
  preview   Build every countdown icon from the live game icon into ./preview (no key needed)
  tick      Run every step that is due now, then exit (for cron / GitHub Actions)
  watch     Keep running and tick every 30 seconds until every schedule is done
  restore   Put prices, names and the countdown icon back to normal now
  mcp       Run as an MCP server so AI agents can plan and run update days

A config can hold one game, or several under "games". Commands run for every
game unless --game picks one. The API key is read from UPDATEDAY_API_KEY, or
from the variable a game names in "apiKeyEnv".`;

type Game = {
	config: Config;
	steps: Step[];
	ctx: RunContext;
};

function formatTime(date: Date): string {
	return date.getTime() === 0 ? "immediately" : date.toLocaleString();
}

function header(config: Config, multi: boolean): void {
	if (multi) {
		console.log(`\n=== ${config.name} (${config.universeId}) ===`);
	}
}

function hasDueSteps(game: Game): boolean {
	const now = new Date();
	return game.steps.some((step) => step.at <= now && !game.ctx.state.done[step.id]);
}

function printPlan(game: Game): void {
	console.log(`Update at ${new Date(game.config.updateAt).toLocaleString()}\n`);
	for (const step of game.steps) {
		const status = game.ctx.state.done[step.id] ? "done" : step.at <= game.ctx.now ? "DUE " : "    ";
		console.log(`[${status}] ${formatTime(step.at).padEnd(24)} ${step.label}`);
	}
}

const CHECK_MARKS: Record<string, string> = { ok: "OK  ", warn: "WARN", bad: "FIX ", info: "    " };

function printPreflight(report: PreflightReport): void {
	for (const check of report.checks) {
		console.log(`[${CHECK_MARKS[check.level]}] ${check.title}`);
		if (check.detail) {
			console.log(`       ${check.detail}`);
		}
	}
	console.log(report.ready ? "Ready." : "Fix the lines marked FIX before the update.");
}

async function preview(config: Config, multi: boolean): Promise<void> {
	if (!config.countdown) {
		console.log("Countdown icons are turned off for this game.");
		return;
	}
	const folder = multi ? join(PREVIEW_DIR, config.name.replace(/[^\w-]+/g, "_")) : PREVIEW_DIR;
	const outDir = resolve(config.baseDir, folder);
	mkdirSync(outDir, { recursive: true });
	const base = await fetchCurrentIcon(config.universeId);
	for (const mark of iconMarks(config.countdown)) {
		const path = join(outDir, `${mark}.png`);
		writeFileSync(path, await renderIcon(base, mark, config.countdown));
		console.log(`wrote ${path}`);
	}
}

function webhookFor(config: Config): string | undefined {
	return config.notify ? process.env[config.notify.discordWebhookEnv] : undefined;
}

function makeGame(config: Config, needsKey: boolean): Game {
	const apiKey = process.env[config.apiKeyEnv];
	if (needsKey && !apiKey) {
		throw new Error(`${config.name}: set ${config.apiKeyEnv} to an Open Cloud API key for this game`);
	}
	const ctx: RunContext = {
		config,
		state: loadState(config.statePath, config.updateAt),
		cloud: apiKey ? new OpenCloud(apiKey, config.universeId) : null,
		now: new Date(),
		notify: discordNotifier(config, webhookFor(config)),
	};
	return { config, steps: buildSchedule(config), ctx };
}

function pickGames(configs: Config[], filter: string | undefined): Config[] {
	if (!filter) {
		return configs;
	}
	const picked = configs.filter((config) => config.name === filter || String(config.universeId) === filter);
	if (picked.length === 0) {
		throw new Error(`No game named "${filter}" in this config`);
	}
	return picked;
}

async function tickGame(game: Game, dryRun: boolean): Promise<number> {
	try {
		game.ctx.now = new Date();
		const run = () => tick(game.steps, game.ctx, dryRun);
		return dryRun ? await run() : await recording(game.config, run);
	} catch (error) {
		console.error(`${game.config.name}: ${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
		return -1;
	}
}

async function watch(load: () => Config[], multi: boolean): Promise<void> {
	const finished = new Set<string>();
	while (true) {
		let waiting = 0;
		for (const config of load()) {
			const id = `${config.universeId}|${config.updateAt}`;
			if (finished.has(id)) {
				waiting += nextOccurrence(config) ? 1 : 0;
				continue;
			}
			const game = makeGame(config, true);
			header(game.config, multi && hasDueSteps(game));
			const remaining = await tickGame(game, false);
			if (remaining !== 0) {
				waiting++;
				continue;
			}
			finished.add(id);
			const next = nextOccurrence(config);
			console.log(next ? `${config.name}: done. Next update day ${next.toLocaleString()}.` : `${config.name}: schedule complete.`);
			waiting += next ? 1 : 0;
		}
		if (waiting === 0) {
			return;
		}
		await new Promise((done) => setTimeout(done, WATCH_INTERVAL_MS));
	}
}

const DOCTOR_MARKS: Record<string, string> = { ok: "OK  ", missing: "MISS", error: "ERR ", untested: "--  " };

async function printDoctor(game: Game): Promise<void> {
	const probes = await checkKey(game.ctx.cloud!, game.config);
	for (const probe of probes) {
		const flag = probe.used ? "" : " (not used by this config)";
		console.log(`[${DOCTOR_MARKS[probe.status]}] ${probe.feature.padEnd(26)} ${probe.permission}${flag}`);
		if (probe.detail && probe.status !== "ok") {
			console.log(`       ${probe.detail}`);
		}
	}
	const blocking = probes.filter((probe) => probe.used && (probe.status === "missing" || probe.status === "error"));
	if (blocking.length > 0) {
		process.exitCode = 1;
	}
}

function readFlag(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
	return args.filter((arg, index) => !arg.startsWith("--") && !["--game", "--port"].includes(args[index - 1]));
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const [command, configPath = DEFAULT_CONFIG] = positional(args);
	if (!command || command === "help") {
		console.log(USAGE);
		return;
	}
	if (command === "mcp") {
		await startMcp(configPath);
		return;
	}
	if (command === "ui") {
		const port = Number(readFlag(args, "--port")) || DEFAULT_UI_PORT;
		const { url } = await startServer(configPath, port);
		console.log(`UpdateDay is open at ${url}  (Ctrl+C to quit)`);
		return;
	}
	const allConfigs = loadConfigs(configPath);
	const configs = pickGames(allConfigs, readFlag(args, "--game"));
	const multi = allConfigs.length > 1;
	const needsKey = !dryRun && [...KEY_COMMANDS, "doctor"].includes(command);
	if (command === "check") {
		let ok = true;
		for (const config of configs) {
			header(config, multi);
			const apiKey = process.env[config.apiKeyEnv];
			const report = await preflight(config, apiKey ? new OpenCloud(apiKey, config.universeId) : null, webhookFor(config));
			printPreflight(report);
			ok = report.ready && ok;
		}
		process.exitCode = ok ? 0 : 1;
		return;
	}
	if (command === "preview") {
		for (const config of configs) {
			header(config, multi);
			await preview(config, multi);
		}
		return;
	}
	const games = configs.map((config) => makeGame(config, needsKey));
	switch (command) {
		case "doctor":
			for (const game of games) {
				header(game.config, multi);
				await printDoctor(game);
			}
			return;
		case "plan":
			for (const game of games) {
				header(game.config, multi);
				printPlan(game);
			}
			return;
		case "tick":
			for (const game of games) {
				header(game.config, multi);
				await tickGame(game, dryRun);
			}
			return;
		case "watch":
			await watch(() => pickGames(loadConfigs(configPath), readFlag(args, "--game")), multi);
			return;
		case "restore":
			for (const game of games) {
				header(game.config, multi);
				await recording(game.config, async () => {
					await restorePrices(game.ctx);
					await endCountdown(game.ctx);
				});
				saveState(game.config.statePath, game.ctx.state);
			}
			return;
		default:
			console.log(USAGE);
			process.exitCode = 1;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
