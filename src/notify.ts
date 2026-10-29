import type { Config, NotifyEvent } from "./config.ts";

export type NotifyMessage = {
	event: NotifyEvent;
	title: string;
	text: string;
	image?: Buffer;
};

export type Notifier = (message: NotifyMessage) => Promise<void>;

const WEBHOOK_PATTERN = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const BOT_NAME = "UpdateDay";
const IMAGE_NAME = "icon.png";
const COLORS: Record<NotifyEvent, number> = {
	reminders: 0xf0b232,
	failures: 0xf0555a,
	live: 0x2fbf71,
	finished: 0x4c8dff,
	steps: 0x8b93a7,
};

export function isWebhookUrl(url: string): boolean {
	return WEBHOOK_PATTERN.test(url.trim());
}

function allowedMentions(mention: string | undefined): object {
	if (!mention) {
		return { parse: [] };
	}
	return { parse: ["everyone", "roles", "users"] };
}

export async function postDiscord(webhook: string, message: NotifyMessage, mention?: string): Promise<void> {
	if (!isWebhookUrl(webhook)) {
		throw new Error("That isn't a Discord webhook link (https://discord.com/api/webhooks/...)");
	}
	const embed: Record<string, unknown> = {
		title: message.title,
		description: message.text,
		color: COLORS[message.event],
		timestamp: new Date().toISOString(),
	};
	const payload: Record<string, unknown> = {
		username: BOT_NAME,
		content: mention ?? "",
		embeds: [embed],
		allowed_mentions: allowedMentions(mention),
	};
	let body: BodyInit;
	if (message.image) {
		embed.image = { url: `attachment://${IMAGE_NAME}` };
		const form = new FormData();
		form.set("payload_json", JSON.stringify(payload));
		form.set("files[0]", new Blob([new Uint8Array(message.image)], { type: "image/png" }), IMAGE_NAME);
		body = form;
	} else {
		body = JSON.stringify(payload);
	}
	const response = await fetch(webhook.trim(), {
		method: "POST",
		headers: message.image ? undefined : { "content-type": "application/json" },
		body,
	});
	if (!response.ok) {
		throw new Error(`Discord refused the message (${response.status})`);
	}
}

export function discordNotifier(config: Config, webhook: string | undefined): Notifier | undefined {
	const settings = config.notify;
	if (!settings || !webhook) {
		return undefined;
	}
	return async (message) => {
		if (!settings.events.includes(message.event)) {
			return;
		}
		try {
			await postDiscord(webhook, { ...message, title: `${config.name}: ${message.title}` }, settings.mention);
		} catch (error) {
			console.error(`Discord alert not sent: ${error instanceof Error ? error.message : error}`);
		}
	};
}
