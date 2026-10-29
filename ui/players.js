const DEFAULT_KEY_FORMAT = "{userId}";
const MAX_DIFF_LINES = 12;

let currentPlayer = null;
let currentEntry = null;
let playerEditor = null;

function playerHtml(player, extra) {
	return `
		<div class="player">
			${player.avatarUrl ? `<img src="${h(player.avatarUrl)}" alt="">` : `<img alt="">`}
			<div class="grow"><b>${h(player.displayName)}</b><div class="hint">@${h(player.name)} · ID ${player.id}</div></div>
			${extra ?? ""}
		</div>`;
}

function lookupHtml(id) {
	return `
		<form class="row" id="${id}Form" style="align-items:flex-end">
			<label class="field" style="flex:1"><span>Player</span><input type="search" id="${id}" placeholder="Username or user ID" value="${h(currentPlayer?.name ?? "")}" autocomplete="off"></label>
			<div class="field" style="flex:none"><button class="btn btn-primary" type="submit">Look up</button></div>
		</form>`;
}

function bindLookup(id, onFound) {
	const input = $(id);
	$(`${id}Form`).addEventListener("submit", async (event) => {
		event.preventDefault();
		const query = input.value.trim();
		if (!query) {
			input.focus();
			return;
		}
		const button = event.submitter;
		button.disabled = true;
		try {
			const result = await api("GET", `/api/player?${gameQuery()}&q=${encodeURIComponent(query)}`);
			currentPlayer = result.player;
			onFound(result);
		} catch (error) {
			toast(error.message, "danger");
		} finally {
			button.disabled = false;
		}
	});
}

function playerDataSettings() {
	const game = currentGame();
	game.playerData = game.playerData || { dataStore: "", keyFormat: DEFAULT_KEY_FORMAT };
	return game.playerData;
}

function playerKey() {
	const format = $("pdKey").value.trim() || DEFAULT_KEY_FORMAT;
	return format.replace(/\{userId\}/g, String(currentPlayer.id));
}

function changedPaths(before, after, prefix = "") {
	if (JSON.stringify(before) === JSON.stringify(after)) {
		return [];
	}
	const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
	const bothArrays = Array.isArray(before) && Array.isArray(after);
	if (!bothArrays && (!isObject(before) || !isObject(after))) {
		return [{ path: prefix || "(whole value)", before, after }];
	}
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	const childPath = (key) => (bothArrays ? `${prefix}[${key}]` : prefix ? `${prefix}.${key}` : key);
	return [...keys].flatMap((key) => changedPaths(before[key], after[key], childPath(key)));
}

function entryQuery(store, key) {
	return `${gameQuery()}&ds=${encodeURIComponent(store)}&key=${encodeURIComponent(key)}`;
}

async function savePlayerData(store, key) {
	let value;
	try {
		value = playerEditor.getValue();
	} catch (error) {
		$("pdError").innerHTML = errorBox(error);
		return;
	}
	$("pdError").innerHTML = "";
	const changes = changedPaths(currentEntry?.value ?? null, value);
	if (changes.length === 0) {
		toast("Nothing changed");
		return;
	}
	const shown = (value, missing) => (value === undefined ? missing : JSON.stringify(value));
	const lines = changes.slice(0, MAX_DIFF_LINES).map((change) => `${change.path}: ${shown(change.before, "(new)")} → ${shown(change.after, "(removed)")}`);
	if (changes.length > MAX_DIFF_LINES) {
		lines.push(`…and ${changes.length - MAX_DIFF_LINES} more`);
	}
	const sure = await dialog({
		title: `Save ${currentPlayer.name}'s data?`,
		body: `<p>A backup is saved first.</p><pre>${h(lines.join("\n"))}</pre>`,
		html: true,
		confirmText: "Save changes",
	});
	if (!sure) {
		return;
	}
	try {
		await api("PUT", `/api/entry?${entryQuery(store, key)}`, { value, etag: currentEntry?.etag ?? null });
		toast("Saved. The old data is in the backups.", "success");
		showPlayerData();
	} catch (error) {
		$("pdError").innerHTML = errorBox(error);
	}
}

function pendingChanges() {
	try {
		return changedPaths(currentEntry?.value ?? null, playerEditor.getValue()).length;
	} catch {
		return 0;
	}
}

function showChangeCount() {
	const count = pendingChanges();
	$("pdChanges").textContent = count ? `${count} unsaved change${count === 1 ? "" : "s"}` : "";
}

async function reloadPlayerData() {
	if (pendingChanges() > 0) {
		const sure = await dialog({ title: "Discard your edits?", body: "Reloading reads the player's data from Roblox again and drops the changes you haven't saved.", confirmText: "Discard and reload", danger: true });
		if (!sure) {
			return;
		}
	}
	showPlayerData();
}

function backupsHtml(backups) {
	if (!backups.length) {
		return `<div class="hint">None yet. One is made before every change.</div>`;
	}
	return `<div class="list">${backups.map((backup) => `
		<div class="list-row">
			<span class="hint">${h(formatWhen(backup.savedAt))}</span>
			<span>${h(backup.reason)}</span>
			<button class="btn btn-sm" data-file="${h(backup.file)}">Restore</button>
		</div>`).join("")}</div>`;
}

