const LIVE_TICK_MS = 1000;
const COUNTDOWN_SPAN_MS = 24 * 36e5;
const POSITIONS = [["center", "Centre"], ["full", "Full icon"], ["top-right", "Top right"], ["top-left", "Top left"], ["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"]];

const ART_DIR = "updateday-art";
const STYLE_CHOICES = [["original", "Hand-drawn"], ["classic", "Classic"], ["pixel", "Pixel"], ["rounded", "Rounded"], ["glow", "Glow"], ["blocky", "Blocky"], ["outline", "Outline"], ["own", "My own"]];
const STYLE_SLIDERS = [
	["dim", "Dark layer", 0, 0.9, 0.05, 0.45],
	["hourglassSize", "Hourglass size", 0.2, 1, 0.02, 0.66],
	["hourglassY", "Hourglass height", 0.1, 0.9, 0.01, 0.4],
	["textSize", "Text size", 0.05, 0.3, 0.01, 0.15],
	["textY", "Text height", 0.1, 0.95, 0.01, 0.85],
];
const CLASSIC_SLIDERS = [
	["dim", "Dark layer", 0, 0.9, 0.05, 0.45],
	["scale", "Hourglass size", 0.3, 1, 0.02, 0.88],
];

let previewMark = null;
let moderation = {};
let moderationTimer = null;

const DEFAULT_TITLE = { format: "[{time}] {name}", nowFormat: "[LIVE] {name}", afterFormat: "{name}" };
const MAX_TITLE_LENGTH = 50;
const MODERATION_POLL_MS = 15000;
const MODERATION_LABELS = { Approved: ["Approved", "badge-success"], Reviewing: ["In review", "badge-warning"], Rejected: ["Rejected", "badge-danger"], unknown: ["Checking", ""] };

let liveTimer = null;
let artMarks = null;
let artRevision = 0;

function stageMarks() {
	return [...(countdown()?.marks ?? ALL_MARKS), "now"];
}

function skipList() {
	return countdown()?.skip ?? [];
}

function activeStages() {
	const skip = skipList();
	return stageMarks().filter((mark) => !skip.includes(mark));
}

function stepDone(game, id) {
	return game?.steps?.find((step) => step.id === id)?.done ?? null;
}

function currentMark(game) {
	const updateAt = new Date(game.updateAt).getTime();
	const started = activeStages().filter((mark) => updateAt - offsetMs(mark) <= Date.now());
	return started.length ? started[started.length - 1] : null;
}

function liveHtml() {
	const game = scheduledGame();
	if (!game) {
		return emptyState("Waiting for the game link", "Add the game's Roblox link to preview its countdown.", `<button class="btn btn-primary btn-sm js-open-settings">Add game link</button>`);
	}
	const updateAt = new Date(game.updateAt).getTime();
	const left = updateAt - Date.now();
	const mark = currentMark(game);
	const finalStep = game.steps.find((step) => step.id === "icon:final");
	const finished = finalStep?.at && Date.now() >= Date.parse(finalStep.at);
	const shown = finished || !mark ? "final" : mark;
	const first = activeStages()[0];
	const startsIn = updateAt - offsetMs(first ?? "24h") - Date.now();
	const label = finished ? "Back to normal" : mark ? (left > 0 ? "Update in" : "Update is live") : "Countdown starts in";
	const timer = finished || (mark && left <= 0) ? "00:00:00" : clock(mark ? left : startsIn);
	const progress = Math.min(100, Math.max(0, 100 - (Math.max(0, left) / COUNTDOWN_SPAN_MS) * 100));
	return `
		<div class="live">
			<img src="${iconUrl(shown)}" alt="The game icon players see right now">
			<div>
				<div class="eyebrow">How players see it now</div>
				<div class="hint" id="liveLabel">${label}</div>
				<div class="timer" id="liveTimer" aria-live="off">${timer}</div>
				<div class="hint">${h(formatWhen(updateAt))}</div>
				<div class="progress" aria-hidden="true"><div id="liveBar" style="width:${progress}%"></div></div>
			</div>
		</div>`;
}

