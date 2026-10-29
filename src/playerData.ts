import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCloudError, type OpenCloud } from "./openCloud.ts";

const USERNAMES_API = "https://users.roblox.com/v1/usernames/users";
const USERS_API = "https://users.roblox.com/v1/users";
const HEADSHOT_API = "https://thumbnails.roblox.com/v1/users/avatar-headshot";
const BACKUP_DIR = "updateday-backups";
const USER_ID_TOKEN = /\{userId\}/g;
const SAFE_NAME = /[^\w.-]+/g;

export type PlayerInfo = {
	id: number;
	name: string;
	displayName: string;
	avatarUrl: string | null;
};

export type Entry = {
	value: unknown;
	etag: string | null;
	revisionId: string | null;
	updateTime: string | null;
};

export type Backup = {
	file: string;
	savedAt: string;
	reason: string;
};

async function avatar(userId: number): Promise<string | null> {
	const response = await fetch(`${HEADSHOT_API}?userIds=${userId}&size=150x150&format=Png`);
	return response.ok ? (await response.json()).data?.[0]?.imageUrl ?? null : null;
}

export async function lookupPlayer(query: string): Promise<PlayerInfo> {
	const text = query.trim().replace(/^@/, "");
	let user: any = null;
	if (/^\d+$/.test(text)) {
		const response = await fetch(`${USERS_API}/${text}`);
		user = response.ok ? await response.json() : null;
	} else {
		const response = await fetch(USERNAMES_API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ usernames: [text], excludeBannedUsers: false }),
		});
		user = response.ok ? (await response.json()).data?.[0] ?? null : null;
	}
	if (!user?.id) {
		throw new Error(`No Roblox player called "${text}"`);
	}
	return { id: user.id, name: user.name, displayName: user.displayName ?? user.name, avatarUrl: await avatar(user.id) };
}

export function entryKey(keyFormat: string, userId: number): string {
	return keyFormat.replace(USER_ID_TOKEN, String(userId));
}

function entryPath(cloud: OpenCloud, dataStore: string, key: string): string {
	return `/cloud/v2/universes/${cloud.universeId}/data-stores/${encodeURIComponent(dataStore)}/entries/${encodeURIComponent(key)}`;
}

export async function listDataStores(cloud: OpenCloud): Promise<string[]> {
	const names: string[] = [];
	let pageToken = "";
	do {
		const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
		const json = await cloud.request("GET", `/cloud/v2/universes/${cloud.universeId}/data-stores${query}`, "list data stores");
		for (const store of json?.dataStores ?? []) {
			names.push(String(store.id ?? String(store.path).split("/").pop()));
		}
		pageToken = json?.nextPageToken ?? "";
	} while (pageToken);
	return names;
}

export async function readEntry(cloud: OpenCloud, dataStore: string, key: string): Promise<Entry | null> {
	try {
		const json = await cloud.request("GET", entryPath(cloud, dataStore, key), "read entry");
		return { value: json.value, etag: json.etag ?? null, revisionId: json.revisionId ?? null, updateTime: json.revisionCreateTime ?? null };
	} catch (error) {
		if (error instanceof OpenCloudError && error.status === 404) {
			return null;
		}
		throw error;
	}
}

function backupFolder(baseDir: string, universeId: number, dataStore: string, key: string): string {
	return join(baseDir, BACKUP_DIR, String(universeId), dataStore.replace(SAFE_NAME, "_"), key.replace(SAFE_NAME, "_"));
}

export function writeBackup(baseDir: string, universeId: number, dataStore: string, key: string, entry: Entry | null, reason: string): string {
	const folder = backupFolder(baseDir, universeId, dataStore, key);
	mkdirSync(folder, { recursive: true });
	const savedAt = new Date().toISOString();
	const file = `${savedAt.replace(/[:.]/g, "-")}.json`;
	writeFileSync(join(folder, file), JSON.stringify({ savedAt, reason, dataStore, key, existed: entry !== null, value: entry?.value ?? null }, null, "\t"));
	return file;
}

export function listBackups(baseDir: string, universeId: number, dataStore: string, key: string): Backup[] {
	const folder = backupFolder(baseDir, universeId, dataStore, key);
	if (!existsSync(folder)) {
		return [];
	}
	return readdirSync(folder)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.reverse()
		.map((file) => {
			const data = JSON.parse(readFileSync(join(folder, file), "utf8"));
			return { file, savedAt: data.savedAt, reason: data.reason };
		});
}

export function readBackup(baseDir: string, universeId: number, dataStore: string, key: string, file: string): unknown {
	if (!/^[\w-]+\.json$/.test(file)) {
		throw new Error("Bad backup name");
	}
	return JSON.parse(readFileSync(join(backupFolder(baseDir, universeId, dataStore, key), file), "utf8")).value;
}

export async function saveEntry(cloud: OpenCloud, baseDir: string, dataStore: string, key: string, value: unknown, expectedEtag: string | null, reason: string): Promise<Entry> {
	const current = await readEntry(cloud, dataStore, key);
	if (expectedEtag && current?.etag && current.etag !== expectedEtag) {
		throw new Error("This player's data changed since you loaded it (they may be in game). Reload and try again.");
	}
	writeBackup(baseDir, cloud.universeId, dataStore, key, current, reason);
	const body: Record<string, unknown> = { value };
	if (current?.etag) {
		body.etag = current.etag;
	}
	const path = `${entryPath(cloud, dataStore, key)}?allowMissing=true`;
	const json = await cloud.json("PATCH", path, "save entry", body);
	return { value: json.value, etag: json.etag ?? null, revisionId: json.revisionId ?? null, updateTime: json.revisionCreateTime ?? null };
}
