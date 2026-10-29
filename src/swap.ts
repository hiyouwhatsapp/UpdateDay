import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OpenCloudError, type OpenCloud } from "./openCloud.ts";
import { logLine, saveState, type State } from "./state.ts";

const PUBLIC_I18N = "https://gameinternationalization.roblox.com/v1";
const TEMP_PREFERENCE = ["th", "vi", "pl", "id", "tr", "it", "ko", "ja", "fr", "de", "pt", "ru", "es", "zh-hant", "zh-hans"];
const UPLOAD_GAP_MS = 250;
const UPLOAD_CONCURRENCY = 4;
const APPROVAL_POLL_MS = 5000;
const APPROVAL_MAX_MS = 150 * 1000;
const SETTLE_POLLS = 20;
const SETTLE_POLL_MS = 3000;

export type SwapState = {
	originalSource: string;
	temp: string;
	languages: string[];
	savedIcons: Record<string, string>;
	swapped: boolean;
	removed: string[];
	restoredSaved: string[];
	finished: boolean;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publicJson(path: string): Promise<any> {
	const response = await fetch(PUBLIC_I18N + path);
	if (!response.ok) {
		throw new Error(`Couldn't read ${path} (${response.status})`);
	}
	return response.json();
}

export async function sourceLanguage(universeId: number): Promise<string> {
	return String((await publicJson(`/source-language/games/${universeId}`)).languageCode);
}

export async function supportedLanguages(universeId: number): Promise<string[]> {
	const json = await publicJson(`/supported-languages/games/${universeId}`);
	return (json?.data ?? []).map((item: any) => String(item.languageCode)).filter(Boolean);
}

export function pickTemp(source: string, supported: string[], preferred?: string): string {
	if (preferred) {
		if (preferred === source) {
			throw new Error(`swapLanguage can't be the game's source language (${source})`);
		}
		return preferred;
	}
	const candidates = supported.filter((code) => code !== source);
	const ranked = TEMP_PREFERENCE.find((code) => candidates.includes(code));
	if (!ranked && candidates.length === 0) {
		throw new Error("The game supports only one language; add one in Creator Hub (Localization) so the countdown can use the language swap");
	}
	return ranked ?? candidates[candidates.length - 1];
}

async function waitForSource(universeId: number, expected: string): Promise<boolean> {
	for (let attempt = 0; attempt < SETTLE_POLLS; attempt++) {
		if ((await sourceLanguage(universeId).catch(() => "")) === expected) {
			return true;
		}
		await sleep(SETTLE_POLL_MS);
	}
	return false;
}

async function saveExistingIcons(cloud: OpenCloud, source: string, folder: string): Promise<Record<string, string>> {
	const saved: Record<string, string> = {};
	const list = await cloud.listIcons();
	for (const icon of list?.data ?? []) {
		if (icon.languageCode === source || !icon.imageUrl) {
			continue;
		}
		const response = await fetch(icon.imageUrl);
		if (!response.ok) {
			throw new Error(`Couldn't save the existing ${icon.languageCode} icon before the swap`);
		}
		mkdirSync(folder, { recursive: true });
		const file = join(folder, `${icon.languageCode}.png`);
		writeFileSync(file, Buffer.from(await response.arrayBuffer()));
		saved[icon.languageCode] = file;
	}
	return saved;
}

export async function startSwap(cloud: OpenCloud, state: State, statePath: string, preferredTemp?: string): Promise<SwapState> {
	if (state.swap?.swapped) {
		return state.swap;
	}
	const originalSource = await sourceLanguage(cloud.universeId);
	const supported = await supportedLanguages(cloud.universeId);
	const temp = pickTemp(originalSource, supported, preferredTemp);
	const languages = [originalSource, ...supported.filter((code) => code !== originalSource && code !== temp)];
	const folder = join(dirname(statePath), "updateday-saved-icons", String(cloud.universeId));
	const savedIcons = await saveExistingIcons(cloud, originalSource, folder);
	state.swap = { originalSource, temp, languages, savedIcons, swapped: false, removed: [], restoredSaved: [], finished: false };
	saveState(statePath, state);
	await cloud.setSourceLanguage(temp);
	state.swap.swapped = true;
	saveState(statePath, state);
	logLine(state, `  source language ${originalSource} -> ${temp}; icons go to ${languages.length} languages`);
	if (!(await waitForSource(cloud.universeId, temp))) {
		logLine(state, `  warning: Roblox still reports the old source language`);
	}
	return state.swap;
}

export type ImageFor = (languageCode: string) => Promise<Blob>;

async function uploadOne(cloud: OpenCloud, code: string, imageFor: ImageFor): Promise<boolean> {
	try {
		await cloud.setIcon(await imageFor(code), code);
		return true;
	} catch {
		return false;
	}
}

async function waitForApproval(cloud: OpenCloud, codes: string[]): Promise<Record<string, string>> {
	const started = Date.now();
	let states: Record<string, string> = {};
	while (Date.now() - started < APPROVAL_MAX_MS) {
		states = {};
		for (const icon of (await cloud.listIcons().catch(() => null))?.data ?? []) {
			states[icon.languageCode] = icon.state;
		}
		if (codes.every((code) => states[code] === "Approved" || states[code] === "Rejected")) {
			break;
		}
		await sleep(APPROVAL_POLL_MS);
	}
	return states;
}

export async function uploadAll(cloud: OpenCloud, state: State, imageFor: ImageFor): Promise<void> {
	const swap = state.swap!;
	const started = Date.now();
	const failed: string[] = [];
	const queue = [...swap.languages];
	const worker = async () => {
		for (let code = queue.shift(); code; code = queue.shift()) {
			if (!(await uploadOne(cloud, code, imageFor))) {
				failed.push(code);
			}
			await sleep(UPLOAD_GAP_MS);
		}
	};
	await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
	if (failed.includes(swap.originalSource) && !(await uploadOne(cloud, swap.originalSource, imageFor))) {
		throw new Error(`Couldn't set the ${swap.originalSource} countdown icon`);
	}
	if (failed.length > 0) {
		logLine(state, `  icon not set for: ${failed.filter((code) => code !== swap.originalSource).join(", ")}`);
	}
	const uploaded = swap.languages.filter((code) => !failed.includes(code) || code === swap.originalSource);
	const states = await waitForApproval(cloud, uploaded);
	const seconds = Math.round((Date.now() - started) / 1000);
	const rejected = uploaded.filter((code) => states[code] === "Rejected");
	const pending = uploaded.filter((code) => states[code] !== "Approved" && states[code] !== "Rejected");
	if (rejected.length > 0) {
		logLine(state, `  Roblox REJECTED the icon for: ${rejected.join(", ")}`);
	}
	if (pending.length > 0) {
		logLine(state, `  still in review after ${seconds}s for: ${pending.join(", ")}; raise uploadLeadSeconds`);
	} else {
		logLine(state, `  icons approved ${seconds}s after upload started`);
	}
}

async function deleteIcon(cloud: OpenCloud, code: string): Promise<void> {
	try {
		await cloud.deleteIcon(code);
	} catch (error) {
		if (!(error instanceof OpenCloudError && error.status === 404)) {
			throw error;
		}
	}
}

export async function finishSwap(cloud: OpenCloud, state: State, statePath: string): Promise<void> {
	const swap = state.swap;
	if (!swap || swap.finished) {
		return;
	}
	if (swap.swapped) {
		for (const code of swap.languages) {
			if (swap.removed.includes(code)) {
				continue;
			}
			await deleteIcon(cloud, code);
			swap.removed.push(code);
			saveState(statePath, state);
			await sleep(UPLOAD_GAP_MS);
		}
		for (const [code, file] of Object.entries(swap.savedIcons)) {
			if (swap.restoredSaved.includes(code) || !existsSync(file)) {
				continue;
			}
			await cloud.setIcon(new Blob([new Uint8Array(readFileSync(file))], { type: "image/png" }), code);
			swap.restoredSaved.push(code);
			saveState(statePath, state);
		}
		await cloud.setSourceLanguage(swap.originalSource);
		if (!(await waitForSource(cloud.universeId, swap.originalSource))) {
			throw new Error(`Source language didn't switch back to ${swap.originalSource}; run restore again`);
		}
		const leftover = ((await cloud.listIcons())?.data ?? []).filter((icon: any) => icon.languageCode !== swap.originalSource && swap.languages.includes(icon.languageCode) && !swap.savedIcons[icon.languageCode]);
		if (leftover.length > 0) {
			throw new Error(`Countdown icons still set for: ${leftover.map((icon: any) => icon.languageCode).join(", ")}`);
		}
	}
	swap.finished = true;
	saveState(statePath, state);
	logLine(state, `  source language back to ${swap.originalSource}; countdown icons removed`);
}
