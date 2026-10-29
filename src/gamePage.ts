import type { Config } from "./config.ts";
import type { OpenCloud } from "./openCloud.ts";

const GAMES_API = "https://games.roblox.com/v1/games";
const ICON_API = "https://thumbnails.roblox.com/v1/games/icons";
const ASSET_THUMBS_API = "https://thumbnails.roblox.com/v1/assets";
const I18N_API = "https://gameinternationalization.roblox.com/v1/game-thumbnails/games";
const USERS_API = "https://users.roblox.com/v1/users";
const GROUPS_API = "https://groups.roblox.com/v1/groups";
const RECOMMENDED_THUMBNAILS = 3;
const EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPDATE_TAG = /\[[^\]]*update[^\]]*\]|\bupd(ate)?\b|🆕|🎃|🔥|✨|⭐/i;
const PLACEHOLDER = /^\[.*UNAVAILABLE\]$/;

export type CheckLevel = "ok" | "warn" | "info";

export type Check = {
	level: CheckLevel;
	title: string;
	detail?: string;
};

export type PageReport = {
	name: string;
	description: string;
	creator: string | null;
	visibility: string | null;
	ageRating: string | null;
	devices: string[];
	iconUrl: string | null;
	thumbnails: string[];
	stats: Record<string, number | string | null> | null;
	events: any[];
	checks: Check[];
	keyUsed: boolean;
};

async function getJson(url: string): Promise<any> {
	const response = await fetch(url);
	return response.ok ? response.json() : null;
}

async function publicDetails(universeId: number): Promise<any | null> {
	const [games, votes] = await Promise.all([
		getJson(`${GAMES_API}?universeIds=${universeId}`),
		getJson(`${GAMES_API}/votes?universeIds=${universeId}`),
	]);
	const game = games?.data?.[0];
	if (!game || PLACEHOLDER.test(String(game.name))) {
		return null;
	}
	const vote = votes?.data?.[0];
	const totalVotes = (vote?.upVotes ?? 0) + (vote?.downVotes ?? 0);
	return { ...game, likeRatio: totalVotes ? Math.round((vote.upVotes / totalVotes) * 100) : null };
}

async function iconUrl(universeId: number): Promise<string | null> {
	const json = await getJson(`${ICON_API}?universeIds=${universeId}&size=512x512&format=Png&isCircular=false`);
	return json?.data?.[0]?.imageUrl ?? null;
}

async function thumbnailUrls(universeId: number, languageCode: string): Promise<string[]> {
	const json = await getJson(`${I18N_API}/${universeId}/images`);
	const entry = (json?.data ?? []).find((item: any) => item.languageCode === languageCode) ?? json?.data?.[0];
	const assetIds: number[] = (entry?.mediaAssets ?? []).map((asset: any) => Number(asset.mediaAssetId ?? asset.id ?? asset)).filter(Boolean);
	if (assetIds.length === 0) {
		return [];
	}
	const thumbs = await getJson(`${ASSET_THUMBS_API}?assetIds=${assetIds.join(",")}&size=768x432&format=Png`);
	return (thumbs?.data ?? []).map((item: any) => item.imageUrl).filter(Boolean);
}

async function creatorName(owner: string | undefined): Promise<string | null> {
	const match = /^(users|groups)\/(\d+)$/.exec(owner ?? "");
	if (!match) {
		return null;
	}
	const json = await getJson(`${match[1] === "users" ? USERS_API : GROUPS_API}/${match[2]}`);
	return json?.name ? (match[1] === "groups" ? `${json.name} (group)` : `@${json.name}`) : null;
}

function devicesOf(universe: any): string[] {
	const names: Record<string, string> = {
		desktopEnabled: "Computer",
		mobileEnabled: "Phone",
		tabletEnabled: "Tablet",
		consoleEnabled: "Console",
		vrEnabled: "VR",
	};
	return Object.entries(names).filter(([key]) => universe?.[key]).map(([, label]) => label);
}