async function showPlayerData() {
	const result = $("pdResult");
	const store = $("pdStore").value;
	if (!store) {
		result.innerHTML = playerHtml(currentPlayer) + `<div class="callout callout-info">Pick the data store your game saves players in.</div>`;
		return;
	}
	const key = playerKey();
	result.innerHTML = playerHtml(currentPlayer) + `<div class="skeleton" style="height:220px"></div>`;
	try {
		const { entry, backups } = await api("GET", `/api/entry?${entryQuery(store, key)}`);
		currentEntry = entry;
		result.innerHTML = `
			${playerHtml(currentPlayer, `<span class="badge">${h(store)} / ${h(key)}</span>`)}
			${entry ? "" : `<div class="callout callout-warning" style="margin-bottom:12px">No saved data for this player under that key yet.</div>`}
			<div class="field"><span>Saved data</span><div id="pdEditor"></div></div>
			<div id="pdError"></div>
			<div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-bottom:18px">
				<span class="change-count" id="pdChanges" aria-live="polite"></span>
				<span style="flex:1"></span>
				<button class="btn" id="pdReload">Reload</button>
				<button class="btn btn-primary" id="pdSave">Save changes</button>
			</div>
			<div class="section-title">Backups, newest first</div>
			${backupsHtml(backups)}`;
		playerEditor = createJsonEditor($("pdEditor"), entry ? entry.value : null, showChangeCount);
		$("pdSave").addEventListener("click", () => savePlayerData(store, key));
		$("pdReload").addEventListener("click", reloadPlayerData);
		for (const button of result.querySelectorAll("[data-file]")) {
			button.addEventListener("click", async () => {
				const sure = await dialog({ title: "Restore this backup?", body: "The player's current data is backed up first, so you can undo this too.", confirmText: "Restore" });
				if (!sure) {
					return;
				}
				try {
					await api("POST", `/api/entry?${entryQuery(store, key)}`, { restore: button.dataset.file });
					toast("Backup restored", "success");
					showPlayerData();
				} catch (error) {
					toast(error.message, "danger");
				}
			});
		}
	} catch (error) {
		result.innerHTML = playerHtml(currentPlayer) + errorBox(error);
	}
}

async function loadDataStores(settings) {
	const select = $("pdStore");
	try {
		const { dataStores } = await api("GET", `/api/datastores?${gameQuery()}`);
		select.innerHTML = `<option value="">Pick a data store</option>` + dataStores.map((name) => `<option ${name === settings.dataStore ? "selected" : ""}>${h(name)}</option>`).join("");
		select.disabled = false;
	} catch (error) {
		select.innerHTML = `<option value="">Couldn't load data stores</option>`;
		$("pdStoreError").innerHTML = errorBox(error);
	}
}

function renderPlayers(root) {
	if (!currentGame()?.universeId) {
		root.innerHTML = `<div class="card">${emptyState("Add the game link first", "Player data is read from the game's data stores.")}</div>`;
		return;
	}
	const settings = currentGame().playerData ?? { dataStore: "", keyFormat: DEFAULT_KEY_FORMAT };
	root.innerHTML = `
		<div class="grid-2">
			<div class="stack">
				<div class="card">
					<div class="card-head"><div><h2>Find a player</h2><div class="hint">Look up a player's saved data, change it, and put it back.</div></div></div>
					${lookupHtml("pdLookup")}
					<div id="pdResult">${currentPlayer ? "" : emptyState("No player picked", "Search by username or user ID.")}</div>
				</div>
			</div>
			<div class="stack">
				<div class="card">
					<div class="card-head"><div><h2>Where players are saved</h2><div class="hint">Remembered for this game.</div></div></div>
					<label class="field"><span>Data store</span><select id="pdStore" disabled><option>Loading…</option></select></label>
					<div id="pdStoreError"></div>
					<label class="field"><span>Key</span><input type="text" id="pdKey" class="mono" value="${h(settings.keyFormat)}"><span class="hint">{userId} becomes the player's ID, e.g. Player_{userId}.</span></label>
				</div>
				<div class="callout callout-info">A backup is saved before every change, and saves check nobody else wrote in between.</div>
			</div>
		</div>`;
	$("pdKey").addEventListener("change", (event) => {
		playerDataSettings().keyFormat = event.target.value.trim() || DEFAULT_KEY_FORMAT;
		markDirty();
	});
	$("pdStore").addEventListener("change", (event) => {
		playerDataSettings().dataStore = event.target.value;
		markDirty();
		if (currentPlayer) {
			showPlayerData();
		}
	});
	bindLookup("pdLookup", showPlayerData);
	loadDataStores(settings).then(() => {
		if (currentPlayer && UD.view === "players") {
			showPlayerData();
		}
	});
}

UD.views.players = {
	label: "Player data",
	render: renderPlayers,
};
