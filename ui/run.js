const POLL_RUNNING_MS = 2000;
const POLL_IDLE_MS = 6000;
const DOCTOR_SYMBOLS = { ok: "✓", missing: "✗", error: "!", untested: "–" };
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(.*)$/;
const ALERT_LINE = /REMINDER|FAILED|^ERROR|update day is done|Every schedule is complete/i;
const CHECK_SYMBOLS_RUN = { ok: "✓", warn: "!", bad: "✗", info: "i" };

let runMode = "idle";
let pollTimer = null;
let drawerOpen = false;
let lastLog = "";
let lastLines = null;

function nextStep() {
	const steps = (UD.schedule?.games ?? []).flatMap((game) => (game?.steps ?? []).filter((step) => !step.done).map((step) => ({ ...step, game: game.name })));
	steps.sort((a, b) => (a.at ? Date.parse(a.at) : 0) - (b.at ? Date.parse(b.at) : 0));
	return steps[0] ?? null;
}

function keyEnvs() {
	const games = (UD.schedule?.games ?? []).filter(Boolean);
	return [...new Map(games.map((game) => [game.apiKeyEnv, game])).values()];
}

function runbarHtml() {
	return `
		<div class="runbar-main">
			<div class="run-state">
				<span class="pulse" id="runPulse" aria-hidden="true"></span>
				<div class="run-text"><b id="runTitle">Not running</b><span id="runNext"></span></div>
			</div>
			<div class="run-actions">
				<span id="runKey"></span>
				<button class="btn btn-ghost btn-sm" id="runCheck" title="Check the key, times, icons, sale items and alerts">Check plan</button>
				<button class="btn btn-ghost btn-sm" id="runDry" title="Show what would happen right now, without changing anything">Dry run</button>
				<button class="btn btn-ghost btn-sm" id="runUndo" title="Put prices, names and the icon back">Undo all</button>
				<button class="btn btn-primary" id="runStart">Start</button>
				<button class="btn btn-danger" id="runStop" hidden>Stop</button>
				<button class="icon-btn" id="runDrawer" aria-expanded="false" aria-controls="drawer" aria-label="Show log and API key">▴</button>
			</div>
		</div>
		<div class="drawer" id="drawer">
			<div class="drawer-inner">
				<div>
					<div class="section-title">API key</div>
					<div id="runKeys"></div>
					<div class="hint" style="margin-bottom:12px">Pasted keys stay in memory until UpdateDay closes and are never written to disk. To keep one, set it as an environment variable.</div>
					<button class="btn btn-sm" id="runDoctor">Check key permissions</button>
					<div id="runDoctorResult" style="margin-top:12px"></div>
				</div>
				<div>
					<div class="section-title">Log</div>
					<pre class="log" id="runLog" tabindex="0" aria-label="Run log"></pre>
				</div>
			</div>
		</div>`;
}

function logHtml(lines) {
	if (!lines.length) {
		return `<span class="t">Nothing has run yet. Start runs the plan on time; Dry run shows what would happen right now.</span>`;
	}
	return lines.map((line) => {
		const match = LOG_LINE.exec(line);
		const text = match ? match[2] : line;
		const kind = /error|failed|refused|couldn't/i.test(text) ? "err" : /^\s*RUN\b/.test(text) ? "run" : /REMINDER|warn|skipp/i.test(text) ? "warn" : "";
		const time = match ? `<span class="t">${h(formatTime(match[1]))}</span>  ` : "";
		return `${time}<span class="${kind}">${h(text.replace(/^\s*RUN\s+/, "▸ "))}</span>`;
	}).join("\n");
}

function renderRunState() {
	const running = runMode !== "idle";
	$("runPulse").classList.toggle("on", running);
	$("runTitle").textContent = runMode === "watching" ? "Running" : running ? "Busy" : "Not running";
	const next = nextStep();
	const multi = (UD.schedule?.games ?? []).filter(Boolean).length > 1;
	const nextText = next
		? `Next: ${next.label}${multi ? ` (${next.game})` : ""} · ${next.at ? (Date.parse(next.at) <= Date.now() ? "due now" : `in ${formatSpan(Date.parse(next.at) - Date.now())}`) : "right away"}`
		: "Everything is done";
	$("runNext").textContent = nextText;
	$("runNext").title = nextText;
	$("runStart").hidden = running;
	$("runStop").hidden = !running;
	$("runDry").disabled = running;
	$("runUndo").disabled = running;
	const envs = keyEnvs();
	const missing = envs.filter((game) => !game.hasKey).length;
	$("runKey").innerHTML = envs.length
		? `<button class="badge ${missing ? "badge-warning" : "badge-success"}" id="runKeyBadge" style="cursor:pointer;border:0">${missing ? "No API key" : "Key ready"}</button>`
		: "";
	$("runKeyBadge")?.addEventListener("click", () => setDrawer(true));
}