function reminderHtml() {
	const game = scheduledGame();
	const latest = (game?.reminders ?? []).slice(-1)[0];
	if (!latest) {
		return "";
	}
	const file = `/api/file?path=${encodeURIComponent(latest.file)}`;
	return `
		<div class="reminder" role="status">
			<img src="${file}&r=${UD.revision}" alt="">
			<div><b>Upload this icon in Creator Hub now</b><div class="hint">${h(latest.text.replace(/^REMINDER [^:]+: /, ""))}</div></div>
			<a class="btn btn-sm" href="${file}" download>Download</a>
		</div>`;
}

function stageState(game, mark) {
	const done = stepDone(game, `icon:${mark}`);
	if (currentMark(game) === mark) {
		return `<span class="badge badge-accent state">Live</span>`;
	}
	if (done && !done.startsWith("skipped")) {
		return `<span class="badge badge-success state">Done</span>`;
	}
	if (done) {
		return `<span class="badge state">Skipped</span>`;
	}
	return "";
}

function stagesHtml() {
	const game = scheduledGame();
	if (!game) {
		return emptyState("No stages yet", "Stages appear once the game has a link.");
	}
	const updateAt = new Date(game.updateAt).getTime();
	const skip = skipList();
	const tiles = stageMarks().map((mark) => {
		const on = !skip.includes(mark);
		return `
			<button class="stage" data-mark="${mark}" aria-pressed="${on}" aria-label="${stageName(mark)} stage, ${on ? "on" : "off"}">
				<img loading="lazy" src="${iconUrl(mark)}" alt="">
				<span class="tick" aria-hidden="true">✓</span>
				${on ? stageState(game, mark) : ""}
				${on ? moderationBadge(mark) : ""}
				<span class="stage-name">${stageName(mark)}</span>
				<span class="stage-when">${h(formatWhen(updateAt - offsetMs(mark)))}</span>
			</button>`;
	});
	const finalStep = game.steps.find((step) => step.id === "icon:final");
	const hasNew = Boolean(currentGame()?.countdown?.newIcon);
	tiles.push(`
		<div class="stage fixed">
			<img loading="lazy" src="${iconUrl("final")}" alt="">
			${finalStep?.done ? `<span class="badge badge-success state">Done</span>` : ""}
			<span class="stage-name">${hasNew ? "New icon" : "Back to normal"}</span>
			<span class="stage-when">${finalStep?.at ? h(formatWhen(finalStep.at)) : ""}</span>
		</div>`);
	return `<div class="stages">${tiles.join("")}</div>`;
}

function timelineHtml() {
	const game = scheduledGame();
	if (!game) {
		return emptyState("Nothing scheduled yet", "");
	}
	const rows = game.steps.map((step) => {
		const at = step.at ? new Date(step.at) : null;
		let status = "";
		if (step.done) {
			status = step.done.startsWith("skipped") ? `<span class="badge">Skipped</span>` : `<span class="badge badge-success">Done</span>`;
		} else if (!at || at.getTime() <= Date.now()) {
			status = `<span class="badge badge-warning">Due</span>`;
		}
		return `<div class="list-row"><span class="when">${at ? h(formatWhen(at)) : "Right away"}</span><span>${h(step.label)}</span>${status}</div>`;
	});
	return `<div class="list timeline">${rows.join("")}</div>`;
}

function toggleStage(mark) {
	const cd = countdown();
	const skip = new Set(cd.skip ?? []);
	if (skip.has(mark)) {
		skip.delete(mark);
	} else {
		skip.add(mark);
	}
	cd.skip = stageMarks().filter((item) => skip.has(item));
	if (cd.skip.length === 0) {
		delete cd.skip;
	}
	markDirty();
	const tile = document.querySelector(`.stage[data-mark="${mark}"]`);
	tile.setAttribute("aria-pressed", String(!skip.has(mark)));
}

