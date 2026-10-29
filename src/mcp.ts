import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";
import { nextOccurrence, parseConfigs, type Config } from "./config.ts";
import { readHistory, recording } from "./history.ts";
import { fetchCurrentIcon, ICON_SIZE, renderIcon } from "./icons.ts";
import { discordNotifier } from "./notify.ts";
import { OpenCloud } from "./openCloud.ts";
import { preflight } from "./preflight.ts";
import { endCountdown, restorePrices, tick, type RunContext } from "./runner.ts";
import { buildSchedule } from "./schedule.ts";
import { loadState, saveState } from "./state.ts";

const SERVER_INFO = { name: "updateday", version: "0.2.1" };
const DEFAULT_PROTOCOL = "2025-06-18";
const HISTORY_LIMIT = 50;

type ToolResult = { content: object[]; isError?: boolean };

type Tool = {
	name: string;
	description: string;
	inputSchema: object;
	run: (args: any) => Promise<ToolResult>;
};

const GAME_ARG = { type: "string", description: "Game name or universe ID. Leave out for every game." };
const CONFIRM_ARG = { type: "boolean", description: "Must be true. This changes the live game." };

function text(value: unknown): ToolResult {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergePatch(target: unknown, patch: unknown): unknown {
	if (!isPlainObject(patch)) {
		return patch;
	}
	const result: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key];
		} else {
			result[key] = mergePatch(result[key], value);
		}
	}
	return result;
}

class Planner {
	path: string;
	baseDir: string;

	constructor(configPath: string) {
		this.path = resolve(configPath);
		this.baseDir = dirname(this.path);
	}

	raw(): any {
		return JSON.parse(readFileSync(this.path, "utf8"));
	}

	configs(filter?: string): Config[] {
		const all = parseConfigs(this.raw(), this.baseDir);
		if (!filter) {
			return all;
		}
		const picked = all.filter((config) => config.name === filter || String(config.universeId) === String(filter));
		if (!picked.length) {
			throw new Error(`No game called "${filter}". Games: ${all.map((config) => `${config.name} (${config.universeId})`).join(", ")}`);
		}
		return picked;
	}

	write(raw: any): Config[] {
		const configs = parseConfigs(raw, this.baseDir);
		writeFileSync(this.path, JSON.stringify(raw, null, "\t"));
		return configs;
	}

	context(config: Config): RunContext {
		const apiKey = process.env[config.apiKeyEnv];
		const webhook = config.notify ? process.env[config.notify.discordWebhookEnv] : undefined;
		return {
			config,
			state: loadState(config.statePath, config.updateAt),
			cloud: apiKey ? new OpenCloud(apiKey, config.universeId) : null,
			now: new Date(),
			notify: discordNotifier(config, webhook),
		};
	}
}

function summary(config: Config): object {
	return {
		name: config.name,
		universeId: config.universeId,
		updateAt: config.updateAt,
		nextUpdateAt: nextOccurrence(config)?.toISOString() ?? null,
		countdown: config.countdown ? { method: config.countdown.iconMethod, skipped: config.countdown.skip } : false,
		sale: config.sale ? { percentOff: config.sale.percentOff } : false,
		event: Boolean(config.event),
		warnings: Boolean(config.broadcast),
		restartServers: Boolean(config.restartServers),
		alerts: config.notify ? config.notify.events : false,
		hasApiKey: Boolean(process.env[config.apiKeyEnv]),
	};
}

async function captured(task: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const original = { log: console.log, error: console.error };
	console.log = (...args: unknown[]) => {
		lines.push(args.join(" "));
		process.stderr.write(`${args.join(" ")}\n`);
	};
	console.error = (...args: unknown[]) => {
		lines.push(`ERROR ${args.join(" ")}`);
		process.stderr.write(`${args.join(" ")}\n`);
	};
	try {
		await task();
	} catch (error) {
		lines.push(`ERROR ${error instanceof Error ? error.message : error}`);
	} finally {
		console.log = original.log;
		console.error = original.error;
	}
	return lines;
}

