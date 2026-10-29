import { OpenCloud } from "./openCloud.ts";

const PUBLIC_I18N = "https://gameinternationalization.roblox.com";

export type SwapOptions = {
	cloud: OpenCloud;
	universeId: number;
	icon: Blob;
	holdMs: number;
	approvalWaitMs: number;
	swapTo: string;
	log: (line: string) => void;
	shouldStop: () => boolean;
};

async function publicJson(path: string): Promise<unknown> {
	const response = await fetch(PUBLIC_I18N + path);
	return response.ok ? response.json() : { status: response.status, body: await response.text() };
}

async function snapshot(universeId: number): Promise<Record<string, unknown>> {
	return {
		source: await publicJson(`/v1/source-language/games/${universeId}`),
		supported: await publicJson(`/v2/supported-languages/games/${universeId}`),
		nameDescription: await publicJson(`/v1/name-description/games/${universeId}`),
	};
}

async function publicIcon(universeId: number): Promise<unknown> {
	const response = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png`);
	return response.ok ? response.json() : response.status;
}

function canonical(value: unknown): string {
	const data = (value as { data?: unknown[] })?.data;
	if (!Array.isArray(data)) {
		return JSON.stringify(value);
	}
	return JSON.stringify(data.map((entry) => JSON.stringify(entry)).sort());
}

function sourceCode(state: Record<string, unknown>): string {
	return String((state.source as { languageCode?: string })?.languageCode ?? "");
}

const APPROVAL_POLL_MS = 10 * 1000;
const SETTLE_POLL_MS = 3 * 1000;
const SETTLE_MAX_MS = 60 * 1000;
const WAITING_STATES = ["PendingReview", "UnAvailable", "missing"];

function iconState(list: any, languageCode: string): string {
	const entry = (list?.data ?? []).find((icon: any) => icon.languageCode === languageCode);
	return entry ? String(entry.state) : "missing";
}

async function waitForApproval(options: SwapOptions, languageCode: string): Promise<string> {
	const started = Date.now();
	let last = "";
	while (Date.now() - started < options.approvalWaitMs && !options.shouldStop()) {
		const state = iconState(await options.cloud.listIcons(), languageCode);
		if (state !== last) {
			options.log(`[swap] ${languageCode} icon is ${state} after ${Math.round((Date.now() - started) / 1000)}s`);
			last = state;
		}
		if (!WAITING_STATES.includes(state)) {
			return state;
		}
		await new Promise((done) => setTimeout(done, APPROVAL_POLL_MS));
	}
	options.log(`[swap] gave up waiting for review after ${Math.round((Date.now() - started) / 1000)}s`);
	return last;
}

async function settledSnapshot(universeId: number, expectedSource: string): Promise<Record<string, unknown>> {
	const started = Date.now();
	let state = await snapshot(universeId);
	while (sourceCode(state) !== expectedSource && Date.now() - started < SETTLE_MAX_MS) {
		await new Promise((done) => setTimeout(done, SETTLE_POLL_MS));
		state = await snapshot(universeId);
	}
	return state;
}

async function hold(options: SwapOptions): Promise<void> {
	for (let waited = 0; waited < options.holdMs && !options.shouldStop(); waited += 1000) {
		await new Promise((done) => setTimeout(done, 1000));
	}
}

export async function languageSwapExperiment(options: SwapOptions): Promise<void> {
	const { cloud, universeId, log } = options;
	const before = await snapshot(universeId);
	const original = sourceCode(before);
	log(`[swap] source language before: ${original}`);
	log(`[swap] icons before: ${JSON.stringify(await cloud.listIcons())}`);
	if (original === options.swapTo) {
		throw new Error(`Source is already ${options.swapTo}; pick another language to swap to`);
	}
	let swapped = false;
	let uploaded = false;
	try {
		await cloud.setSourceLanguage(options.swapTo);
		swapped = true;
		log(`[swap] source language now: ${sourceCode(await snapshot(universeId))}`);
		await cloud.setIcon(options.icon, original);
		uploaded = true;
		log(`[swap] uploaded test icon as the ${original} translation`);
		log(`[swap] icons now: ${JSON.stringify(await cloud.listIcons())}`);
		const state = await waitForApproval(options, original);
		if (state === "Approved") {
			log(`[swap] public icon now: ${JSON.stringify(await publicIcon(universeId))}`);
		}
		log(`[swap] holding ${Math.round(options.holdMs / 1000)}s: look at the game page now`);
		await hold(options);
	} finally {
		if (uploaded) {
			await cloud.deleteIcon(original).then(
				() => log(`[swap] removed the ${original} translation icon`),
				(error) => log(`[swap] FAILED to remove ${original} icon: ${error.message}`),
			);
		}
		if (swapped) {
			await cloud.setSourceLanguage(original).then(
				() => log(`[swap] source language restored to ${original}`),
				(error) => log(`[swap] FAILED to restore source language: ${error.message}`),
			);
		}
		const after = await settledSnapshot(universeId, original);
		log(`[swap] icons after: ${JSON.stringify(await cloud.listIcons().catch((error) => error.message))}`);
		for (const key of Object.keys(before)) {
			const same = canonical(before[key]) === canonical(after[key]);
			log(`[swap] ${key}: ${same ? "unchanged" : `CHANGED\n  before ${JSON.stringify(before[key])}\n  after  ${JSON.stringify(after[key])}`}`);
		}
	}
}

export type ExperimentContext = {
	cloud: OpenCloud;
	universeId: number;
	params: URLSearchParams;
	log: (line: string) => void;
	shouldStop: () => boolean;
};

async function waitMs(ctx: ExperimentContext, ms: number): Promise<void> {
	for (let waited = 0; waited < ms && !ctx.shouldStop(); waited += 1000) {
		await new Promise((done) => setTimeout(done, 1000));
	}
}

export async function nameChange(ctx: ExperimentContext): Promise<void> {
	const { cloud, universeId, log } = ctx;
	const universe = await cloud.request("GET", `/cloud/v2/universes/${universeId}`, "read universe");
	const placeId = Number(String(universe.rootPlace).split("/").pop());
	const placePath = `/cloud/v2/universes/${universeId}/places/${placeId}`;
	const before = await cloud.request("GET", placePath, "read place");
	const translationsBefore = await publicJson(`/v1/name-description/games/${universeId}`);
	log(`[name] universe displayName: ${JSON.stringify(universe.displayName)}`);
	log(`[name] root place ${placeId}: ${JSON.stringify(before.displayName)} / ${JSON.stringify(String(before.description ?? "").slice(0, 60))}`);
	const testName = ctx.params.get("testName") || `[TEST] ${before.displayName}`;
	const testDescription = `${before.description ?? ""}\n\nUpdateDay test ${new Date().toISOString()}`;
	let changed = false;
	try {
		const updated = await cloud.json("PATCH", `${placePath}?updateMask=displayName,description`, "set name", { displayName: testName, description: testDescription });
		changed = true;
		log(`[name] wrote: ${JSON.stringify(updated.displayName)}`);
		const universeAfter = await cloud.request("GET", `/cloud/v2/universes/${universeId}`, "read universe");
		log(`[name] universe displayName now: ${JSON.stringify(universeAfter.displayName)}`);
		log(`[name] translations now: ${JSON.stringify(await publicJson(`/v1/name-description/games/${universeId}`)).slice(0, 200)}`);
		const holdSeconds = Number(ctx.params.get("hold")) || 120;
		log(`[name] holding ${holdSeconds}s: check the game page now`);
		await waitMs(ctx, holdSeconds * 1000);
	} finally {
		if (changed) {
			await cloud.json("PATCH", `${placePath}?updateMask=displayName,description`, "restore name", { displayName: before.displayName, description: before.description ?? "" }).then(
				() => log("[name] restored name and description"),
				(error: Error) => log(`[name] FAILED to restore: ${error.message}`),
			);
		}
		const after = await cloud.request("GET", placePath, "read place");
		const same = after.displayName === before.displayName && (after.description ?? "") === (before.description ?? "");
		log(`[name] place after: ${same ? "matches original" : `DIFFERS ${JSON.stringify(after.displayName)}`}`);
		const translationsAfter = await publicJson(`/v1/name-description/games/${universeId}`);
		log(`[name] translations: ${canonical(translationsBefore) === canonical(translationsAfter) ? "unchanged" : "CHANGED"}`);
	}
}

export async function clearTestDescriptions(ctx: ExperimentContext): Promise<void> {
	const { cloud, universeId, log } = ctx;
	const marker = ctx.params.get("marker") ?? "";
	if (!marker) {
		throw new Error("Pass the marker text that identifies the test descriptions");
	}
	const current = (await publicJson(`/v1/name-description/games/${universeId}`)) as { data?: any[] };
	const targets = (current.data ?? []).filter((entry) => String(entry.description ?? "").includes(marker));
	log(`[clear] ${targets.length} languages carry the test description`);
	if (targets.length === 0) {
		return;
	}
	const data = targets.map((entry) => ({ description: "", updateType: "Description", languageCode: entry.languageCode }));
	await cloud.json("PATCH", `/legacy-game-internationalization/v1/name-description/games/${universeId}`, "clear descriptions", { data });
	await new Promise((done) => setTimeout(done, 3000));
	const after = (await publicJson(`/v1/name-description/games/${universeId}`)) as { data?: any[] };
	const left = (after.data ?? []).filter((entry) => String(entry.description ?? "").includes(marker));
	log(`[clear] languages still carrying it: ${left.length ? left.map((entry) => entry.languageCode).join(", ") : "none"}`);
}

export async function listShapes(ctx: ExperimentContext): Promise<void> {
	const { cloud, universeId, log } = ctx;
	const passes = await cloud.request("GET", `/game-passes/v1/universes/${universeId}/game-passes/creator?pageSize=2`, "list passes");
	log(`[shape] passes keys: ${Object.keys(passes).join(",")}`);
	log(`[shape] pass item: ${JSON.stringify((passes.gamePasses ?? passes.data ?? [])[0])}`);
	const products = await cloud.request("GET", `/developer-products/v2/universes/${universeId}/developer-products/creator?pageSize=2`, "list products");
	log(`[shape] products keys: ${Object.keys(products).join(",")}`);
	log(`[shape] product item: ${JSON.stringify((products.developerProducts ?? products.data ?? [])[0])}`);
}

export async function pageShapes(ctx: ExperimentContext): Promise<void> {
	const { cloud, universeId, log } = ctx;
	const events = await cloud.request("GET", `/virtual-events/v3/universes/${universeId}/game-events`, "list events");
	log(`[page] events keys: ${Object.keys(events ?? {}).join(",")}`);
	log(`[page] event item: ${JSON.stringify((events?.gameEvents ?? events?.data ?? events?.events ?? [])[0]).slice(0, 900)}`);
	const universe = await cloud.request("GET", `/cloud/v2/universes/${universeId}`, "read universe");
	log(`[page] universe: ${JSON.stringify(universe).slice(0, 600)}`);
	log(`[page] thumbnails: ${JSON.stringify(await publicJson(`/v1/game-thumbnails/games/${universeId}/images`)).slice(0, 400)}`);
	const games = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`).then((r) => r.json());
	log(`[page] games api: ${JSON.stringify(games).slice(0, 300)}`);
}