function iconSettingsHtml() {
	const cd = countdown();
	const game = currentGame();
	const newIcon = game?.countdown?.newIcon;
	const method = cd?.iconMethod ?? "reminder";
	return `
		<div class="card">
			${switchHtml("cdOn", Boolean(cd), "Countdown icons", "Swap the game icon through the countdown.")}
			<div id="cdFields" ${cd ? "" : "hidden"}>
				${cd ? lookHtml(cd) : ""}
				<div class="card-section" id="cdArtSection" ${cd?.overlayDir ? "" : "hidden"}>
					<div class="section-title">Your hourglass art</div>
					<div id="cdArt">
						<div class="hint" style="margin-bottom:10px">Upload art for any stage. Stages without their own art use your default art with the time drawn on it, or the built-in hourglass.</div>
						<div class="art-grid" id="cdArtGrid">${artGridHtml()}</div>
						<input type="file" id="cdArtFile" accept="image/png,image/webp,image/svg+xml,image/*" hidden>
						${switchHtml("cdLabel", cd?.label !== false, "Draw the time on art that has none", "Used for your default art and the built-in hourglass.")}
					</div>
				</div>
				<div class="card-section">
					<div class="section-title">New icon for this update</div>
					<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
						${newIcon ? `<img src="/api/file?path=${encodeURIComponent(newIcon)}&r=${UD.revision}" alt="New icon" style="width:56px;height:56px;border-radius:12px">` : ""}
						<input type="file" id="cdNewFile" accept="image/*" hidden>
						<button class="btn btn-sm" id="cdNewPick">${newIcon ? "Replace" : "Upload image"}</button>
						${newIcon ? `<button class="btn btn-sm btn-danger-ghost" id="cdNewClear">Remove</button>` : ""}
					</div>
					<div class="hint" style="margin-bottom:8px">Optional. Shown at the end, or under the NOW hourglass:</div>
					${segmentedHtml("newIconAt", [["end", "After the admin hour"], ["now", "With NOW"]], cd?.newIconAt ?? "end")}
				</div>
				<div class="card-section">
					<div class="section-title">How the icon changes on Roblox</div>
					<div class="choice-list">
						<label class="choice"><input type="radio" name="cdMethod" value="reminder" ${method === "reminder" ? "checked" : ""}><span><b>Remind me</b><span class="hint">UpdateDay makes each icon; you upload it in Creator Hub when asked.</span></span></label>
						<label class="choice"><input type="radio" name="cdMethod" value="languageSwap" ${method === "languageSwap" ? "checked" : ""}><span><b>Automatic</b><span class="hint">Uses a language swap, because Roblox doesn't let API keys change the main icon.</span></span></label>
					</div>
					<div class="revealed" id="cdSwap" ${method === "languageSwap" ? "" : "hidden"}>
						<details class="hint" style="margin-bottom:10px"><summary>How the language swap works</summary>
							<p style="margin-top:8px">UpdateDay briefly makes another language the game's source language, sets the countdown as every other language's icon, then switches back. Players whose Roblox language is the temporary one see your normal icon. A new icon still has to be uploaded in Creator Hub at the end.</p>
						</details>
						<div class="row">
							<label class="field"><span>Temporary language</span><input type="text" id="cdSwapLang" placeholder="Auto (least used)" value="${h(cd?.swapLanguage ?? "")}"></label>
							<label class="field"><span>Upload early (seconds)</span><input type="number" id="cdLead" min="0" max="900" value="${cd?.uploadLeadSeconds ?? 90}"></label>
						</div>
						${switchHtml("cdLocalize", cd?.localizeLabels !== false, "Translate the labels", "\"24 STUNDEN\", \"24時間\" and so on for each language.")}
					</div>
				</div>
			</div>
		</div>`;
}

function artSlots() {
	return ["default", ...stageMarks()];
}

function artGridHtml() {
	if (artMarks === null) {
		return `<div class="skeleton" style="height:84px;grid-column:1 / -1"></div>`;
	}
	return artSlots().map((mark) => {
		const has = artMarks.includes(mark);
		const name = mark === "default" ? "Default" : stageName(mark);
		const preview = has
			? `<img src="/api/file?path=${encodeURIComponent(`${ART_DIR}/${mark}.png`)}&r=${artRevision}" alt="">`
			: `<span class="art-empty" aria-hidden="true">+</span>`;
		return `
			<div class="art-slot ${has ? "has-art" : ""}">
				<button type="button" class="art-pick" data-art="${mark}" aria-label="${has ? "Replace" : "Upload"} art for ${h(name)}">${preview}</button>
				<span class="art-name">${h(name)}</span>
				${has ? `<button type="button" class="link-btn art-remove" data-art-remove="${mark}">Remove</button>` : `<span class="art-note">${mark === "default" ? "Optional" : "Built-in"}</span>`}
			</div>`;
	}).join("");
}

