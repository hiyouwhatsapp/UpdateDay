const HISTORY_REFRESH_MS = 10000;
const HISTORY_KINDS = {
	step: ["Step", "badge-accent"],
	sale: ["Price", "badge-success"],
	reminder: ["Reminder", "badge-warning"],
	error: ["Problem", "badge-danger"],
	skip: ["Skipped", ""],
	info: ["Note", ""],
};
const HISTORY_FILTERS = [["all", "All"], ["step", "Steps"], ["sale", "Prices"], ["reminder", "Reminders"], ["error", "Problems"]];

let historyEntries = null;
let historyScope = "game";
let historyFilter = "all";
let historyQuery = "";
let historyTimer = null;

function historyText(entry) {
	return entry.text
		.replace(/^RUN\s+/, "")
		.replace(/^REMINDER [^:]+: /, "")
		.replace(/ in Creator Hub now: .*$/, " in Creator Hub")
		.replace(/^FAILED /, "");
}

function visibleEntries() {
	const query = historyQuery.trim().toLowerCase();
	return (historyEntries ?? []).filter((entry) => {
		const kindMatch = historyFilter === "all" || entry.kind === historyFilter;
		const textMatch = !query || `${entry.text} ${entry.game}`.toLowerCase().includes(query);
		return kindMatch && textMatch;
	});
}

function dayLabel(date) {
	const day = new Date(date);
	const today = new Date();
	const yesterday = new Date(Date.now() - 864e5);
	if (day.toDateString() === today.toDateString()) {
		return "Today";
	}
	if (day.toDateString() === yesterday.toDateString()) {
		return "Yesterday";
	}
	return day.toLocaleDateString(LOCALE, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function historyListHtml() {
	if (historyEntries === null) {
		return `<div class="skeleton" style="height:48px;margin-bottom:8px"></div>`.repeat(4);
	}
	if (historyEntries.length === 0) {
		return emptyState("Nothing has run yet", "Everything UpdateDay does is recorded here: each step, every price it changes and puts back, reminders and problems.");
	}
	const entries = visibleEntries();
	if (entries.length === 0) {
		return emptyState("No matches", "Try another filter or search.");
	}
	const groups = new Map();
	for (const entry of entries) {
		const label = dayLabel(entry.at);
		groups.set(label, [...(groups.get(label) ?? []), entry]);
	}
	const showGame = historyScope === "all";
	return [...groups].map(([label, items]) => `
		<div class="section-title" style="margin-top:14px">${h(label)}</div>
		<div class="list">${items.map((entry) => {
			const [kindLabel, tone] = HISTORY_KINDS[entry.kind] ?? HISTORY_KINDS.info;
			return `
				<div class="list-row history-row">
					<span class="hint mono">${h(formatTime(entry.at))}</span>
					<span style="min-width:0">${h(historyText(entry))}${showGame ? `<div class="hint">${h(entry.game)}</div>` : ""}</span>
					<span class="badge ${tone}">${kindLabel}</span>
				</div>`;
		}).join("")}</div>`).join("");
}

function csvCell(value) {
	return `"${String(value).replace(/"/g, '""')}"`;
}

function downloadHistory() {
	const rows = [["Time", "Game", "Type", "What happened"], ...visibleEntries().map((entry) => [entry.at, entry.game, HISTORY_KINDS[entry.kind]?.[0] ?? entry.kind, entry.text])];
	const blob = new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
	const url = URL.createObjectURL(blob);
	downloadUrl(url);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadHistory() {
	try {
		const query = historyScope === "game" ? `${gameQuery()}&` : "";
		historyEntries = (await api("GET", `/api/history?${query}limit=1000`)).entries;
	} catch (error) {
		historyEntries = [];
		toast(error.message, "danger");
	}
	const list = $("hiList");
	if (list) {
		list.innerHTML = historyListHtml();
	}
}

function renderHistory(root) {
	root.innerHTML = `
		<div class="card">
			<div class="items-head">
				<div><h2>History</h2><div class="hint">Everything UpdateDay did, newest first. Kept in updateday-history.jsonl next to your plan.</div></div>
				<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
					${UD.draft.games.length > 1 ? segmentedHtml("hiScope", [["game", "This game"], ["all", "All games"]], historyScope) : ""}
					<button class="btn btn-sm" id="hiCsv">Download CSV</button>
				</div>
			</div>
			<div class="je-bar" style="margin-bottom:6px">
				<div class="chips">${HISTORY_FILTERS.map(([value, label]) => `<button type="button" class="chip ${value === historyFilter ? "active" : ""}" aria-pressed="${value === historyFilter}" data-filter="${value}">${label}</button>`).join("")}</div>
				<span class="je-spacer"></span>
				<input type="search" id="hiSearch" class="je-search" placeholder="Search history" aria-label="Search history" value="${h(historyQuery)}">
			</div>
			<div id="hiList">${historyListHtml()}</div>
		</div>`;
	bindSegmented(root, "hiScope", (scope) => {
		historyScope = scope;
		historyEntries = null;
		$("hiList").innerHTML = historyListHtml();
		loadHistory();
	});
	for (const chip of root.querySelectorAll("[data-filter]")) {
		chip.addEventListener("click", () => {
			historyFilter = chip.dataset.filter;
			for (const other of root.querySelectorAll("[data-filter]")) {
				other.classList.toggle("active", other === chip);
				other.setAttribute("aria-pressed", String(other === chip));
			}
			$("hiList").innerHTML = historyListHtml();
		});
	}
	root.querySelector("#hiSearch").addEventListener("input", (event) => {
		historyQuery = event.target.value;
		$("hiList").innerHTML = historyListHtml();
	});
	root.querySelector("#hiCsv").addEventListener("click", downloadHistory);
	loadHistory();
	clearInterval(historyTimer);
	historyTimer = setInterval(() => {
		if (UD.view !== "history") {
			clearInterval(historyTimer);
			return;
		}
		loadHistory();
	}, HISTORY_REFRESH_MS);
}

UD.views.history = {
	label: "History",
	render: renderHistory,
};