function renderKeys() {
	const box = $("runKeys");
	const envs = keyEnvs();
	if (!envs.length) {
		box.innerHTML = `<div class="hint" style="margin-bottom:10px">Add a game first.</div>`;
		return;
	}
	box.innerHTML = envs.map((game) => `
		<form class="key-row" data-env="${h(game.apiKeyEnv)}">
			<label class="field" style="margin:0">
				<span>${h(game.apiKeyEnv)} <span class="badge ${game.hasKey ? "badge-success" : "badge-warning"}">${game.hasKey ? "Set" : "Missing"}</span></span>
				<input type="password" placeholder="${game.hasKey ? "Paste to replace" : "Paste your Open Cloud API key"}" autocomplete="off">
			</label>
			<div class="field" style="margin:0;justify-content:flex-end"><button class="btn btn-sm" type="submit">Use key</button></div>
		</form>`).join("");
	for (const form of box.querySelectorAll("form")) {
		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			const input = form.querySelector("input");
			const value = input.value.trim();
			if (!value) {
				input.focus();
				return;
			}
			try {
				await api("POST", "/api/key", { env: form.dataset.env, value });
				input.value = "";
				await refreshSchedule();
				renderKeys();
				renderRunState();
				saleItems.game = null;
				renderView();
				toast("Key added for this session", "success");
			} catch (error) {
				toast(error.message, "danger");
			}
		});
	}
}

function doctorRowHtml(probe) {
	const level = probe.status === "ok" ? "ok" : probe.status === "untested" ? "info" : probe.used ? "bad" : "warn";
	return `
		<li class="check ${level}">
			<span class="dot" aria-hidden="true">${DOCTOR_SYMBOLS[probe.status]}</span>
			<div><b>${h(probe.feature)}</b>${probe.used ? "" : ` <span class="hint">not in your plan</span>`}
				<div class="hint mono">${h(probe.permission)}</div>
				${probe.detail ? `<div class="hint">${h(probe.detail)}</div>` : ""}
			</div>
		</li>`;
}

async function runDoctor() {
	const box = $("runDoctorResult");
	const button = $("runDoctor");
	button.disabled = true;
	box.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
	try {
		const { probes } = await api("GET", `/api/doctor?${gameQuery()}`);
		const blocking = probes.filter((probe) => probe.used && (probe.status === "missing" || probe.status === "error"));
		const heading = blocking.length
			? `<div class="callout callout-danger">${blocking.length} permission${blocking.length === 1 ? "" : "s"} missing for your plan. Edit the key in Creator Hub (Open Cloud → API Keys) and add them for this game.</div>`
			: `<div class="callout callout-info">The key has everything your plan needs.</div>`;
		box.innerHTML = `${heading}<ul class="checks">${probes.map(doctorRowHtml).join("")}</ul>`;
	} catch (error) {
		box.innerHTML = errorBox(error);
	} finally {
		button.disabled = false;
	}
}

function setDrawer(open) {
	drawerOpen = open;
	$("drawer").classList.toggle("open", open);
	$("runDrawer").setAttribute("aria-expanded", String(open));
	$("runDrawer").textContent = open ? "▾" : "▴";
	if (open) {
		renderKeys();
		const log = $("runLog");
		log.scrollTop = log.scrollHeight;
	}
}

function preflightHtml(reports) {
	const multi = reports.length > 1;
	return reports.map((report) => `
		${multi ? `<div class="section-title" style="margin-top:10px">${h(report.game)} ${report.ready ? `<span class="badge badge-success">Ready</span>` : `<span class="badge badge-danger">Needs fixing</span>`}</div>` : ""}
		<ul class="checks">${report.checks.map((check) => `
			<li class="check ${check.level}">
				<span class="dot" aria-hidden="true">${CHECK_SYMBOLS_RUN[check.level]}</span>
				<div><b>${h(check.title)}</b>${check.detail ? `<div class="hint">${h(check.detail)}</div>` : ""}</div>
			</li>`).join("")}</ul>`).join("");
}

async function fetchPreflight() {
	const { reports, error } = await api("GET", "/api/preflight");
	if (error) {
		throw new Error(error);
	}
	return reports;
}

async function checkPlan() {
	const button = $("runCheck");
	button.disabled = true;
	button.textContent = "Checking…";
	try {
		const reports = await fetchPreflight();
		const problems = reports.flatMap((report) => report.checks).filter((check) => check.level === "bad").length;
		await dialog({
			title: problems ? `${problems} thing${problems === 1 ? "" : "s"} to fix first` : "Ready for the update",
			body: preflightHtml(reports),
			html: true,
			confirmText: "Close",
			cancelText: null,
		});
	} catch (error) {
		toast(error.message, "danger");
	} finally {
		button.disabled = false;
		button.textContent = "Check plan";
	}
}

