const DEFAULT_ADMIN_MINUTES = 60;
const DEFAULT_BLEED_MINUTES = 5;
const DEFAULT_BROADCAST = { topic: "UpdateDay", marks: ["10m", "5m", "1m"] };
const DEFAULT_KEY_ENV = "UPDATEDAY_API_KEY";
const QUICK_TIMES = [["+1 hour", 36e5], ["+1 day", 864e5], ["+1 week", 6048e5]];
const REPEAT_OPTIONS = [["", "Doesn't repeat"], ["day", "Every day"], ["week", "Every week"], ["2weeks", "Every 2 weeks"], ["month", "Every month"]];
const DEFAULT_WEBHOOK_ENV = "UPDATEDAY_DISCORD_WEBHOOK";
const ALERT_EVENTS = [["reminders", "Upload reminders"], ["failures", "Problems"], ["live", "Update is live"], ["finished", "All done"], ["steps", "Every step"]];
const DEFAULT_ALERT_EVENTS = ["reminders", "failures", "live", "finished"];
const MENTIONS = [["", "No ping"], ["@here", "@here"], ["@everyone", "@everyone"], ["custom", "A role or person…"]];

function setOrDelete(target, key, value) {
	if (value === undefined || value === null || value === "") {
		delete target[key];
	} else {
		target[key] = value;
	}
}

function gameCardHtml(game) {
	return `
		<div class="card">
			<div class="card-head"><div><h2>This game</h2><div class="hint">Paste the Roblox link and UpdateDay fills in the rest.</div></div></div>
			<form id="setLookupForm" class="row" style="align-items:flex-end">
				<label class="field" style="flex:1"><span>Game link or place ID</span><input type="text" id="setLookup" placeholder="https://www.roblox.com/games/…" autocomplete="off"></label>
				<div class="field" style="flex:none"><button class="btn ${game.universeId ? "" : "btn-primary"}" type="submit">Find game</button></div>
			</form>
			<div id="setLookupError"></div>
			<div class="row">
				<label class="field"><span>Name</span><input type="text" id="setName" placeholder="Shown in UpdateDay only" value="${h(game.name ?? "")}"></label>
				<label class="field"><span>Universe ID</span><input type="number" id="setUniverse" class="mono" value="${h(game.universeId ?? "")}"></label>
			</div>
			<div class="card-section">
				${switchHtml("setOwnTime", Boolean(game.updateAt), "Own update time", "Use a different time from the other games.")}
				<div class="revealed" id="setOwnFields" ${game.updateAt ? "" : "hidden"}>
					<label class="field"><span>This game updates at</span><input type="datetime-local" id="setOwnAt" value="${game.updateAt ? toLocalInput(game.updateAt) : ""}"></label>
				</div>
			</div>
			<details class="card-section">
				<summary class="section-title" style="cursor:pointer">Advanced</summary>
				<label class="field" style="margin-top:12px"><span>API key name</span><input type="text" id="setKeyEnv" class="mono" placeholder="${DEFAULT_KEY_ENV}" value="${h(game.apiKeyEnv ?? "")}"><span class="hint">Only for a game owned by another account or group that needs its own key.</span></label>
			</details>
			<div class="card-section" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
				<span class="hint">Removing a game only takes it out of this plan.</span>
				<button class="btn btn-sm btn-danger-ghost" id="setRemove">Remove game</button>
			</div>
		</div>`;
}

function sharedTimeHtml() {
	return `
		<div class="card">
			<div class="card-head"><div><h2>Update time</h2><div class="hint">Shared by every game without its own time.</div></div></div>
			<label class="field"><span>Update goes live at</span><input type="datetime-local" id="setUpdateAt" value="${toLocalInput(UD.draft.updateAt)}"></label>
			<div class="chips" style="margin:-4px 0 14px">
				${QUICK_TIMES.map(([label, ms]) => `<button type="button" class="chip" data-shift="${ms}">${label}</button>`).join("")}
			</div>
			${repeatHtml()}
			<label class="field"><span>Admin-abuse length (minutes)</span><input type="number" id="setAdmin" min="5" max="600" value="${UD.draft.adminAbuseMinutes ?? DEFAULT_ADMIN_MINUTES}"><span class="hint">How long the icon stays on NOW, and the length of a quick sale.</span></label>
		</div>`;
}