async function loadArt() {
	try {
		artMarks = (await api("GET", "/api/art")).marks;
	} catch {
		artMarks = [];
	}
	const grid = $("cdArtGrid");
	if (grid) {
		grid.innerHTML = artGridHtml();
	}
}

function artChanged(root) {
	artRevision++;
	UD.revision++;
	$("cdArtGrid").innerHTML = artGridHtml();
	const stages = $("cdStages");
	if (stages) {
		stages.innerHTML = stagesHtml();
		bindStages(root);
	}
	const live = $("cdLive");
	if (live) {
		live.innerHTML = liveHtml();
	}
}

function styleChoice(cd) {
	if (cd.overlayDir) {
		return "own";
	}
	return cd.style ?? "original";
}

function sliderHtml([key, label, min, max, step, fallback], cd) {
	const value = cd[key] ?? fallback;
	return `<div class="range-row"><label for="look-${key}">${label}</label><input type="range" id="look-${key}" data-look="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><output for="look-${key}" id="look-${key}-out">${Math.round(value * 100)}%</output></div>`;
}

function stageTextHtml(cd) {
	const own = cd.labels ?? {};
	const count = Object.keys(own).length;
	return `
		<details class="stage-text" ${count ? "open" : ""}>
			<summary>Text on each stage${count ? ` <span class="badge badge-accent">${count} changed</span>` : ""}</summary>
			<div class="hint" style="margin:8px 0 10px">Leave a box empty to use the standard text. Translated labels still win in other languages.</div>
			<div class="stage-text-grid">${stageMarks().map((mark) => `
				<label class="stage-text-row"><span>${stageName(mark)}</span><input type="text" maxlength="16" data-stage-text="${mark}" placeholder="${h(standardText(mark))}" value="${h(own[mark] ?? "")}"></label>`).join("")}
			</div>
		</details>`;
}

function standardText(mark) {
	if (mark === "now") {
		return "NOW!";
	}
	const match = /^(\d+)([mh])$/.exec(mark);
	const count = match ? Number(match[1]) : 0;
	return match ? `${count} ${match[2] === "h" ? "HOUR" : "MIN"}${count === 1 ? "" : "S"}` : mark.toUpperCase();
}

function lookHtml(cd) {
	const choice = styleChoice(cd);
	const styled = !["original", "own"].includes(choice);
	const marks = stageMarks();
	previewMark = marks.includes(previewMark) ? previewMark : marks[Math.min(2, marks.length - 1)];
	return `
		<div class="card-section">
			<div class="section-title">Look</div>
			<div class="look-preview">
				<img id="cdPreview" src="${iconUrl(previewMark)}" alt="Preview of the ${h(stageName(previewMark))} icon">
				<div class="chips" id="cdPreviewChips">${marks.map((mark) => `<button type="button" class="chip ${mark === previewMark ? "active" : ""}" data-preview="${mark}" aria-pressed="${mark === previewMark}">${mark === "now" ? "NOW" : mark.toUpperCase()}</button>`).join("")}</div>
			</div>
			<div class="field"><span>Hourglass style</span>
				<div class="style-grid" role="radiogroup" aria-label="Hourglass style">${STYLE_CHOICES.map(([value, label]) => `
					<button type="button" class="style-tile ${value === choice ? "active" : ""}" role="radio" aria-checked="${value === choice}" data-style="${value}">
						${value === "own" ? `<span class="style-own" aria-hidden="true">+</span>` : `<img src="/api/style-art?name=${value}" alt="">`}
						<span>${label}</span>
					</button>`).join("")}
				</div>
			</div>
			${(styled ? STYLE_SLIDERS : CLASSIC_SLIDERS).map((slider) => sliderHtml(slider, cd)).join("")}
			${styled ? "" : `<label class="field"><span>Position</span>
				<select id="cdAnchor">${POSITIONS.map(([value, label]) => `<option value="${value}" ${value === (cd.anchor ?? "center") ? "selected" : ""}>${label}</option>`).join("")}</select>
			</label>`}
			${styled ? switchHtml("cdStyleLabel", cd.label !== false, "Show the time text", "Turn off for an hourglass on its own.") : ""}
			${styled ? `<button type="button" class="link-btn" id="cdLookReset">Reset size and position</button>` : ""}
			${stageTextHtml(cd)}
		</div>`;
}