function eventsNearUpdate(events: any[], updateAt: Date): any[] {
	return events.filter((event) => Math.abs(Date.parse(event.startTime) - updateAt.getTime()) <= EVENT_WINDOW_MS);
}

function buildChecks(config: Config, report: PageReport, updatedAt: string | null): Check[] {
	const checks: Check[] = [];
	const updateAt = new Date(config.updateAt);
	if (report.visibility === "PRIVATE") {
		checks.push({ level: "warn", title: "The game is private", detail: "Players can't see the countdown, sale or event until it's public." });
	}
	if (report.thumbnails.length < RECOMMENDED_THUMBNAILS) {
		checks.push({
			level: "warn",
			title: report.thumbnails.length === 0 ? "No thumbnails" : `Only ${report.thumbnails.length} thumbnail${report.thumbnails.length === 1 ? "" : "s"}`,
			detail: "Game pages usually show 3 or more; the first one is the one most players see.",
		});
	} else {
		checks.push({ level: "ok", title: `${report.thumbnails.length} thumbnails` });
	}
	if (!report.description.trim()) {
		checks.push({ level: "warn", title: "No description", detail: "Say what's new in this update; it shows on the game page." });
	}
	const nearby = eventsNearUpdate(report.events, updateAt);
	if (nearby.length > 0) {
		checks.push({ level: "ok", title: `Event for the update: ${nearby[0].title}` });
	} else if (config.event) {
		checks.push({ level: "info", title: "Event will be created", detail: `UpdateDay creates "${config.event.title}" when it starts.` });
	} else {
		checks.push({ level: "warn", title: "No event for this update", detail: "Events show on the game page and in players' calendars." });
	}
	const plannedRename = (config.nameChanges ?? []).some((change) => change.name);
	if (UPDATE_TAG.test(report.name)) {
		checks.push({ level: "ok", title: "Title has an update tag" });
	} else if (plannedRename) {
		checks.push({ level: "ok", title: "A title change is scheduled" });
	} else {
		checks.push({ level: "info", title: "Title has no update tag", detail: "Many games add [UPDATE] or an emoji to the title while the update is fresh." });
	}
	if (updatedAt) {
		const days = Math.floor((Date.now() - Date.parse(updatedAt)) / EVENT_WINDOW_MS);
		checks.push({ level: "info", title: days <= 0 ? "Last update today" : `Last update ${days} day${days === 1 ? "" : "s"} ago` });
	}
	if (config.sale) {
		checks.push({ level: "ok", title: `Sale planned: ${config.sale.percentOff}% off` });
	}
	return checks;
}

export async function pageReport(config: Config, cloud: OpenCloud | null): Promise<PageReport> {
	const [details, icon, thumbnails] = await Promise.all([
		publicDetails(config.universeId),
		iconUrl(config.universeId),
		thumbnailUrls(config.universeId, config.languageCode),
	]);
	const universe = cloud ? await cloud.getUniverse().catch(() => null) : null;
	const events = cloud ? await cloud.request("GET", `/virtual-events/v3/universes/${config.universeId}/game-events`, "list events").then((json: any) => json?.gameEvents ?? []).catch(() => []) : [];
	const report: PageReport = {
		name: String(universe?.displayName ?? details?.name ?? config.name),
		description: String(universe?.description ?? details?.description ?? ""),
		creator: universe ? await creatorName(universe.user ?? universe.group) : details?.creator?.name ?? null,
		visibility: universe?.visibility ?? (details ? "PUBLIC" : null),
		ageRating: universe?.ageRating ?? null,
		devices: devicesOf(universe),
		iconUrl: icon,
		thumbnails,
		stats: details ? {
			playing: details.playing ?? null,
			visits: details.visits ?? null,
			favorites: details.favoritedCount ?? null,
			liked: details.likeRatio,
			serverSize: details.maxPlayers ?? null,
			genre: details.genre ?? null,
			updated: details.updated ?? null,
		} : null,
		events,
		checks: [],
		keyUsed: Boolean(cloud),
	};
	report.checks = buildChecks(config, report, details?.updated ?? null);
	return report;
}
