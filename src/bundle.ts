import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeMarks, showsNow, type Config, type CountdownConfig } from "./config.ts";
import { renderIcon } from "./icons.ts";
import { LABEL_LANGUAGES } from "./labels.ts";
import { zip, type ZipEntry } from "./zip.ts";

const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../roblox");
const KIT_README = `UpdateDay in-game kit

UpdateDayListener.luau   ModuleScript (ServerScriptService). Receives UpdateDay's warnings.
UpdateDayCountdown.server.luau   Script (ServerScriptService). Starts the listener and shares the update time with players.
UpdateDayBanner.client.luau   LocalScript (StarterPlayerScripts). Shows the countdown banner and warnings.
UpdateDayGifts.luau   ModuleScript (ServerScriptService). Optional: the gift box used by the Gifts tab.

Every option sits at the top of each file. Turn on "Warn players in live servers"
in UpdateDay so the game hears about the update.
`;

export function iconMarks(countdown: CountdownConfig): string[] {
	const marks = activeMarks(countdown);
	if (showsNow(countdown)) {
		marks.push("now");
	}
	marks.push("final");
	return marks;
}

function fileName(mark: string, index: number): string {
	return `${String(index + 1).padStart(2, "0")}-${mark}.png`;
}

export async function iconZip(config: Config, base: Buffer, translated: boolean): Promise<Buffer> {
	const countdown = config.countdown!;
	const marks = iconMarks(countdown);
	const entries: ZipEntry[] = [];
	for (const [index, mark] of marks.entries()) {
		entries.push({ name: fileName(mark, index), data: await renderIcon(base, mark, countdown) });
	}
	if (translated) {
		for (const language of LABEL_LANGUAGES) {
			for (const [index, mark] of marks.entries()) {
				if (mark === "final") {
					continue;
				}
				entries.push({ name: `languages/${language}/${fileName(mark, index)}`, data: await renderIcon(base, mark, countdown, language) });
			}
		}
	}
	return zip(entries);
}

export function kitZip(): Buffer {
	const files = readdirSync(KIT_DIR).filter((name) => name.endsWith(".luau"));
	const entries = files.map((name) => ({ name, data: readFileSync(join(KIT_DIR, name)) }));
	entries.push({ name: "README.txt", data: Buffer.from(KIT_README) });
	return zip(entries);
}
