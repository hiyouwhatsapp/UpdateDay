import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { setLogSink } from "./state.ts";

export type HistoryKind = "step" | "skip" | "reminder" | "sale" | "error" | "info";

export type HistoryEntry = {
	at: string;
	game: string;
	universeId: number;
	kind: HistoryKind;
	text: string;
};

const HISTORY_FILE = "updateday-history.jsonl";
const DEFAULT_LIMIT = 500;

export function historyPath(baseDir: string): string {
	return join(baseDir, HISTORY_FILE);
}

export function kindOf(text: string): HistoryKind {
	if (/^(FAILED|ERROR)\b|failed|refused|couldn't/i.test(text)) {
		return "error";
	}
	if (/^RUN\b/.test(text)) {
		return "step";
	}
	if (/^SKIP\b/.test(text)) {
		return "skip";
	}
	if (/^REMINDER\b/.test(text)) {
		return "reminder";
	}
	if (/->|restored|renamed|name restored/.test(text)) {
		return "sale";
	}
	return "info";
}

export function appendHistory(baseDir: string, config: Pick<Config, "name" | "universeId">, text: string): void {
	const clean = text.trim();
	if (!clean) {
		return;
	}
	const entry: HistoryEntry = { at: new Date().toISOString(), game: config.name, universeId: config.universeId, kind: kindOf(clean), text: clean };
	try {
		appendFileSync(historyPath(baseDir), JSON.stringify(entry) + "\n");
	} catch {
	}
}

export async function recording<T>(config: Config, task: () => Promise<T>): Promise<T> {
	setLogSink((message) => appendHistory(config.baseDir, config, message));
	try {
		return await task();
	} finally {
		setLogSink(null);
	}
}

export function readHistory(baseDir: string, universeId?: number, limit = DEFAULT_LIMIT): HistoryEntry[] {
	const path = historyPath(baseDir);
	if (!existsSync(path)) {
		return [];
	}
	const entries: HistoryEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) {
			continue;
		}
		try {
			const entry: HistoryEntry = JSON.parse(line);
			if (universeId === undefined || entry.universeId === universeId) {
				entries.push(entry);
			}
		} catch {
		}
	}
	return entries.slice(-limit).reverse();
}