function tools(planner: Planner): Tool[] {
	return [
		{
			name: "get_plan",
			description: "Read the UpdateDay plan: the raw config file and a summary of every game (update time, countdown, sale, event, alerts).",
			inputSchema: { type: "object", properties: {} },
			run: async () => text({ file: planner.path, config: planner.raw(), games: planner.configs().map(summary) }),
		},
		{
			name: "change_plan",
			description: "Change the plan with a JSON merge patch (RFC 7396): objects merge, arrays and values replace, null removes a key. Example: {\"updateAt\":\"2026-11-07T18:00:00Z\",\"sale\":{\"percentOff\":40}}. The result is checked before it's saved.",
			inputSchema: { type: "object", properties: { patch: { type: "object" } }, required: ["patch"] },
			run: async ({ patch }) => {
				const next = mergePatch(planner.raw(), patch);
				const configs = planner.write(next);
				return text({ saved: true, games: configs.map(summary) });
			},
		},
		{
			name: "get_schedule",
			description: "List every step of the update day in order, with its time and whether it already ran.",
			inputSchema: { type: "object", properties: { game: GAME_ARG } },
			run: async ({ game }) => text(planner.configs(game).map((config) => {
				const state = loadState(config.statePath, config.updateAt);
				return {
					game: config.name,
					steps: buildSchedule(config).map((step) => ({ at: step.at.getTime() === 0 ? "right away" : step.at.toISOString(), label: step.label, done: state.done[step.id] ?? null })),
				};
			})),
		},
		{
			name: "check_plan",
			description: "Pre-flight check: API key permissions, times, files, countdown icons, sale items and alerts. Lines with level \"bad\" must be fixed.",
			inputSchema: { type: "object", properties: { game: GAME_ARG } },
			run: async ({ game }) => {
				const reports = [];
				for (const config of planner.configs(game)) {
					const ctx = planner.context(config);
					reports.push(await preflight(config, ctx.cloud, config.notify ? process.env[config.notify.discordWebhookEnv] : undefined));
				}
				return text(reports);
			},
		},
		{
			name: "preview_icon",
			description: "Render one countdown icon as players would see it. Stage is e.g. 24h, 1h, 5m, now or final.",
			inputSchema: { type: "object", properties: { game: GAME_ARG, stage: { type: "string" } }, required: ["stage"] },
			run: async ({ game, stage }) => {
				const config = planner.configs(game)[0];
				if (!config.countdown) {
					return failure(`${config.name} has countdown icons turned off`);
				}
				const base = await sharp(await fetchCurrentIcon(config.universeId)).resize(ICON_SIZE, ICON_SIZE).png().toBuffer();
				const image = await renderIcon(base, stage, config.countdown);
				return { content: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] };
			},
		},
		{
			name: "run_due_steps",
			description: "Run every step that is due now, like one check of a running UpdateDay. Defaults to a dry run that only reports. Set dry_run false and confirm true to really do it.",
			inputSchema: { type: "object", properties: { game: GAME_ARG, dry_run: { type: "boolean", default: true }, confirm: CONFIRM_ARG } },
			run: async ({ game, dry_run = true, confirm = false }) => {
				if (!dry_run && confirm !== true) {
					return failure("This changes the live game. Call again with confirm: true.");
				}
				const lines = await captured(async () => {
					for (const config of planner.configs(game)) {
						const ctx = planner.context(config);
						if (!dry_run && !ctx.cloud) {
							throw new Error(`${config.name}: set ${config.apiKeyEnv} to an Open Cloud API key`);
						}
						const run = () => tick(buildSchedule(config), ctx, dry_run);
						const left = dry_run ? await run() : await recording(config, run);
						console.log(`${config.name}: ${left} step${left === 1 ? "" : "s"} left`);
					}
				});
				return text(lines.join("\n") || "Nothing is due right now.");
			},
		},
		{
			name: "restore_everything",
			description: "Undo: put every saved price and name back and end the countdown icons. Use when an update is cancelled.",
			inputSchema: { type: "object", properties: { game: GAME_ARG, confirm: CONFIRM_ARG }, required: ["confirm"] },
			run: async ({ game, confirm }) => {
				if (confirm !== true) {
					return failure("This changes the live game. Call again with confirm: true.");
				}
				const lines = await captured(async () => {
					for (const config of planner.configs(game)) {
						const ctx = planner.context(config);
						await recording(config, async () => {
							await restorePrices(ctx);
							await endCountdown(ctx);
						});
						saveState(config.statePath, ctx.state);
					}
				});
				return text(lines.join("\n") || "Nothing needed restoring.");
			},
		},
		{
			name: "get_history",
			description: "What UpdateDay did and when, newest first.",
			inputSchema: { type: "object", properties: { game: GAME_ARG, limit: { type: "number", default: HISTORY_LIMIT } } },
			run: async ({ game, limit = HISTORY_LIMIT }) => {
				const universeId = game ? planner.configs(game)[0].universeId : undefined;
				return text(readHistory(planner.baseDir, universeId, limit));
			},
		},
		{
			name: "list_sale_items",
			description: "List a game's passes and developer products with prices, to choose what goes on sale.",
			inputSchema: { type: "object", properties: { game: GAME_ARG } },
			run: async ({ game }) => {
				const config = planner.configs(game)[0];
				const ctx = planner.context(config);
				if (!ctx.cloud) {
					return failure(`Set ${config.apiKeyEnv} to an Open Cloud API key`);
				}
				return text([...(await ctx.cloud.listItems("gamePass")), ...(await ctx.cloud.listItems("developerProduct"))]);
			},
		},
	];
}

function reply(id: unknown, result: unknown): void {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id: unknown, code: number, message: string): void {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

export async function handleMessage(list: Tool[], message: any): Promise<void> {
	const { id, method, params } = message;
	if (id === undefined) {
		return;
	}
	if (method === "initialize") {
		reply(id, { protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
		return;
	}
	if (method === "ping") {
		reply(id, {});
		return;
	}
	if (method === "tools/list") {
		reply(id, { tools: list.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
		return;
	}
	if (method === "tools/call") {
		const tool = list.find((item) => item.name === params?.name);
		if (!tool) {
			replyError(id, -32602, `Unknown tool ${params?.name}`);
			return;
		}
		try {
			reply(id, await tool.run(params.arguments ?? {}));
		} catch (error) {
			reply(id, failure(error instanceof Error ? error.message : String(error)));
		}
		return;
	}
	replyError(id, -32601, `Unknown method ${method}`);
}

export function startMcp(configPath: string): Promise<void> {
	console.log = (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`);
	const list = tools(new Planner(configPath));
	const input = createInterface({ input: process.stdin });
	let queue = Promise.resolve();
	input.on("line", (line) => {
		if (!line.trim()) {
			return;
		}
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			replyError(null, -32700, "Parse error");
			return;
		}
		queue = queue.then(() => handleMessage(list, message));
	});
	return new Promise((done) => input.on("close", () => queue.then(done)));
}
