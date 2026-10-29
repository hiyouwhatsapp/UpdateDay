const BASE_URL = "https://apis.roblox.com";
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 1000;
const UPLOAD_POLLS = 20;
const UPLOAD_POLL_MS = 1500;

export type PriceTarget = {
	kind: "gamePass" | "developerProduct";
	id: number;
};

export type SaleItem = {
	kind: PriceTarget["kind"];
	id: number;
	name: string;
	price: number | null;
	isForSale: boolean;
	iconAssetId: number | null;
};

export type PriceInfo = {
	price: number | null;
	isForSale: boolean;
	name: string;
};

export type EventInput = {
	title: string;
	subtitle: string;
	description?: string;
	startTime: string;
	endTime: string;
	visibility: "Public" | "Private";
	placeId?: number;
};

export class OpenCloudError extends Error {
	status: number;
	body: string;

	constructor(status: number, body: string, label: string) {
		super(`${label} failed (${status}): ${body.slice(0, 300)}`);
		this.status = status;
		this.body = body;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500;
}

function priceBasePath(universeId: number, target: PriceTarget): string {
	if (target.kind === "gamePass") {
		return `/game-passes/v1/universes/${universeId}/game-passes/${target.id}`;
	}
	return `/developer-products/v2/universes/${universeId}/developer-products/${target.id}`;
}

function listPath(universeId: number, kind: PriceTarget["kind"]): string {
	if (kind === "gamePass") {
		return `/game-passes/v1/universes/${universeId}/game-passes/creator`;
	}
	return `/developer-products/v2/universes/${universeId}/developer-products/creator`;
}

function readPrice(json: any): PriceInfo {
	const price = json.priceInformation?.defaultPriceInRobux ?? json.price ?? json.priceInRobux ?? null;
	return {
		price: typeof price === "number" ? price : null,
		isForSale: Boolean(json.isForSale ?? json.priceInformation != null),
		name: String(json.name ?? json.displayName ?? ""),
	};
}

export class OpenCloud {
	apiKey: string;
	universeId: number;

	constructor(apiKey: string, universeId: number) {
		this.apiKey = apiKey;
		this.universeId = universeId;
	}

	async request(method: string, path: string, label: string, body?: BodyInit, contentType?: string): Promise<any> {
		const headers: Record<string, string> = { "x-api-key": this.apiKey };
		if (contentType) {
			headers["content-type"] = contentType;
		}
		for (let attempt = 0; ; attempt++) {
			const response = await fetch(BASE_URL + path, { method, headers, body });
			const text = await response.text();
			if (response.ok) {
				return text ? JSON.parse(text) : null;
			}
			if (!isRetryable(response.status) || attempt >= MAX_RETRIES) {
				throw new OpenCloudError(response.status, text, label);
			}
			await sleep(RETRY_BASE_MS * 2 ** attempt);
		}
	}

	json(method: string, path: string, label: string, payload: unknown): Promise<any> {
		return this.request(method, path, label, JSON.stringify(payload), "application/json");
	}

	async getPrice(target: PriceTarget): Promise<PriceInfo> {
		const json = await this.request("GET", `${priceBasePath(this.universeId, target)}/creator`, `read ${target.kind} ${target.id}`);
		return readPrice(json);
	}

	async setPrice(target: PriceTarget, price: number): Promise<void> {
		const form = new FormData();
		form.set("price", String(price));
		await this.request("PATCH", priceBasePath(this.universeId, target), `price ${target.kind} ${target.id}`, form);
	}

	async setName(target: PriceTarget, name: string): Promise<void> {
		const form = new FormData();
		form.set("name", name);
		await this.request("PATCH", priceBasePath(this.universeId, target), `rename ${target.kind} ${target.id}`, form);
	}

	async listItems(kind: PriceTarget["kind"]): Promise<SaleItem[]> {
		const items: SaleItem[] = [];
		let pageToken = "";
		do {
			const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
			const json = await this.request("GET", listPath(this.universeId, kind) + query, `list ${kind}s`);
			for (const item of json.gamePasses ?? json.developerProducts ?? []) {
				const info = readPrice(item);
				items.push({
					kind,
					id: Number(item.gamePassId ?? item.productId ?? item.id),
					name: info.name,
					price: info.price,
					isForSale: Boolean(item.isForSale),
					iconAssetId: Number(item.iconAssetId ?? item.iconImageAssetId) || null,
				});
			}
			pageToken = json.nextPageToken ?? "";
		} while (pageToken);
		return items;
	}

	async listPriceTargets(kind: PriceTarget["kind"]): Promise<PriceTarget[]> {
		const targets: PriceTarget[] = [];
		let pageToken = "";
		do {
			const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
			const json = await this.request("GET", listPath(this.universeId, kind) + query, `list ${kind}s`);
			const items = json.gamePasses ?? json.developerProducts ?? json.data ?? [];
			for (const item of items) {
				const id = item.gamePassId ?? item.productId ?? item.id;
				if (typeof id === "number") {
					targets.push({ kind, id });
				}
			}
			pageToken = json.nextPageToken ?? "";
		} while (pageToken);
		return targets;
	}