function extrasHtml() {
	const restart = UD.draft.restartServers;
	const broadcast = UD.draft.broadcast;
	return `
		<div class="card">
			<div class="card-head"><div><h2>At update time</h2><div class="hint">Shared by every game.</div></div></div>
			${switchHtml("setRestartOn", Boolean(restart), "Restart old servers", "Move players onto the new version.")}
			<div class="revealed" id="setRestartFields" ${restart ? "" : "hidden"}>
				<label class="field"><span>Let players finish for (minutes)</span><input type="number" id="setBleed" min="0" max="60" value="${restart?.bleedOffMinutes ?? DEFAULT_BLEED_MINUTES}"><span class="hint">0 restarts right away.</span></label>
			</div>
			<div class="card-section">
				${switchHtml("setWarnOn", Boolean(broadcast), "Warn players in live servers", "Sends a message your game shows before the update.")}
				<div class="revealed" id="setWarnFields" ${broadcast ? "" : "hidden"}>
					<div class="row">
						<label class="field"><span>When</span><input type="text" id="setWarnMarks" value="${h((broadcast?.marks ?? DEFAULT_BROADCAST.marks).join(", "))}"><span class="hint">Before the update, e.g. 10m, 5m, 1m.</span></label>
						<label class="field"><span>Topic</span><input type="text" id="setWarnTopic" class="mono" value="${h(broadcast?.topic ?? DEFAULT_BROADCAST.topic)}"></label>
					</div>
					<div class="callout callout-info" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
						<span>Show a live "UPDATE IN 04:59" banner and these warnings in your game with the Roblox kit.</span>
						<button class="btn btn-sm" id="setKit">Download kit</button>
					</div>
				</div>
			</div>
		</div>`;
}

async function lookupInto(game, root) {
	const input = $("setLookup");
	const text = input.value.trim();
	const errorSlot = $("setLookupError");
	errorSlot.innerHTML = "";
	if (!text) {
		input.focus();
		return;
	}
	try {
		const found = await api("GET", `/api/lookup?q=${encodeURIComponent(text)}`);
		game.universeId = found.universeId;
		if (!game.name && found.name) {
			game.name = found.name;
		}
		markDirty();
		renderSidebar();
		renderHeader();
		renderSettings(root);
		toast(`Found ${found.name || `universe ${found.universeId}`}`, "success");
	} catch (error) {
		errorSlot.innerHTML = errorBox(`Couldn't find that game: ${error.message}`);
	}
}

function bindGameCard(root, game) {
	root.querySelector("#setLookupForm").addEventListener("submit", (event) => {
		event.preventDefault();
		lookupInto(game, root);
	});
	root.querySelector("#setName").addEventListener("input", (event) => {
		game.name = event.target.value;
		markDirty();
		renderSidebar();
		renderHeader();
	});
	root.querySelector("#setUniverse").addEventListener("change", (event) => {
		game.universeId = Number(event.target.value) || undefined;
		markDirty();
		renderSidebar();
		renderHeader();
	});
	root.querySelector("#setOwnTime").addEventListener("change", (event) => {
		if (event.target.checked) {
			game.updateAt = UD.draft.updateAt;
			root.querySelector("#setOwnAt").value = toLocalInput(game.updateAt);
		} else {
			delete game.updateAt;
		}
		root.querySelector("#setOwnFields").hidden = !event.target.checked;
		markDirty();
		renderHeader();
	});
	root.querySelector("#setOwnAt").addEventListener("change", (event) => {
		const iso = fromLocalInput(event.target.value);
		if (iso) {
			game.updateAt = iso;
			markDirty();
			renderHeader();
		}
	});
	root.querySelector("#setKeyEnv").addEventListener("change", (event) => {
		setOrDelete(game, "apiKeyEnv", event.target.value.trim());
		markDirty();
	});
	root.querySelector("#setRemove").addEventListener("click", async () => {
		const sure = await dialog({ title: `Remove ${game.name || "this game"}?`, body: "It comes out of the plan. Nothing changes on Roblox.", confirmText: "Remove game", danger: true });
		if (!sure) {
			return;
		}
		UD.draft.games.splice(UD.selected, 1);
		UD.selected = Math.max(0, Math.min(UD.selected, UD.draft.games.length - 1));
		markDirty();
		renderAll();
	});
}