function desktopAlert(line) {
	if (readSetting(DESKTOP_ALERTS_KEY) !== "on" || typeof Notification === "undefined" || Notification.permission !== "granted") {
		return;
	}
	const match = LOG_LINE.exec(line);
	const text = (match ? match[2] : line).replace(/^\s*/, "");
	const title = /REMINDER/.test(text) ? "Upload the next countdown icon" : /FAILED|ERROR/.test(text) ? "UpdateDay hit a problem" : "UpdateDay";
	try {
		new Notification(title, { body: text.replace(/^REMINDER [^:]+: /, "").slice(0, 180), tag: "updateday" });
	} catch {
	}
}

function alertNewLines(lines) {
	if (lastLines === null) {
		lastLines = lines;
		return;
	}
	const previous = lastLines[lastLines.length - 1];
	const start = previous === undefined ? 0 : lines.lastIndexOf(previous) + 1;
	for (const line of lines.slice(start)) {
		if (ALERT_LINE.test(line)) {
			desktopAlert(line);
		}
	}
	lastLines = lines;
}

async function pollRun() {
	clearTimeout(pollTimer);
	try {
		const status = await api("GET", "/api/status");
		const changed = status.mode !== runMode;
		runMode = status.mode;
		const text = status.log.join("\n");
		if (text !== lastLog) {
			lastLog = text;
			alertNewLines(status.log);
			const log = $("runLog");
			const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
			log.innerHTML = logHtml(status.log);
			if (atBottom) {
				log.scrollTop = log.scrollHeight;
			}
			if (runMode !== "idle") {
				await refreshSchedule();
			}
		}
		if (changed) {
			await refreshSchedule();
		}
		renderRunState();
	} catch {
	}
	pollTimer = setTimeout(pollRun, runMode === "idle" ? POLL_IDLE_MS : POLL_RUNNING_MS);
}

async function ensureSaved(verb) {
	if (!UD.dirty) {
		return true;
	}
	const sure = await dialog({ title: "Save first?", body: `${verb} uses the saved plan. Save your changes and continue?`, confirmText: "Save and continue" });
	if (!sure) {
		return false;
	}
	await save();
	return !UD.dirty;
}

async function runAction(action) {
	try {
		await api("POST", `/api/run/${action}`);
	} catch (error) {
		toast(error.message, "danger");
	}
	pollRun();
}

async function startRun() {
	if (!(await ensureSaved("Starting"))) {
		return;
	}
	const missing = keyEnvs().filter((game) => !game.hasKey);
	if (missing.length) {
		setDrawer(true);
		toast(`Add the API key (${missing[0].apiKeyEnv}) first`, "danger");
		return;
	}
	const button = $("runStart");
	button.disabled = true;
	button.textContent = "Checking…";
	let reports = [];
	try {
		reports = await fetchPreflight();
	} catch (error) {
		toast(`Couldn't check the plan: ${error.message}`, "danger");
	} finally {
		button.disabled = false;
		button.textContent = "Start";
	}
	const problems = reports.flatMap((report) => report.checks).filter((check) => check.level === "bad").length;
	if (problems) {
		const anyway = await dialog({
			title: `${problems} thing${problems === 1 ? "" : "s"} to fix first`,
			body: preflightHtml(reports),
			html: true,
			confirmText: "Start anyway",
			cancelText: "Fix first",
			danger: true,
		});
		if (!anyway) {
			return;
		}
	}
	await runAction("start");
	toast("Running. Keep UpdateDay open until the update is done.", "success");
}

async function dryRun() {
	if (!(await ensureSaved("A dry run"))) {
		return;
	}
	setDrawer(true);
	runAction("dryrun");
}

async function undoAll() {
	const sure = await dialog({
		title: "Undo everything?",
		body: "Puts every saved price and name back, removes the countdown icons and restores the game's language settings. Use this if an update is cancelled.",
		confirmText: "Undo everything",
		danger: true,
	});
	if (!sure) {
		return;
	}
	setDrawer(true);
	await runAction("restore");
	toast("Undo started. Watch the log for each item.", "success");
}

async function stopRun() {
	const sure = await dialog({ title: "Stop the run?", body: "Nothing more happens until you start again. Anything already changed stays as it is; use Undo all to put it back.", confirmText: "Stop", danger: true });
	if (sure) {
		runAction("stop");
	}
}

function initRunbar() {
	$("runbar").innerHTML = runbarHtml();
	$("runStart").addEventListener("click", startRun);
	$("runStop").addEventListener("click", stopRun);
	$("runDry").addEventListener("click", dryRun);
	$("runCheck").addEventListener("click", checkPlan);
	$("runUndo").addEventListener("click", undoAll);
	$("runDoctor").addEventListener("click", runDoctor);
	$("runDrawer").addEventListener("click", () => setDrawer(!drawerOpen));
	document.addEventListener("click", (event) => {
		if (event.target.closest(".js-add-key")) {
			setDrawer(true);
			document.querySelector("#runKeys input")?.focus();
		}
	});
	onChange(() => {
		renderRunState();
		const typing = [...document.querySelectorAll("#runKeys input")].some((input) => input.value);
		if (drawerOpen && !typing) {
			renderKeys();
		}
	});
	renderRunState();
	pollRun();
}