function refreshPreview() {
	const preview = $("cdPreview");
	if (preview && previewMark) {
		preview.src = iconUrl(previewMark);
	}
}

function bindLook(root, cd) {
	for (const tile of root.querySelectorAll("[data-style]")) {
		tile.addEventListener("click", () => {
			const value = tile.dataset.style;
			if (value === "own") {
				cd.overlayDir = ART_DIR;
				delete cd.style;
			} else {
				delete cd.overlayDir;
				if (value === "original") {
					delete cd.style;
				} else {
					cd.style = value;
				}
			}
			markDirty();
			renderCountdown(root);
		});
	}
	for (const chip of root.querySelectorAll("[data-preview]")) {
		chip.addEventListener("click", () => {
			previewMark = chip.dataset.preview;
			for (const other of root.querySelectorAll("[data-preview]")) {
				other.classList.toggle("active", other === chip);
				other.setAttribute("aria-pressed", String(other === chip));
			}
			refreshPreview();
		});
	}
	for (const input of root.querySelectorAll("[data-look]")) {
		input.addEventListener("input", () => {
			cd[input.dataset.look] = Number(input.value);
			$(`look-${input.dataset.look}-out`).textContent = `${Math.round(cd[input.dataset.look] * 100)}%`;
			markDirty();
		});
	}
	root.querySelector("#cdAnchor")?.addEventListener("change", (event) => {
		cd.anchor = event.target.value;
		markDirty();
	});
	root.querySelector("#cdStyleLabel")?.addEventListener("change", (event) => {
		cd.label = event.target.checked;
		markDirty();
	});
	root.querySelector("#cdLookReset")?.addEventListener("click", () => {
		for (const [key] of STYLE_SLIDERS) {
			if (key !== "dim") {
				delete cd[key];
			}
		}
		markDirty();
		renderCountdown(root);
	});
	for (const input of root.querySelectorAll("[data-stage-text]")) {
		input.addEventListener("change", () => {
			const text = input.value.trim();
			cd.labels = { ...(cd.labels ?? {}) };
			if (text) {
				cd.labels[input.dataset.stageText] = text;
			} else {
				delete cd.labels[input.dataset.stageText];
			}
			if (Object.keys(cd.labels).length === 0) {
				delete cd.labels;
			}
			markDirty();
		});
	}
}

function bindArt(root, cd) {
	root.querySelector("#cdLabel").addEventListener("change", (event) => {
		cd.label = event.target.checked;
		markDirty();
	});
	const file = root.querySelector("#cdArtFile");
	let pendingMark = null;
	root.querySelector("#cdArtGrid").addEventListener("click", async (event) => {
		const pick = event.target.closest("[data-art]");
		const remove = event.target.closest("[data-art-remove]");
		if (pick) {
			pendingMark = pick.dataset.art;
			file.value = "";
			file.click();
		}
		if (remove) {
			try {
				await api("DELETE", `/api/art?mark=${encodeURIComponent(remove.dataset.artRemove)}`);
				artMarks = artMarks.filter((mark) => mark !== remove.dataset.artRemove);
				artChanged(root);
			} catch (error) {
				toast(error.message, "danger");
			}
		}
	});
	file.addEventListener("change", async () => {
		if (!file.files[0] || !pendingMark) {
			return;
		}
		try {
			await api("POST", `/api/art?mark=${encodeURIComponent(pendingMark)}`, await file.files[0].arrayBuffer(), true);
			artMarks = [...new Set([...(artMarks ?? []), pendingMark])];
			artChanged(root);
			toast(`Art added for ${pendingMark === "default" ? "the default" : stageName(pendingMark)}`, "success");
		} catch (error) {
			toast(error.message, "danger");
		}
	});
	if (cd.overlayDir && artMarks === null) {
		loadArt();
	}
}