function bindShared(root) {
	const updateInput = root.querySelector("#setUpdateAt");
	const setUpdate = (iso) => {
		UD.draft.updateAt = iso;
		updateInput.value = toLocalInput(iso);
		markDirty();
		renderSidebar();
		renderHeader();
	};
	updateInput.addEventListener("change", () => {
		const iso = fromLocalInput(updateInput.value);
		if (iso) {
			setUpdate(iso);
		}
	});
	for (const chip of root.querySelectorAll("[data-shift]")) {
		chip.addEventListener("click", () => setUpdate(new Date(Date.parse(UD.draft.updateAt) + Number(chip.dataset.shift)).toISOString()));
	}
	root.querySelector("#setAdmin").addEventListener("change", (event) => {
		UD.draft.adminAbuseMinutes = Number(event.target.value) || DEFAULT_ADMIN_MINUTES;
		markDirty();
	});
	const restart = () => UD.draft.restartServers || (UD.draft.restartServers = { bleedOffMinutes: DEFAULT_BLEED_MINUTES });
	root.querySelector("#setRestartOn").addEventListener("change", (event) => {
		if (event.target.checked) {
			restart();
		} else {
			delete UD.draft.restartServers;
		}
		root.querySelector("#setRestartFields").hidden = !event.target.checked;
		markDirty();
	});
	root.querySelector("#setBleed").addEventListener("input", (event) => {
		restart().bleedOffMinutes = Number(event.target.value);
		markDirty();
	});
	const broadcast = () => UD.draft.broadcast || (UD.draft.broadcast = { ...DEFAULT_BROADCAST, marks: [...DEFAULT_BROADCAST.marks] });
	root.querySelector("#setWarnOn").addEventListener("change", (event) => {
		if (event.target.checked) {
			broadcast();
		} else {
			delete UD.draft.broadcast;
		}
		root.querySelector("#setWarnFields").hidden = !event.target.checked;
		markDirty();
	});
	root.querySelector("#setWarnMarks").addEventListener("change", (event) => {
		broadcast().marks = event.target.value.split(/[\s,]+/).filter(Boolean);
		markDirty();
	});
	root.querySelector("#setWarnTopic").addEventListener("change", (event) => {
		broadcast().topic = event.target.value.trim() || DEFAULT_BROADCAST.topic;
		markDirty();
	});
}

