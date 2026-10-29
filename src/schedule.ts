import { activeMarks, DEFAULT_MARKS, showsNow, type Config, type CountdownConfig } from "./config.ts";

export type StepAction =
	| { type: "snapshotIcon" }
	| { type: "icon"; mark: string }
	| { type: "title"; mark: string }
	| { type: "nameDescription"; name?: string; description?: string }
	| { type: "saleStart" }
	| { type: "saleEnd" }
	| { type: "event" }
	| { type: "broadcast"; message: string }
	| { type: "publish" }
	| { type: "restartServers" };

export type Step = {
	id: string;
	at: Date;
	label: string;
	action: StepAction;
};

const UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
};

export function parseOffset(text: string): number {
	if (text === "0" || text === "now") {
		return 0;
	}
	const match = /^([+-]?)(\d+(?:\.\d+)?)([smhd])$/.exec(text.trim());
	if (!match) {
		throw new Error(`Bad time offset "${text}" (use e.g. 24h, 30m, -1h, +2h)`);
	}
	const sign = match[1] === "+" ? 1 : -1;
	return sign * Number(match[2]) * UNIT_MS[match[3]];
}

function relative(updateAt: Date, offsetMs: number): Date {
	return new Date(updateAt.getTime() + offsetMs);
}

function countdownSteps(config: Config, updateAt: Date): Step[] {
	const countdown = config.countdown;
	if (!countdown) {
		return [];
	}
	const steps: Step[] = [{
		id: "icon:snapshot",
		at: new Date(0),
		label: "Save the current game icon",
		action: { type: "snapshotIcon" },
	}];
	const lead = countdown.iconMethod === "languageSwap" ? countdown.uploadLeadSeconds * UNIT_MS.s : 0;
	const verb = countdown.iconMethod === "reminder" ? "Reminder: upload countdown icon" : "Countdown icon";
	for (const mark of activeMarks(countdown)) {
		steps.push({
			id: `icon:${mark}`,
			at: relative(updateAt, parseOffset(mark) - lead),
			label: `${verb} ${mark}`,
			action: { type: "icon", mark },
		});
	}
	if (showsNow(countdown)) {
		steps.push({
			id: "icon:now",
			at: relative(updateAt, -lead),
			label: countdown.iconMethod === "reminder" ? `Reminder: upload ${nowLabel(countdown)}` : nowLabel(countdown),
			action: { type: "icon", mark: "now" },
		});
	}
	const finalAt = showsNow(countdown) ? relative(updateAt, config.adminAbuseMinutes * UNIT_MS.m) : updateAt;
	steps.push({
		id: "icon:final",
		at: finalAt,
		label: finalLabel(countdown),
		action: { type: "icon", mark: "final" },
	});
	return steps;
}

function finalLabel(countdown: CountdownConfig): string {
	if (countdown.iconMethod === "languageSwap") {
		return countdown.newIcon ? "End countdown (then upload the new icon in Creator Hub)" : "End countdown: original icon back";
	}
	return countdown.newIcon ? "Reminder: upload the new game icon" : "Reminder: put the original icon back";
}

function nowLabel(countdown: CountdownConfig): string {
	if (countdown.newIcon && countdown.newIconAt === "now") {
		return "Countdown icon NOW, over the new game icon";
	}
	return "Countdown icon NOW";
}

function saleSteps(config: Config, updateAt: Date): Step[] {
	const sale = config.sale;
	if (!sale) {
		return [];
	}
	const startsAt = sale.startsAt ? new Date(sale.startsAt) : updateAt;
	const endsAt = sale.endsAt ? new Date(sale.endsAt) : relative(startsAt, sale.durationHours * UNIT_MS.h);
	return [
		{
			id: "sale:start",
			at: startsAt,
			label: `Sale starts (${sale.percentOff}% off)`,
			action: { type: "saleStart" },
		},
		{
			id: "sale:end",
			at: endsAt,
			label: "Sale ends, prices restored",
			action: { type: "saleEnd" },
		},
	];
}

function nameSteps(config: Config, updateAt: Date): Step[] {
	return (config.nameChanges ?? []).map((change, index) => ({
		id: `name:${index}`,
		at: relative(updateAt, parseOffset(change.at)),
		label: `Game page text${change.name ? `: "${change.name}"` : ""}`,
		action: { type: "nameDescription", name: change.name, description: change.description },
	}));
}

function broadcastSteps(config: Config, updateAt: Date): Step[] {
	const broadcast = config.broadcast;
	if (!broadcast) {
		return [];
	}
	return broadcast.marks.map((mark) => ({
		id: `broadcast:${mark}`,
		at: relative(updateAt, parseOffset(mark)),
		label: `In-game warning (${mark})`,
		action: { type: "broadcast", message: JSON.stringify({ updateAt: updateAt.toISOString(), mark }) },
	}));
}

function launchSteps(config: Config, updateAt: Date): Step[] {
	const steps: Step[] = [];
	if (config.event) {
		steps.push({ id: "event", at: new Date(0), label: "Create Roblox event", action: { type: "event" } });
	}
	if (config.publish) {
		steps.push({ id: "publish", at: updateAt, label: "Publish place", action: { type: "publish" } });
	}
	if (config.restartServers) {
		steps.push({ id: "restart", at: updateAt, label: "Restart old servers", action: { type: "restartServers" } });
	}
	return steps;
}

function titleMarks(config: Config): string[] {
	if (config.title?.marks) {
		return config.title.marks;
	}
	return config.countdown ? activeMarks(config.countdown) : DEFAULT_MARKS;
}

function titleSteps(config: Config, updateAt: Date): Step[] {
	const title = config.title;
	if (!title) {
		return [];
	}
	const withNow = config.countdown ? showsNow(config.countdown) : true;
	const steps: Step[] = [{ id: "title:save", at: new Date(0), label: "Save the game's title", action: { type: "title", mark: "save" } }];
	for (const mark of titleMarks(config)) {
		steps.push({ id: `title:${mark}`, at: relative(updateAt, parseOffset(mark)), label: `Title countdown ${mark.toUpperCase()}`, action: { type: "title", mark } });
	}
	if (withNow) {
		steps.push({ id: "title:now", at: updateAt, label: "Title: LIVE", action: { type: "title", mark: "now" } });
	}
	const finalAt = withNow ? relative(updateAt, config.adminAbuseMinutes * UNIT_MS.m) : updateAt;
	const custom = title.afterFormat.trim() !== "{name}";
	steps.push({ id: "title:final", at: finalAt, label: custom ? "Title after the update" : "Title back to normal", action: { type: "title", mark: "final" } });
	return steps;
}

export function buildSchedule(config: Config): Step[] {
	const updateAt = new Date(config.updateAt);
	const steps = [
		...launchSteps(config, updateAt),
		...countdownSteps(config, updateAt),
		...titleSteps(config, updateAt),
		...nameSteps(config, updateAt),
		...broadcastSteps(config, updateAt),
		...saleSteps(config, updateAt),
	];
	return steps.sort((a, b) => a.at.getTime() - b.at.getTime());
}
