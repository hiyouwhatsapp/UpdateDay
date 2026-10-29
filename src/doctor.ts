import type { Config } from "./config.ts";
import { OpenCloudError, type OpenCloud } from "./openCloud.ts";

const PROBE_KEY = "UpdateDayKeyCheck";
const PROBE_TOPIC = "UpdateDayKeyCheck";

export type ProbeStatus = "ok" | "missing" | "error" | "untested";

export type Probe = {
	feature: string;
	status: ProbeStatus;
	permission: string;
	used: boolean;
	detail?: string;
};

type ProbeSpec = {
	feature: string;
	permission: string;
	used: (config: Config) => boolean;
	run?: (cloud: OpenCloud, config: Config) => Promise<unknown>;
	note?: string;
};

function entryPath(cloud: OpenCloud, store: string, key: string): string {
	return `/cloud/v2/universes/${cloud.universeId}/data-stores/${encodeURIComponent(store)}/entries/${encodeURIComponent(key)}`;
}

async function readMissingEntry(cloud: OpenCloud): Promise<void> {
	try {
		await cloud.request("GET", entryPath(cloud, PROBE_KEY, PROBE_KEY), "read entry");
	} catch (error) {
		if (error instanceof OpenCloudError && error.status === 404) {
			return;
		}
		throw error;
	}
}

const PROBES: ProbeSpec[] = [
	{
		feature: "Game info",
		permission: "Universe: read",
		used: () => true,
		run: (cloud) => cloud.getUniverse(),
	},
	{
		feature: "Name and description",
		permission: "Places: read + write",
		used: (config) => Boolean(config.nameChanges?.length || config.title),
		run: async (cloud) => cloud.getPlace(await cloud.rootPlaceId()),
		note: "Write is checked the first time a name change runs.",
	},
	{
		feature: "Countdown icons",
		permission: "Legacy universe: manage",
		used: (config) => Boolean(config.countdown),
		run: (cloud) => cloud.listIcons(),
	},
	{
		feature: "Sale: game passes",
		permission: "Game passes: read + write",
		used: (config) => Boolean(config.sale),
		run: (cloud) => cloud.listItems("gamePass"),
		note: "Write is checked when the sale starts; every price is read back.",
	},
	{
		feature: "Sale: developer products",
		permission: "Developer products: read + write",
		used: (config) => Boolean(config.sale),
		run: (cloud) => cloud.listItems("developerProduct"),
	},
	{
		feature: "Events",
		permission: "Universe events: read + write",
		used: (config) => Boolean(config.event),
		run: (cloud) => cloud.request("GET", `/virtual-events/v3/universes/${cloud.universeId}/game-events`, "list events"),
	},
	{
		feature: "In-game warnings",
		permission: "Messaging service: publish",
		used: (config) => Boolean(config.broadcast),
		run: (cloud) => cloud.publishMessage(PROBE_TOPIC, "key check"),
	},
	{
		feature: "Player data: list stores",
		permission: "DataStore: List data stores",
		used: (config) => Boolean(config.playerData),
		run: (cloud) => cloud.request("GET", `/cloud/v2/universes/${cloud.universeId}/data-stores?maxPageSize=1`, "list data stores"),
	},
	{
		feature: "Player data and gifts",
		permission: "DataStore: Read entry + Create entry + Update entry",
		used: (config) => Boolean(config.playerData || config.gifts),
		run: (cloud) => readMissingEntry(cloud),
		note: "Create and update are checked on the first save.",
	},
	{
		feature: "Server restarts",
		permission: "Universe: write",
		used: (config) => Boolean(config.restartServers),
		note: "Can't be checked without restarting servers; checked when it runs.",
	},
	{
		feature: "Publishing the place",
		permission: "Places: publish (universe-places:write)",
		used: (config) => Boolean(config.publish),
		note: "Checked when it runs.",
	},
];

function describe(error: unknown): { status: ProbeStatus; detail: string } {
	if (error instanceof OpenCloudError) {
		if (error.status === 401 || error.status === 403) {
			const ip = /ip/i.test(error.body);
			return {
				status: "missing",
				detail: ip ? "Roblox refused this computer's IP address: add it to the key's accepted IPs." : "The key doesn't have this permission for this game.",
			};
		}
		return { status: "error", detail: `Roblox answered ${error.status}: ${error.body.slice(0, 160)}` };
	}
	return { status: "error", detail: error instanceof Error ? error.message : String(error) };
}

export async function checkKey(cloud: OpenCloud, config: Config): Promise<Probe[]> {
	const results: Probe[] = [];
	for (const spec of PROBES) {
		const base = { feature: spec.feature, permission: spec.permission, used: spec.used(config) };
		if (!spec.run) {
			results.push({ ...base, status: "untested", detail: spec.note });
			continue;
		}
		try {
			await spec.run(cloud, config);
			results.push({ ...base, status: "ok", detail: spec.note });
		} catch (error) {
			results.push({ ...base, ...describe(error) });
		}
	}
	return results;
}
