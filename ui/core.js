const UD = {
	draft: null,
	schedule: null,
	revision: 0,
	selected: 0,
	view: "countdown",
	dirty: false,
	configPath: "",
	views: {},
	listeners: new Set(),
};

const ALL_MARKS = ["24h", "12h", "6h", "5h", "4h", "3h", "2h", "1h", "45m", "30m", "15m", "10m", "5m"];
const UNIT_MS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
const PUSH_DEBOUNCE_MS = 350;
const TOAST_MS = 4200;
const THEME_KEY = "updateday-theme";
const DESKTOP_ALERTS_KEY = "updateday-desktop-alerts";
const LOCALE = "en-US";

let pushTimer = null;

const $ = (id) => document.getElementById(id);

function h(text) {
	return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(method, path, body, isBinary) {
	const options = { method, headers: {} };
	if (body !== undefined) {
		options.body = isBinary ? body : JSON.stringify(body);
		options.headers["content-type"] = isBinary ? "application/octet-stream" : "application/json";
	}
	const response = await fetch(path, options);
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(data.error || `Request failed (${response.status})`);
	}
	return data;
}

function offsetMs(mark) {
	const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(mark);
	return match ? Number(match[1]) * UNIT_MS[match[2]] : 0;
}

function toLocalInput(iso) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return new Date(date.getTime() - date.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
}

