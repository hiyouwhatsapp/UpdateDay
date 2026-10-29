import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SwapState } from "./swap.ts";

export type SavedPrice = {
	kind: "gamePass" | "developerProduct";
	id: number;
	name: string;
	originalPrice: number;
	salePrice: number;
	restored: boolean;
	taggedName?: string;
	nameRestored?: boolean;
};

export type State = {
	updateAt: string;
	done: Record<string, string>;
	prices: SavedPrice[];
	eventId?: string;
	swap?: SwapState;
	reminders?: string[];
	notified?: { live?: string; finished?: string };
	title?: { original: string; restored: boolean };
	log: string[];
};

let logSink: ((message: string) => void) | null = null;

export function setLogSink(sink: ((message: string) => void) | null): void {
	logSink = sink;
}

export function loadState(path: string, updateAt: string): State {
	if (existsSync(path)) {
		const state: State = JSON.parse(readFileSync(path, "utf8"));
		if (state.updateAt === updateAt) {
			return state;
		}
		const swapOpen = state.swap?.swapped && !state.swap.finished;
		if (swapOpen || state.prices.some((price) => !price.restored || (price.taggedName && !price.nameRestored))) {
			throw new Error(`State file ${path} is from a different update and still has unrestored sale prices. Run "restore" first.`);
		}
	}
	return { updateAt, done: {}, prices: [], log: [] };
}

export function saveState(path: string, state: State): void {
	const temp = `${path}.tmp`;
	writeFileSync(temp, JSON.stringify(state, null, "\t"));
	renameSync(temp, path);
}

export function logLine(state: State, message: string): void {
	const line = `${new Date().toISOString()}  ${message}`;
	state.log.push(line);
	console.log(line);
	logSink?.(message);
}