function repeatHtml() {
	const repeat = UD.draft.repeat;
	const next = scheduledGame()?.nextUpdateAt;
	return `
		<div class="row">
			<label class="field"><span>Repeat</span>
				<select id="setRepeat">${REPEAT_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === (repeat?.every ?? "") ? "selected" : ""}>${label}</option>`).join("")}</select>
			</label>
			<label class="field" ${repeat ? "" : "hidden"} id="setUntilField"><span>Until (optional)</span><input type="date" id="setUntil" value="${repeat?.until ? repeat.until.slice(0, 10) : ""}"></label>
		</div>
		${repeat ? `<div class="hint" id="setRepeatHint" style="margin:-4px 0 12px">${repeatHint(next)}</div>` : ""}`;
}

function repeatHint(next) {
	return next ? `After this one: ${h(formatWhen(next))}. Sales and events repeat too.` : "This is the last one.";
}

function mentionChoice(mention) {
	if (!mention) {
		return "";
	}
	return ["@here", "@everyone"].includes(mention) ? mention : "custom";
}

function alertsHtml() {
	const notify = UD.draft.notify;
	const events = notify?.events ?? DEFAULT_ALERT_EVENTS;
	const game = scheduledGame();
	const choice = mentionChoice(notify?.mention);
	const desktop = readSetting(DESKTOP_ALERTS_KEY) === "on";
	return `
		<div class="card">
			<div class="card-head"><div><h2>Alerts</h2><div class="hint">Know what's happening without watching UpdateDay.</div></div></div>
			${switchHtml("setDiscordOn", Boolean(notify), "Discord alerts", "Posts to a channel through a webhook, with the icon to upload attached.")}
			<div class="revealed" id="setDiscordFields" ${notify ? "" : "hidden"}>
				<form class="row" id="setHookForm" style="align-items:flex-end">
					<label class="field" style="flex:1"><span>Webhook link ${game?.hasWebhook ? `<span class="badge badge-success">Set</span>` : `<span class="badge badge-warning">Missing</span>`}</span><input type="password" id="setHook" autocomplete="off" placeholder="${game?.hasWebhook ? "Paste to replace" : "https://discord.com/api/webhooks/…"}"></label>
					<div class="field" style="flex:none"><button class="btn btn-sm" type="submit">Use link</button></div>
				</form>
				<div class="hint" style="margin:-4px 0 12px">Channel settings → Integrations → Webhooks → Copy link. Kept in memory only, like the API key.</div>
				<div class="field"><span>Send an alert for</span>
					<div class="chips" id="setAlertEvents">${ALERT_EVENTS.map(([value, label]) => `<button type="button" class="chip ${events.includes(value) ? "active" : ""}" aria-pressed="${events.includes(value)}" data-alert="${value}">${label}</button>`).join("")}</div>
				</div>
				<div class="row">
					<label class="field"><span>Ping</span><select id="setMention">${MENTIONS.map(([value, label]) => `<option value="${value}" ${value === choice ? "selected" : ""}>${label}</option>`).join("")}</select></label>
					<label class="field" id="setMentionField" ${choice === "custom" ? "" : "hidden"}><span>Role or person</span><input type="text" id="setMentionText" class="mono" placeholder="<@&role id> or <@user id>" value="${h(choice === "custom" ? notify.mention : "")}"></label>
				</div>
				<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
					<details class="hint"><summary style="cursor:pointer">Advanced</summary>
						<label class="field" style="margin-top:10px"><span>Webhook variable name</span><input type="text" id="setHookEnv" class="mono" value="${h(notify?.discordWebhookEnv ?? DEFAULT_WEBHOOK_ENV)}"><span class="hint">For running from GitHub Actions or a server.</span></label>
					</details>
					<button class="btn btn-sm" id="setHookTest">Send a test</button>
				</div>
			</div>
			<div class="card-section">
				${switchHtml("setDesktop", desktop, "Desktop alerts on this computer", "Pops up when an icon needs uploading or something goes wrong, while UpdateDay is open.")}
			</div>
		</div>`;
}

function notifySettings() {
	UD.draft.notify = UD.draft.notify || { events: [...DEFAULT_ALERT_EVENTS] };
	return UD.draft.notify;
}

function bindAlerts(root) {
	root.querySelector("#setDiscordOn").addEventListener("change", (event) => {
		if (event.target.checked) {
			notifySettings();
		} else {
			delete UD.draft.notify;
		}
		root.querySelector("#setDiscordFields").hidden = !event.target.checked;
		markDirty();
	});
	root.querySelector("#setHookForm").addEventListener("submit", async (event) => {
		event.preventDefault();
		const input = root.querySelector("#setHook");
		const value = input.value.trim();
		if (!value) {
			input.focus();
			return;
		}
		try {
			await api("POST", "/api/key", { env: UD.draft.notify?.discordWebhookEnv ?? DEFAULT_WEBHOOK_ENV, value, kind: "webhook" });
			input.value = "";
			await refreshSchedule();
			renderSettings(root);
			toast("Webhook added for this session", "success");
		} catch (error) {
			toast(error.message, "danger");
		}
	});
	for (const chip of root.querySelectorAll("[data-alert]")) {
		chip.addEventListener("click", () => {
			const settings = notifySettings();
			const events = new Set(settings.events ?? DEFAULT_ALERT_EVENTS);
			if (events.has(chip.dataset.alert)) {
				events.delete(chip.dataset.alert);
			} else {
				events.add(chip.dataset.alert);
			}
			settings.events = ALERT_EVENTS.map(([value]) => value).filter((value) => events.has(value));
			chip.classList.toggle("active", events.has(chip.dataset.alert));
			chip.setAttribute("aria-pressed", String(events.has(chip.dataset.alert)));
			markDirty();
		});
	}
	root.querySelector("#setMention").addEventListener("change", (event) => {
		const custom = event.target.value === "custom";
		root.querySelector("#setMentionField").hidden = !custom;
		setOrDelete(notifySettings(), "mention", custom ? root.querySelector("#setMentionText").value.trim() : event.target.value);
		markDirty();
	});
	root.querySelector("#setMentionText").addEventListener("change", (event) => {
		setOrDelete(notifySettings(), "mention", event.target.value.trim());
		markDirty();
	});
	root.querySelector("#setHookEnv").addEventListener("change", (event) => {
		const value = event.target.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
		setOrDelete(notifySettings(), "discordWebhookEnv", value === DEFAULT_WEBHOOK_ENV ? "" : value);
		markDirty();
	});
	root.querySelector("#setHookTest").addEventListener("click", async () => {
		try {
			await pushDraft();
			await api("POST", `/api/notify-test?${gameQuery()}`);
			toast("Test sent. Check your Discord channel.", "success");
		} catch (error) {
			toast(error.message, "danger");
		}
	});
	root.querySelector("#setDesktop").addEventListener("change", async (event) => {
		if (!event.target.checked) {
			writeSetting(DESKTOP_ALERTS_KEY, null);
			return;
		}
		const permission = typeof Notification === "undefined" ? "denied" : await Notification.requestPermission();
		if (permission !== "granted") {
			event.target.checked = false;
			toast("Your browser blocked notifications. Allow them for this page and try again.", "danger");
			return;
		}
		writeSetting(DESKTOP_ALERTS_KEY, "on");
		new Notification("UpdateDay", { body: "Desktop alerts are on." });
	});
}

function bindRepeat(root) {
	const select = root.querySelector("#setRepeat");
	const until = root.querySelector("#setUntil");
	const apply = () => {
		if (!select.value) {
			delete UD.draft.repeat;
		} else {
			UD.draft.repeat = { every: select.value };
			if (until.value) {
				UD.draft.repeat.until = new Date(`${until.value}T23:59:59`).toISOString();
			}
		}
		markDirty();
	};
	select.addEventListener("change", () => {
		apply();
		renderSettings(root);
	});
	until.addEventListener("change", apply);
}

function renderSettings(root) {
	const game = currentGame();
	root.innerHTML = `
		<div class="grid-2">
			<div class="stack">${gameCardHtml(game)}${alertsHtml()}</div>
			<div class="stack">${sharedTimeHtml()}${extrasHtml()}</div>
		</div>`;
	bindGameCard(root, game);
	bindShared(root);
	bindRepeat(root);
	bindAlerts(root);
	root.querySelector("#setKit").addEventListener("click", () => downloadUrl("/api/kit.zip"));
}

UD.views.settings = {
	label: "Settings",
	render: renderSettings,
	refresh() {
		const hint = $("setRepeatHint");
		if (hint) {
			hint.innerHTML = repeatHint(scheduledGame()?.nextUpdateAt);
		}
	},
};
