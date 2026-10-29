import { randomUUID } from "node:crypto";
import type { OpenCloud } from "./openCloud.ts";
import { readEntry, saveEntry } from "./playerData.ts";

export const DEFAULT_GIFT_STORE = "UpdateDayGifts";
export const GIFT_TOPIC = "UpdateDayGifts";
const MAX_AMOUNT = 50;
const SAVE_ATTEMPTS = 3;

export type Gift = {
	id: string;
	category: string;
	item: string;
	tier: string | null;
	amount: number;
	sentAt: string;
	note: string | null;
};

export type GiftInput = {
	category: string;
	item: string;
	tier?: string | null;
	amount: number;
	note?: string | null;
};

function giftsOf(value: unknown): Gift[] {
	const gifts = (value as { gifts?: unknown })?.gifts;
	return Array.isArray(gifts) ? (gifts as Gift[]) : [];
}

function validate(input: GiftInput): void {
	if (!input.category?.trim() || !input.item?.trim()) {
		throw new Error("Pick what to give");
	}
	if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > MAX_AMOUNT) {
		throw new Error(`Amount must be 1 to ${MAX_AMOUNT}`);
	}
}

export async function pendingGifts(cloud: OpenCloud, store: string, userId: number): Promise<Gift[]> {
	const entry = await readEntry(cloud, store, String(userId));
	return giftsOf(entry?.value);
}

async function changeGifts(cloud: OpenCloud, baseDir: string, store: string, userId: number, reason: string, change: (gifts: Gift[]) => Gift[]): Promise<Gift[]> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
		const entry = await readEntry(cloud, store, String(userId));
		const next = change(giftsOf(entry?.value));
		try {
			await saveEntry(cloud, baseDir, store, String(userId), { gifts: next }, entry?.etag ?? null, reason);
			return next;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

export async function sendGift(cloud: OpenCloud, baseDir: string, store: string, userId: number, input: GiftInput): Promise<Gift> {
	validate(input);
	const gift: Gift = {
		id: randomUUID(),
		category: input.category.trim(),
		item: input.item.trim(),
		tier: input.tier?.trim() || null,
		amount: input.amount,
		sentAt: new Date().toISOString(),
		note: input.note?.trim() || null,
	};
	await changeGifts(cloud, baseDir, store, userId, `gift ${gift.amount}x ${gift.item}`, (gifts) => [...gifts, gift]);
	await cloud.publishMessage(GIFT_TOPIC, JSON.stringify({ userId })).catch(() => null);
	return gift;
}

export async function cancelGift(cloud: OpenCloud, baseDir: string, store: string, userId: number, giftId: string): Promise<Gift[]> {
	return changeGifts(cloud, baseDir, store, userId, `cancel gift ${giftId}`, (gifts) => gifts.filter((gift) => gift.id !== giftId));
}