async function downloadIcons() {
	const sure = await dialog({
		title: "Download the countdown icons",
		html: true,
		confirmText: "Download .zip",
		body: `<p>Every stage as a 512×512 PNG, numbered in order, ready to upload.</p>
			<label class="switch-row" for="zipLanguages" style="margin-top:12px">
				<span class="switch-text"><span class="switch-label">Include translated versions</span><span class="hint">A folder per language with "24 STUNDEN", "24時間" and so on.</span></span>
				<input type="checkbox" role="switch" class="switch" id="zipLanguages">
			</label>`,
	});
	if (sure) {
		downloadUrl(`/api/icons.zip?${gameQuery()}&languages=${$("zipLanguages").checked ? 1 : 0}`);
		toast("Building the icons. The download starts in a moment.", "success");
	}
}

function bindIconSettings(root) {
	const cdOn = root.querySelector("#cdOn");
	cdOn.addEventListener("change", () => {
		UD.draft.countdown = cdOn.checked ? {} : false;
		markDirty();
		renderCountdown(root);
	});
	if (!countdown()) {
		return;
	}
	const cd = countdown();
	bindLook(root, cd);
	bindSegmented(root, "newIconAt", (value) => {
		cd.newIconAt = value;
		markDirty();
	});
	for (const radio of root.querySelectorAll("input[name=cdMethod]")) {
		radio.addEventListener("change", () => {
			cd.iconMethod = radio.value;
			root.querySelector("#cdSwap").hidden = radio.value !== "languageSwap";
			markDirty();
		});
	}
	root.querySelector("#cdSwapLang").addEventListener("change", (event) => {
		const value = event.target.value.trim();
		if (value) {
			cd.swapLanguage = value;
		} else {
			delete cd.swapLanguage;
		}
		markDirty();
	});
	root.querySelector("#cdLead").addEventListener("change", (event) => {
		cd.uploadLeadSeconds = Number(event.target.value);
		markDirty();
	});
	root.querySelector("#cdLocalize").addEventListener("change", (event) => {
		cd.localizeLabels = event.target.checked;
		markDirty();
	});
	bindArt(root, cd);
	const game = currentGame();
	const file = root.querySelector("#cdNewFile");
	root.querySelector("#cdNewPick").addEventListener("click", () => file.click());
	file.addEventListener("change", async () => {
		if (!file.files[0]) {
			return;
		}
		try {
			const result = await api("POST", `/api/upload?universeId=${game.universeId || ""}`, await file.files[0].arrayBuffer(), true);
			game.countdown = { ...(game.countdown ?? {}), newIcon: result.path };
			markDirty();
			toast("New icon added", "success");
			renderCountdown(root);
		} catch (error) {
			toast(error.message, "danger");
		}
	});
	root.querySelector("#cdNewClear")?.addEventListener("click", () => {
		delete game.countdown.newIcon;
		if (Object.keys(game.countdown).length === 0) {
			delete game.countdown;
		}
		markDirty();
		renderCountdown(root);
	});
}

function moderationBadge(mark) {
	const label = MODERATION_LABELS[moderation[mark]];
	return label ? `<span class="badge ${label[1]} stage-mod">${label[0]}</span>` : "";
}

function moderationSummary() {
	const states = Object.values(moderation);
	if (!states.length || states.every((state) => state === "unchecked")) {
		return "";
	}
	const count = (state) => states.filter((item) => item === state).length;
	const parts = [[count("Approved"), "approved"], [count("Reviewing"), "in review"], [count("Rejected"), "rejected"], [count("unchecked"), "changed since the check"]].filter(([n]) => n > 0);
	return `Moderation: ${parts.map(([n, word]) => `${n} ${word}`).join(", ")}.`;
}

function renderModeration() {
	const stages = $("cdStages");
	if (stages) {
		stages.innerHTML = stagesHtml();
		bindStages($("view"));
	}
	const summary = $("cdModSummary");
	if (summary) {
		summary.textContent = moderationSummary();
	}
}