function fromLocalInput(value) {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatWhen(date) {
	return new Date(date).toLocaleString(LOCALE, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatTime(date) {
	return new Date(date).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatSpan(ms) {
	const total = Math.max(0, Math.round(ms / 1000));
	const days = Math.floor(total / 86400);
	const hours = Math.floor((total % 86400) / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${total}s`;
}

function clock(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function stageName(mark) {
	if (mark === "now") {
		return "NOW!";
	}
	const match = /^(\d+)([mh])$/.exec(mark);
	if (!match) {
		return mark.toUpperCase();
	}
	const n = Number(match[1]);
	return `${n} ${match[2] === "h" ? "hour" : "min"}${n === 1 ? "" : "s"}`;
}

function currentGame() {
	return UD.draft?.games?.[UD.selected] ?? null;
}

function scheduledGame(index = UD.selected) {
	return UD.schedule?.games?.[index] ?? null;
}

function gameUpdateAt(game) {
	return new Date(game?.updateAt ?? UD.draft.updateAt);
}

function countdown() {
	if (UD.draft.countdown === false) {
		return null;
	}
	UD.draft.countdown = UD.draft.countdown || {};
	return UD.draft.countdown;
}

function gameQuery() {
	return `game=${UD.selected}`;
}

function iconUrl(mark, index = UD.selected) {
	return `/api/icon?game=${index}&mark=${encodeURIComponent(mark)}&r=${UD.revision}`;
}

function onChange(listener) {
	UD.listeners.add(listener);
}

function notify() {
	for (const listener of UD.listeners) {
		listener();
	}
}

function markDirty() {
	UD.dirty = true;
	renderSaveState();
	clearTimeout(pushTimer);
	pushTimer = setTimeout(pushDraft, PUSH_DEBOUNCE_MS);
}

async function pushDraft() {
	try {
		const result = await api("PUT", "/api/draft", UD.draft);
		UD.revision = result.revision;
		await refreshSchedule();
	} catch (error) {
		toast(error.message, "danger");
	}
}

async function refreshSchedule() {
	UD.schedule = await api("GET", "/api/schedule");
	renderSaveState();
	notify();
}

function renderSaveState() {
	const status = $("saveStatus");
	const button = $("saveBtn");
	if (!status || !button) {
		return;
	}
	const error = UD.schedule?.error;
	status.dataset.state = error ? "error" : UD.dirty ? "dirty" : "saved";
	status.textContent = error ? "Fix the highlighted problem to save" : UD.dirty ? "Unsaved changes" : "All changes saved";
	button.disabled = !UD.dirty || Boolean(error);
}

async function save() {
	try {
		if (pushTimer) {
			clearTimeout(pushTimer);
			pushTimer = null;
			await pushDraft();
		}
		const result = await api("POST", "/api/save");
		UD.dirty = false;
		renderSaveState();
		toast(result.running ? "Saved. Stop and start the run to use these changes." : "Saved", "success");
	} catch (error) {
		toast(error.message, "danger");
	}
}

function toast(message, kind = "info") {
	const region = $("toasts");
	const item = document.createElement("div");
	item.className = `toast toast-${kind}`;
	item.setAttribute("role", kind === "danger" ? "alert" : "status");
	item.innerHTML = `<span>${h(message)}</span><button class="icon-btn" aria-label="Dismiss">✕</button>`;
	item.querySelector("button").addEventListener("click", () => item.remove());
	region.appendChild(item);
	setTimeout(() => item.remove(), kind === "danger" ? TOAST_MS * 2 : TOAST_MS);
}

function dialog({ title, body, confirmText = "Confirm", cancelText = "Cancel", danger = false, html = false }) {
	return new Promise((resolve) => {
		const element = $("dialog");
		element.innerHTML = `
			<form method="dialog" class="dialog-body">
				<h2>${h(title)}</h2>
				<div class="dialog-text">${html ? body : `<p>${h(body)}</p>`}</div>
				<div class="dialog-actions">
					${cancelText === null ? "" : `<button value="cancel" class="btn btn-secondary">${h(cancelText)}</button>`}
					<button value="confirm" class="btn ${danger ? "btn-danger" : "btn-primary"}">${h(confirmText)}</button>
				</div>
			</form>`;
		element.returnValue = "";
		element.addEventListener("close", () => resolve(element.returnValue === "confirm"), { once: true });
		element.querySelector("form").addEventListener("keydown", (event) => {
			if (event.key === "Enter" && event.target.matches("input")) {
				event.preventDefault();
				element.close("confirm");
			}
		});
		element.showModal();
		const firstInput = element.querySelector(".dialog-text input, .dialog-text select");
		const preferred = element.querySelector(`button[value="${danger && cancelText !== null ? "cancel" : "confirm"}"]`);
		(firstInput ?? preferred).focus();
	});
}

function switchHtml(id, checked, label, hint) {
	return `
		<label class="switch-row" for="${id}">
			<span class="switch-text"><span class="switch-label">${label}</span>${hint ? `<span class="hint">${hint}</span>` : ""}</span>
			<input type="checkbox" role="switch" class="switch" id="${id}" ${checked ? "checked" : ""}>
		</label>`;
}

function segmentedHtml(name, options, value) {
	const buttons = options.map(([key, label]) => `<button type="button" role="radio" aria-checked="${key === value}" data-value="${h(key)}" class="${key === value ? "active" : ""}">${label}</button>`);
	return `<div class="segmented" role="radiogroup" data-name="${name}">${buttons.join("")}</div>`;
}

function bindSegmented(root, name, onPick) {
	const group = root.querySelector(`.segmented[data-name="${name}"]`);
	if (!group) {
		return;
	}
	for (const button of group.querySelectorAll("button")) {
		button.addEventListener("click", () => {
			for (const other of group.querySelectorAll("button")) {
				other.classList.toggle("active", other === button);
				other.setAttribute("aria-checked", String(other === button));
			}
			onPick(button.dataset.value);
		});
	}
}

function emptyState(title, text, action) {
	return `
		<div class="empty">
			<div class="empty-title">${h(title)}</div>
			${text ? `<div class="empty-text">${text}</div>` : ""}
			${action ?? ""}
		</div>`;
}

function errorBox(error) {
	const text = String(error?.message ?? error);
	const action = /API key/.test(text) ? `<button class="btn btn-sm js-add-key" style="margin-top:10px">Add API key</button>` : "";
	return `<div class="callout callout-danger" role="alert">${h(text)}${action ? `<div>${action}</div>` : ""}</div>`;
}

function readSetting(key) {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeSetting(key, value) {
	try {
		if (value === null) {
			localStorage.removeItem(key);
		} else {
			localStorage.setItem(key, value);
		}
	} catch {
	}
}

function downloadUrl(url) {
	const link = document.createElement("a");
	link.href = url;
	link.download = "";
	document.body.appendChild(link);
	link.click();
	link.remove();
}

function loadTheme() {
	try {
		const saved = localStorage.getItem(THEME_KEY);
		if (saved) {
			document.documentElement.dataset.theme = saved;
		}
	} catch {
	}
}

function toggleTheme() {
	const dark = document.documentElement.dataset.theme
		? document.documentElement.dataset.theme === "dark"
		: matchMedia("(prefers-color-scheme: dark)").matches;
	const next = dark ? "light" : "dark";
	document.documentElement.dataset.theme = next;
	try {
		localStorage.setItem(THEME_KEY, next);
	} catch {
	}
}

loadTheme();