export async function eventCategories(ctx: ExperimentContext): Promise<void> {
	const { cloud, universeId, log } = ctx;
	const list = await cloud.request("GET", `/virtual-events/v3/universes/${universeId}/game-events`, "list events");
	const event = (list?.gameEvents ?? []).find((item: any) => item.title === "UpdateDay events test");
	if (!event) {
		log("[cat] test event not found");
		return;
	}
	log(`[cat] test event ${event.id}, categories now ${JSON.stringify(event.categories)}`);
	const tries: unknown[] = [
		[{ category: "newContent", rank: 0 }],
		[{ category: "NewContent", rank: 0 }],
		[{ category: "NewContent", rank: 1 }],
		[{ category: "newContent", rank: 1 }, { category: "newFeature", rank: 2 }],
		[{ category: "contentUpdate", rank: 0 }],
	];
	for (const categories of tries) {
		try {
			const result = await cloud.json("PATCH", `/virtual-events/v3/game-events/${event.id}`, "patch categories", { categories });
			log(`[cat] OK ${JSON.stringify(categories)} -> ${JSON.stringify(result?.categories)}`);
		} catch (error) {
			log(`[cat] NO ${JSON.stringify(categories)}: ${String((error as Error).message).slice(0, 160)}`);
		}
	}
	if (ctx.params.get("delete") === "1") {
		await cloud.request("DELETE", `/virtual-events/v3/game-events/${event.id}`, "delete event");
		log("[cat] deleted the test event");
	}
}