async function loadModeration() {
	clearTimeout(moderationTimer);
	if (!currentGame()?.universeId || !countdown()) {
		return;
	}
	try {
		const { stages } = await api("GET", `/api/moderation?${gameQuery()}`);
		moderation = Object.fromEntries(stages.map((stage) => [stage.mark, stage.state]));
	} catch {
		moderation = {};
	}
	renderModeration();
	if (Object.values(moderation).some((state) => state === "Reviewing" || state === "unknown") && UD.view === "countdown") {
		moderationTimer = setTimeout(loadModeration, MODERATION_POLL_MS);
	}
}

async function checkModeration() {
	const sure = await dialog({
		title: "Check the icons with Roblox moderation?",
		body: "UpdateDay uploads each countdown icon to your Roblox inventory as a private image so Roblox reviews it now, days before the update, instead of at the moment it goes up. Only icons that changed since the last check are sent again.",
		confirmText: "Check now",
	});
	if (!sure) {
		return;
	}
	const button = $("cdModCheck");
	button.disabled = true;
	button.textContent = "Uploading…";
	try {
		const { sent, stages } = await api("POST", `/api/moderation?${gameQuery()}`);
		moderation = Object.fromEntries(stages.map((stage) => [stage.mark, stage.state]));
		renderModeration();
		toast(sent ? `Sent ${sent} icon${sent === 1 ? "" : "s"} for review. Results usually take a minute.` : "Nothing changed since the last check", "success");
		moderationTimer = setTimeout(loadModeration, MODERATION_POLL_MS);
	} catch (error) {
		toast(error.message, "danger");
	} finally {
		button.disabled = false;
		button.textContent = "Check with moderation";
	}
}

function titlePreview(format, name, time) {
	const shell = format.replace(/\{time\}/g, time);
	if (!shell.includes("{name}")) {
		return shell.trim().slice(0, MAX_TITLE_LENGTH);
	}
	const room = Math.max(0, MAX_TITLE_LENGTH - (shell.length - "{name}".length));
	return shell.replace("{name}", name.length > room ? name.slice(0, room).trimEnd() : name).trim();
}

function titleRowsHtml(title) {
	const name = currentGame()?.name || "Your Game";
	const marks = stageMarks().filter((mark) => mark !== "now" && !skipList().includes(mark));
	const rows = [
		...marks.map((mark) => [mark.toUpperCase(), titlePreview(title.format, name, mark.toUpperCase())]),
		...(skipList().includes("now") ? [] : [["NOW", titlePreview(title.nowFormat, name, "LIVE")]]),
		["After", titlePreview(title.afterFormat, name, "")],
	];
	return rows.map(([stage, text]) => `<div class="title-row"><span class="badge">${stage}</span><span>${h(text)}</span></div>`).join("");
}

function titleCardHtml() {
	const title = UD.draft.title;
	const values = { ...DEFAULT_TITLE, ...(title || {}) };
	return `
		<div class="card">
			${switchHtml("tiOn", Boolean(title), "Title countdown", "Puts the time left in the game's title, e.g. [6H] Your Game, then [LIVE], then back.")}
			<div class="revealed" id="tiFields" ${title ? "" : "hidden"}>
				<label class="field"><span>Title during the countdown</span><input type="text" id="tiFormat" maxlength="60" value="${h(values.format)}"><span class="hint">{time} becomes 6H, 45M and so on; {name} is the game's current title.</span></label>
				<label class="field"><span>At update time</span><input type="text" id="tiNow" maxlength="60" value="${h(values.nowFormat)}"></label>
				<label class="field"><span>After the admin-abuse hour</span><input type="text" id="tiAfter" maxlength="60" value="${h(values.afterFormat)}"><span class="hint">{name} puts the original title back. Or name the update, e.g. {name} [UPDATE 5].</span></label>
				<div class="section-title" style="margin-top:6px">Preview</div>
				<div class="title-rows" id="tiPreview">${titleRowsHtml(values)}</div>
				<div class="hint" style="margin-top:10px">The real title is saved first. Undo all puts it back. Titles are capped at 50 characters.</div>
			</div>
		</div>`;
}