	async setIcon(image: Blob, languageCode: string): Promise<void> {
		const form = new FormData();
		form.set("Files", image, "icon.png");
		const path = `/legacy-game-internationalization/v1/game-icon/games/${this.universeId}/language-codes/${languageCode}`;
		await this.request("POST", path, "set game icon", form);
	}

	async setSourceLanguage(languageCode: string): Promise<void> {
		const path = `/legacy-game-internationalization/v1/source-language/games/${this.universeId}?languageCode=${encodeURIComponent(languageCode)}`;
		await this.request("PATCH", path, `set source language ${languageCode}`);
	}

	listIcons(): Promise<any> {
		const path = `/legacy-game-internationalization/v1/game-icon/games/${this.universeId}`;
		return this.request("GET", path, "list game icons");
	}

	async deleteIcon(languageCode: string): Promise<void> {
		const path = `/legacy-game-internationalization/v1/game-icon/games/${this.universeId}/language-codes/${languageCode}`;
		await this.request("DELETE", path, `delete ${languageCode} icon`);
	}

	async uploadImage(image: Blob, displayName: string): Promise<number> {
		const universe = await this.getUniverse();
		const owner = /^(users|groups)\/(\d+)$/.exec(String(universe?.user ?? universe?.group ?? ""));
		if (!owner) {
			throw new Error("Could not tell who owns this game");
		}
		const creator = owner[1] === "users" ? { userId: owner[2] } : { groupId: owner[2] };
		const form = new FormData();
		form.set("request", JSON.stringify({ assetType: "Image", displayName, description: "Uploaded by UpdateDay", creationContext: { creator } }));
		form.set("fileContent", image, "image.png");
		let operation = await this.request("POST", "/assets/v1/assets", "upload image", form);
		for (let attempt = 0; !operation?.done && attempt < UPLOAD_POLLS; attempt++) {
			await sleep(UPLOAD_POLL_MS);
			const id = String(operation?.path ?? operation?.operationId ?? "").split("/").pop();
			operation = await this.request("GET", `/assets/v1/operations/${id}`, "check upload");
		}
		const assetId = Number(operation?.response?.assetId);
		if (!operation?.done || !assetId) {
			throw new Error(`Image upload didn't finish: ${JSON.stringify(operation).slice(0, 200)}`);
		}
		return assetId;
	}

	getUniverse(): Promise<any> {
		return this.request("GET", `/cloud/v2/universes/${this.universeId}`, "read universe");
	}

	async rootPlaceId(): Promise<number> {
		const universe = await this.getUniverse();
		const placeId = Number(String(universe?.rootPlace ?? "").split("/").pop());
		if (!Number.isInteger(placeId) || placeId <= 0) {
			throw new Error("Could not find the game's root place");
		}
		return placeId;
	}

	getPlace(placeId: number): Promise<any> {
		return this.request("GET", `/cloud/v2/universes/${this.universeId}/places/${placeId}`, "read place");
	}

	async setNameDescription(name?: string, description?: string): Promise<{ name: string; description: string }> {
		const placeId = await this.rootPlaceId();
		const fields: Record<string, string> = {};
		if (name !== undefined) {
			fields.displayName = name;
		}
		if (description !== undefined) {
			fields.description = description;
		}
		const mask = Object.keys(fields).join(",");
		const path = `/cloud/v2/universes/${this.universeId}/places/${placeId}?updateMask=${mask}`;
		const updated = await this.json("PATCH", path, "set name/description", fields);
		return { name: String(updated?.displayName ?? ""), description: String(updated?.description ?? "") };
	}

	createEvent(input: EventInput): Promise<any> {
		const path = `/virtual-events/v3/universes/${this.universeId}/game-events`;
		return this.json("POST", path, "create event", input);
	}

	publishMessage(topic: string, message: string): Promise<any> {
		const path = `/cloud/v2/universes/${this.universeId}:publishMessage`;
		return this.json("POST", path, "publish message", { topic, message });
	}

	restartServers(bleedOffMinutes: number): Promise<any> {
		const path = `/cloud/v2/universes/${this.universeId}:restartServers`;
		const payload = bleedOffMinutes > 0
			? { closeAllVersions: false, bleedOffServers: true, bleedOffDurationMinutes: bleedOffMinutes }
			: { closeAllVersions: false, bleedOffServers: false };
		return this.json("POST", path, "restart servers", payload);
	}

	publishPlace(placeId: number, file: Blob): Promise<any> {
		const path = `/universes/v1/${this.universeId}/places/${placeId}/versions?versionType=Published`;
		return this.request("POST", path, "publish place", file, "application/octet-stream");
	}

	getEntry(dataStore: string, key: string, scope = "global"): Promise<any> {
		const path = `/cloud/v2/universes/${this.universeId}/data-stores/${encodeURIComponent(dataStore)}/scopes/${encodeURIComponent(scope)}/entries/${encodeURIComponent(key)}`;
		return this.request("GET", path, `read entry ${dataStore}/${key}`);
	}
}
