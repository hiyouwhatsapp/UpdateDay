import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47900 + Math.floor(Math.random() * 90);
const DEBUG_PORT = PORT + 1000;
const TABS = ["countdown", "sale", "events", "page", "players", "gifts", "history", "settings"];
const SIZES = [[1440, 900], [390, 844]];
const THEMES = ["dark", "light"];
const SETTLE_MS = 1500;
const UNIVERSE = Number(process.env.UPDATEDAY_SMOKE_UNIVERSE) || 383310974;
const CHROME_GUESSES = [
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

function findChrome() {
	const found = CHROME_GUESSES.find((path) => path && existsSync(path));
	if (!found) {
		console.error("No Chrome found. Set CHROME_PATH to a Chrome, Chromium or Edge executable.");
		process.exit(2);
	}
	return found;
}

function planFile() {
	const dir = mkdtempSync(join(tmpdir(), "updateday-ui-smoke-"));
	const path = join(dir, "updateday.json");
	const plan = {
		updateAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
		countdown: {},
		sale: { percentOff: 30, durationHours: 48, gamePasses: "all", developerProducts: "all", nameTag: "[{percent}% OFF]" },
		broadcast: { topic: "UpdateDay", marks: ["10m", "5m", "1m"] },
		event: { title: "New update!", subtitle: "Come play", durationHours: 2, visibility: "Public" },
		notify: {},
		repeat: { every: "week" },
		games: [{ universeId: UNIVERSE, name: "Smoke test" }, { name: "" }],
	};
	writeFileSync(path, JSON.stringify(plan));
	return path;
}

async function devtools(chrome) {
	const profile = mkdtempSync(join(tmpdir(), "updateday-ui-profile-"));
	const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
	let page;
	for (let attempt = 0; attempt < 60 && !page; attempt++) {
		try {
			page = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()).find((target) => target.type === "page");
		} catch {
			await wait(250);
		}
	}
	const socket = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((done) => socket.addEventListener("open", done));
	let id = 0;
	const pending = new Map();
	const problems = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)(message.result ?? message);
			pending.delete(message.id);
		}
		if (message.method === "Runtime.exceptionThrown") {
			problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		}
		if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
			problems.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
		}
	});
	const send = (method, params = {}) => new Promise((done) => {
		id++;
		pending.set(id, done);
		socket.send(JSON.stringify({ id, method, params }));
	});
	await send("Runtime.enable");
	await send("Page.enable");
	return { send, problems, close: () => { socket.close(); browser.kill(); } };
}

async function evaluate(send, expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	return result.result?.value;
}

async function main() {
	const chrome = findChrome();
	const server = spawn(process.execPath, [join(ROOT, "src/cli.ts"), "ui", planFile(), "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise((done) => server.stdout.on("data", (chunk) => String(chunk).includes("open at") && done()));
	const browser = await devtools(chrome);
	const failures = [];
	try {
		for (const [width, height] of SIZES) {
			await browser.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
			for (const theme of THEMES) {
				await browser.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
				await wait(SETTLE_MS * 2);
				await evaluate(browser.send, `document.documentElement.dataset.theme = "${theme}"`);
				for (const tab of TABS) {
					await evaluate(browser.send, `showView("${tab}")`);
					await wait(SETTLE_MS);
					const scrollWidth = await evaluate(browser.send, "document.documentElement.scrollWidth");
					const label = `${tab} at ${width}px, ${theme}`;
					if (scrollWidth > width) {
						failures.push(`${label}: page is ${scrollWidth}px wide (sideways scroll)`);
					}
					for (const problem of browser.problems.splice(0)) {
						failures.push(`${label}: ${problem}`);
					}
					console.log(`checked ${label}`);
				}
			}
		}
	} finally {
		browser.close();
		server.kill();
	}
	if (failures.length) {
		console.error(`\n${failures.length} problem${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`);
		process.exit(1);
	}
	console.log(`\nUI smoke test passed: ${TABS.length} tabs × ${SIZES.length} sizes × ${THEMES.length} themes.`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