function bindTitle(root) {
	root.querySelector("#tiOn").addEventListener("change", (event) => {
		if (event.target.checked) {
			UD.draft.title = {};
		} else {
			delete UD.draft.title;
		}
		root.querySelector("#tiFields").hidden = !event.target.checked;
		markDirty();
	});
	const fields = [["#tiFormat", "format"], ["#tiNow", "nowFormat"], ["#tiAfter", "afterFormat"]];
	for (const [selector, key] of fields) {
		root.querySelector(selector).addEventListener("input", (event) => {
			const title = UD.draft.title || (UD.draft.title = {});
			const value = event.target.value;
			if (value.trim() && value !== DEFAULT_TITLE[key]) {
				title[key] = value;
			} else {
				delete title[key];
			}
			$("tiPreview").innerHTML = titleRowsHtml({ ...DEFAULT_TITLE, ...title });
			markDirty();
		});
	}
}

function bindStages(root) {
	for (const tile of root.querySelectorAll(".stage[data-mark]")) {
		tile.addEventListener("click", () => toggleStage(tile.dataset.mark));
	}
}

function tickLive() {
	const box = $("cdLive");
	if (!box || UD.view !== "countdown") {
		clearInterval(liveTimer);
		liveTimer = null;
		return;
	}
	const game = scheduledGame();
	if (!game) {
		return;
	}
	const fresh = document.createElement("div");
	fresh.innerHTML = liveHtml();
	const nextImg = fresh.querySelector("img");
	const img = box.querySelector("img");
	if (!img || !nextImg || img.getAttribute("src") !== nextImg.getAttribute("src")) {
		box.innerHTML = fresh.innerHTML;
		return;
	}
	$("liveLabel").textContent = fresh.querySelector("#liveLabel").textContent;
	$("liveTimer").textContent = fresh.querySelector("#liveTimer").textContent;
	$("liveBar").style.width = fresh.querySelector("#liveBar").style.width;
}

function renderCountdown(root) {
	const cd = countdown();
	root.innerHTML = `
		<div class="grid-2">
			<div class="stack">
				<div class="card">
					<div id="cdReminder">${reminderHtml()}</div>
					<div id="cdLive">${cd ? liveHtml() : emptyState("Countdown icons are off", "Turn them on to swap the game icon through the countdown.")}</div>
				</div>
				${cd ? `
				<div class="card">
					<div class="card-head"><div><h2>Stages</h2><div class="hint">Click a stage to switch it off or on. Every stage is on by default.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" id="cdModCheck" ${currentGame()?.universeId ? "" : "disabled"}>Check with moderation</button><button class="btn btn-sm" id="cdZip" ${currentGame()?.universeId ? "" : "disabled"}>Download icons</button></div></div>
					<div class="hint" id="cdModSummary" style="margin:-6px 0 12px">${moderationSummary()}</div>
					<div id="cdStages">${stagesHtml()}</div>
				</div>` : ""}
				<div class="card">
					<div class="card-head"><div><h2>Full schedule</h2><div class="hint">Everything that will happen for this game, in order.</div></div></div>
					<div id="cdTimeline">${timelineHtml()}</div>
				</div>
			</div>
			<div class="stack">${iconSettingsHtml()}${titleCardHtml()}</div>
		</div>`;
	bindIconSettings(root);
	bindStages(root);
	root.querySelector("#cdZip")?.addEventListener("click", downloadIcons);
	root.querySelector("#cdModCheck")?.addEventListener("click", checkModeration);
	bindTitle(root);
	loadModeration();
	clearInterval(liveTimer);
	liveTimer = cd ? setInterval(tickLive, LIVE_TICK_MS) : null;
}

UD.views.countdown = {
	label: "Countdown",
	render: renderCountdown,
	refresh() {
		const root = $("view");
		if (!countdown()) {
			return;
		}
		const stages = $("cdStages");
		if (stages) {
			stages.innerHTML = stagesHtml();
			bindStages(root);
		}
		const timeline = $("cdTimeline");
		if (timeline) {
			timeline.innerHTML = timelineHtml();
		}
		const reminder = $("cdReminder");
		if (reminder) {
			reminder.innerHTML = reminderHtml();
		}
		const live = $("cdLive");
		if (live) {
			live.innerHTML = liveHtml();
		}
		refreshPreview();
		const titles = $("tiPreview");
		if (titles && !document.activeElement?.closest("#tiFields")) {
			titles.innerHTML = titleRowsHtml({ ...DEFAULT_TITLE, ...(UD.draft.title || {}) });
		}
	},
};