export async function eventCategoryList(ctx: ExperimentContext): Promise<void> {
	const { cloud, universeId, log } = ctx;
	const list = await cloud.request("GET", `/virtual-events/v3/universes/${universeId}/game-events`, "list events");
	const event = (list?.gameEvents ?? []).find((item: any) => item.title === "UpdateDay live test");
	if (!event) {
		log("[cats] live test event not found");
		return;
	}
	const all = ["contentUpdate", "locationUpdate", "systemUpdate", "activity", "newContent", "itemDrop", "newSeason", "newLocation", "newMap", "moreLevels", "newFeature", "earlyAccess", "expansion", "challenge", "quest", "festival"];
	const accepted: string[] = [];
	const refused: string[] = [];
	for (const category of all) {
		try {
			await cloud.json("PATCH", `/virtual-events/v3/game-events/${event.id}`, "patch", { categories: [{ category, rank: 0 }] });
			accepted.push(category);
		} catch {
			refused.push(category);
		}
	}
	await cloud.json("PATCH", `/virtual-events/v3/game-events/${event.id}`, "reset", { categories: [] }).catch((error: Error) => log(`[cats] reset failed: ${error.message.slice(0, 120)}`));
	log(`[cats] accepted: ${accepted.join(", ")}`);
	log(`[cats] refused: ${refused.join(", ")}`);
}

