const TAB_ORDER = ["countdown", "sale", "events", "page", "players", "gifts", "history", "settings"];
const STATUS_TICK_MS = 15000;

function gameName(game, index) {
	return game?.name || (game?.universeId ? `Game ${game.universeId}` : `New game ${index + 1}`);
}

function gameStatus(game, index) {
	if (!game?.universeId) {
		return { text: "Needs a game link", tone: "warning" };
	}
	const scheduled = scheduledGame(index);
	const updateAt = gameUpdateAt(game).getTime();
	const now = Date.now();
	if (updateAt > now) {
		return { text: `Update in ${formatSpan(updateAt - now)}`, tone: "accent" };
	}
	const pending = scheduled?.steps?.some((step) => !step.done);
	return pending ? { text: "Update is live", tone: "success" } : { text: "Update finished", tone: "" };
}

function thumbFor(game, index) {
	return game?.universeId ? `/api/icon?game=${index}&raw=1&r=${game.universeId}` : "";
}

function renderSidebar() {
	const list = $("gameList");
	list.innerHTML = UD.draft.games.map((game, index) => {
		const status = gameStatus(game, index);
		const thumb = thumbFor(game, index);
		return `
			<button class="game-item" data-index="${index}" aria-current="${index === UD.selected}">
				${thumb ? `<img class="game-thumb" src="${thumb}" alt="">` : `<span class="game-thumb"></span>`}
				<span class="grow" style="min-width:0">
					<span class="name">${h(gameName(game, index))}</span>
					<span class="sub">${h(status.text)}</span>
				</span>
			</button>`;
	}).join("") || `<div class="hint" style="padding:4px 10px 10px">No games yet.</div>`;
	for (const item of list.querySelectorAll(".game-item")) {
		item.addEventListener("click", () => selectGame(Number(item.dataset.index)));
	}
	const select = $("mobileGame");
	select.innerHTML = UD.draft.games.map((game, index) => `<option value="${index}" ${index === UD.selected ? "selected" : ""}>${h(gameName(game, index))}</option>`).join("")
		+ `<option value="add">+ Add game</option>`;
}

function renderHeader() {
	const box = $("gameHeader");
	const game = currentGame();
	if (!game) {
		box.innerHTML = "";
		return;
	}
	const status = gameStatus(game, UD.selected);
	const thumb = thumbFor(game, UD.selected);
	const own = game.updateAt ? `<span class="badge">Own update time</span>` : "";
	const error = UD.schedule?.error ? `<div class="callout callout-danger" role="alert" style="margin-top:14px">${h(UD.schedule.error)}</div>` : "";
	box.innerHTML = `
		<div class="game-header">
			${thumb ? `<img class="game-thumb" src="${thumb}" alt="">` : `<span class="game-thumb"></span>`}
			<div style="min-width:0">
				<h1>${h(gameName(game, UD.selected))}</h1>
				<div class="meta">
					<span class="badge badge-${status.tone || "neutral"}">${h(status.text)}</span>
					${game.universeId ? `<span class="badge">${h(formatWhen(gameUpdateAt(game)))}</span>` : ""}
					${own}
				</div>
			</div>
		</div>${error}`;
}

function renderTabs() {
	const nav = $("tabs");
	const game = currentGame();
	if (!game) {
		nav.innerHTML = "";
		return;
	}
	nav.innerHTML = TAB_ORDER.map((key) => `
		<button class="tab" role="tab" id="tab-${key}" aria-controls="view" aria-selected="${key === UD.view}" tabindex="${key === UD.view ? 0 : -1}" data-view="${key}">${UD.views[key].label}</button>`).join("");
	for (const tab of nav.querySelectorAll(".tab")) {
		tab.addEventListener("click", () => showView(tab.dataset.view));
		tab.addEventListener("keydown", (event) => {
			const index = TAB_ORDER.indexOf(tab.dataset.view);
			const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
			if (step) {
				const next = TAB_ORDER[(index + step + TAB_ORDER.length) % TAB_ORDER.length];
				showView(next);
				$(`tab-${next}`).focus();
			}
		});
	}
}

function renderView() {
	const container = $("view");
	const game = currentGame();
	if (!game) {
		container.innerHTML = `
			<div class="card">${emptyState("Plan your first update day", "Add a game by pasting its Roblox link. UpdateDay will build countdown icons from its current icon, plan your sale and events, and run everything on time.", `<button class="btn btn-primary" id="emptyAdd">+ Add a game</button>`)}</div>`;
		$("emptyAdd").addEventListener("click", addGame);
		return;
	}
	container.setAttribute("aria-labelledby", `tab-${UD.view}`);
	UD.views[UD.view].render(container);
}

function showView(key) {
	UD.view = key;
	renderTabs();
	renderView();
}

function selectGame(index) {
	UD.selected = index;
	renderSidebar();
	renderHeader();
	renderView();
}

function addGame() {
	UD.draft.games.push({ name: "" });
	UD.selected = UD.draft.games.length - 1;
	UD.view = "settings";
	markDirty();
	renderAll();
	setTimeout(() => $("setLookup")?.focus(), 50);
}

function renderAll() {
	renderSidebar();
	renderHeader();
	renderTabs();
	renderView();
}

function refreshChrome() {
	renderSidebar();
	renderHeader();
	UD.views[UD.view]?.refresh?.();
}

async function init() {
	const loaded = await api("GET", "/api/draft");
	UD.draft = loaded.draft;
	UD.draft.games = UD.draft.games || [];
	UD.revision = loaded.revision;
	UD.configPath = loaded.configPath;
	$("configPath").textContent = loaded.configPath.split(/[\\/]/).pop();
	$("configPath").title = loaded.configPath;
	$("saveBtn").addEventListener("click", save);
	$("themeBtn").addEventListener("click", toggleTheme);
	$("addGame").addEventListener("click", addGame);
	$("mobileGame").addEventListener("change", (event) => {
		if (event.target.value === "add") {
			addGame();
		} else {
			selectGame(Number(event.target.value));
		}
	});
	window.addEventListener("keydown", (event) => {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			if (!$("saveBtn").disabled) {
				save();
			}
		}
	});
	document.addEventListener("click", (event) => {
		if (event.target.closest(".js-open-settings")) {
			showView("settings");
			setTimeout(() => $("setLookup")?.focus(), 50);
		}
	});
	window.addEventListener("beforeunload", (event) => {
		if (UD.dirty) {
			event.preventDefault();
		}
	});
	onChange(refreshChrome);
	await refreshSchedule();
	renderAll();
	initRunbar();
	setInterval(() => {
		renderSidebar();
		renderHeader();
	}, STATUS_TICK_MS);
}

init().catch((error) => {
	$("view").innerHTML = errorBox(`UpdateDay couldn't load: ${error.message}`);
});
