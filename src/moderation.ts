import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { iconMarks } from "./bundle.ts";
import { renderIcon } from "./icons.ts";
import type { OpenCloud } from "./openCloud.ts";

export type ModerationState = "Approved" | "Reviewing" | "Rejected" | "unchecked" | "unknown";

type Entry = {
	design: string;
	assetId: number;
	state: ModerationState;
	checkedAt: string;
};

type Ledger = Record<string, Entry>;

export type StageModeration = {
	mark: string;
	state: ModerationState;
	assetId: number | null;
	checkedAt: string | null;
};

const LEDGER_SUFFIX = ".moderation.json";
const FINAL_MARK = "final";

function ledgerPath(config: Config): string {
	return config.statePath.replace(/\.state\.json$/, "") + LEDGER_SUFFIX;
}

function readLedger(config: Config): Ledger {
	const path = ledgerPath(config);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function writeLedger(config: Config, ledger: Ledger): void {
	writeFileSync(ledgerPath(config), JSON.stringify(ledger, null, "\t"));
}

function artStamp(config: Config, mark: string): string {
	const dir = config.countdown?.overlayDir;
	if (!dir) {
		return "";
	}
	return [mark, "default"].map((name) => {
		const path = join(dir, `${name}.png`);
		return existsSync(path) ? String(statSync(path).mtimeMs) : "";
	}).join("|");
}

export function designKey(config: Config, base: Buffer, mark: string): string {
	const hash = createHash("sha1");
	hash.update(base);
	hash.update(JSON.stringify(config.countdown));
	hash.update(mark);
	hash.update(artStamp(config, mark));
	return hash.digest("hex");
}

function checkedMarks(config: Config): string[] {
	const marks = iconMarks(config.countdown!);
	return config.countdown?.newIcon ? marks : marks.filter((mark) => mark !== FINAL_MARK);
}

async function readState(cloud: OpenCloud, assetId: number): Promise<ModerationState> {
	const asset = await cloud.request("GET", `/assets/v1/assets/${assetId}?readMask=moderationResult`, "read asset");
	const state = String(asset?.moderationResult?.moderationState ?? "unknown");
	return (["Approved", "Reviewing", "Rejected"].includes(state) ? state : "unknown") as ModerationState;
}

export async function moderationStatus(config: Config, cloud: OpenCloud | null, base: Buffer): Promise<StageModeration[]> {
	if (!config.countdown) {
		return [];
	}
	const ledger = readLedger(config);
	let changed = false;
	const result: StageModeration[] = [];
	for (const mark of checkedMarks(config)) {
		const entry = ledger[mark];
		if (!entry || entry.design !== designKey(config, base, mark)) {
			result.push({ mark, state: "unchecked", assetId: null, checkedAt: null });
			continue;
		}
		if (cloud && (entry.state === "Reviewing" || entry.state === "unknown")) {
			entry.state = await readState(cloud, entry.assetId);
			entry.checkedAt = new Date().toISOString();
			changed = true;
		}
		result.push({ mark, state: entry.state, assetId: entry.assetId, checkedAt: entry.checkedAt });
	}
	if (changed) {
		writeLedger(config, ledger);
	}
	return result;
}

export async function submitForModeration(config: Config, cloud: OpenCloud, base: Buffer): Promise<number> {
	const ledger = readLedger(config);
	let sent = 0;
	for (const mark of checkedMarks(config)) {
		const design = designKey(config, base, mark);
		const entry = ledger[mark];
		if (entry && entry.design === design && entry.state !== "Rejected") {
			continue;
		}
		const image = await renderIcon(base, mark, config.countdown!);
		const assetId = await cloud.uploadImage(new Blob([new Uint8Array(image)], { type: "image/png" }), `UpdateDay ${config.name} ${mark}`);
		ledger[mark] = { design, assetId, state: "Reviewing", checkedAt: new Date().toISOString() };
		writeLedger(config, ledger);
		sent++;
	}
	return sent;
}