export async function iconUrls(ctx: ExperimentContext): Promise<void> {
	const list = await ctx.cloud.listIcons();
	for (const icon of list?.data ?? []) {
		ctx.log(`[icons] ${icon.languageCode} ${icon.state} ${icon.imageUrl ?? ""}`);
	}
}

async function freshImage(label: string): Promise<Blob> {
	const sharp = (await import("sharp")).default;
	const stamp = new Date().toISOString();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
	<rect width="512" height="512" fill="#1d2633"/>
	<text x="256" y="250" text-anchor="middle" font-family="Arial Black, Arial" font-weight="900" font-size="88" fill="#ffffff">${label}</text>
	<text x="256" y="330" text-anchor="middle" font-family="Arial" font-size="22" fill="#8fa3bf">${stamp}</text>
</svg>`;
	const png = await sharp(Buffer.from(svg)).png().toBuffer();
	return new Blob([new Uint8Array(png)], { type: "image/png" });
}

async function assetState(ctx: ExperimentContext, assetId: number): Promise<string> {
	const asset = await ctx.cloud.request("GET", `/assets/v1/assets/${assetId}?readMask=moderationResult`, "read asset");
	return String(asset?.moderationResult?.moderationState ?? "unknown");
}

async function iconStates(ctx: ExperimentContext): Promise<Record<string, string>> {
	const states: Record<string, string> = {};
	for (const icon of (await ctx.cloud.listIcons())?.data ?? []) {
		states[icon.languageCode] = icon.state;
	}
	return states;
}

export async function preReview(ctx: ExperimentContext): Promise<void> {
	const { cloud, log } = ctx;
	const reviewed = await freshImage("TEST A");
	const unreviewed = await freshImage("TEST B");
	const started = Date.now();
	const seconds = () => Math.round((Date.now() - started) / 1000);
	const assetId = await (cloud as any).uploadImage(reviewed, "UpdateDay pre-review test");
	log(`[pre] uploaded image A as asset ${assetId} after ${seconds()}s`);
	let state = "";
	const assetWaitMs = (Number(ctx.params.get("assetWait")) || 600) * 1000;
	while (Date.now() - started < assetWaitMs && !ctx.shouldStop()) {
		const now = await assetState(ctx, assetId);
		if (now !== state) {
			log(`[pre] asset A is ${now} at ${seconds()}s`);
			state = now;
		}
		if (now !== "Reviewing" && now !== "unknown") {
			break;
		}
		await waitMs(ctx, 5000);
	}
	const iconStart = Date.now();
	await cloud.setIcon(reviewed, "es");
	await cloud.setIcon(unreviewed, "de");
	log("[pre] set A (pre-reviewed) as the es icon and B (fresh) as the de icon");
	const seen: Record<string, string> = {};
	const iconWaitMs = (Number(ctx.params.get("iconWait")) || 300) * 1000;
	try {
		while (Date.now() - iconStart < iconWaitMs && !ctx.shouldStop()) {
			const states = await iconStates(ctx);
			for (const code of ["es", "de"]) {
				if (states[code] !== seen[code]) {
					log(`[pre] ${code} icon is ${states[code]} ${Math.round((Date.now() - iconStart) / 1000)}s after upload`);
					seen[code] = states[code];
				}
			}
			if (seen.es === "Approved" && seen.de === "Approved") {
				break;
			}
			await waitMs(ctx, 5000);
		}
	} finally {
		for (const code of ["es", "de"]) {
			await cloud.deleteIcon(code).then(
				() => log(`[pre] removed the ${code} test icon`),
				(error: Error) => log(`[pre] FAILED to remove ${code} icon: ${error.message}`),
			);
		}
	}
}

export async function stageTiming(ctx: ExperimentContext): Promise<void> {
	const { cloud, log } = ctx;
	const source = String((await publicJson(`/v1/source-language/games/${ctx.universeId}`) as any).languageCode);
	const supported = ((await publicJson(`/v1/supported-languages/games/${ctx.universeId}`) as any).data ?? []).map((item: any) => item.languageCode).filter((code: string) => code !== source);
	const image = await freshImage("STAGE");
	const started = Date.now();
	for (const code of supported) {
		await cloud.setIcon(image, code);
		await waitMs(ctx, 250);
	}
	log(`[stage] uploaded to ${supported.length} languages in ${Math.round((Date.now() - started) / 1000)}s`);
	const approvedAt: Record<string, number> = {};
	try {
		while (Date.now() - started < 600000 && !ctx.shouldStop() && Object.keys(approvedAt).length < supported.length) {
			const states = await iconStates(ctx);
			for (const code of supported) {
				if (!approvedAt[code] && states[code] === "Approved") {
					approvedAt[code] = Math.round((Date.now() - started) / 1000);
				}
			}
			await waitMs(ctx, 5000);
		}
		const times = Object.values(approvedAt).sort((a, b) => a - b);
		log(`[stage] approved ${times.length}/${supported.length}; first ${times[0]}s, median ${times[Math.floor(times.length / 2)]}s, last ${times[times.length - 1]}s`);
		log(`[stage] per language: ${JSON.stringify(approvedAt)}`);
	} finally {
		for (const code of supported) {
			await cloud.deleteIcon(code).catch((error: Error) => log(`[stage] FAILED to remove ${code}: ${error.message}`));
			await waitMs(ctx, 250);
		}
		log(`[stage] removed the test icons; left: ${JSON.stringify(Object.keys(await iconStates(ctx)))}`);
	}
}
