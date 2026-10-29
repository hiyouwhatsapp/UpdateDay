const CHECK_SYMBOLS = { ok: "✓", warn: "!", info: "i" };

function statHtml(label, value) {
	return `<div class="stat"><span>${label}</span><b>${h(value ?? "—")}</b></div>`;
}

function pageStatsHtml(stats) {
	if (!stats) {
		return `<div class="callout callout-info">Public stats appear once the game is public.</div>`;
	}
	return `<div class="stats">${[
		statHtml("Playing", stats.playing?.toLocaleString(LOCALE)),
		statHtml("Visits", stats.visits?.toLocaleString(LOCALE)),
		statHtml("Favourites", stats.favorites?.toLocaleString(LOCALE)),
		statHtml("Liked", stats.liked != null ? `${stats.liked}%` : null),
		statHtml("Server size", stats.serverSize),
		statHtml("Genre", stats.genre),
		statHtml("Updated", stats.updated ? new Date(stats.updated).toLocaleDateString(LOCALE) : null),
	].join("")}</div>`;
}

function pagePreviewHtml(page) {
	const meta = [
		page.creator ? `By ${h(page.creator)}` : "",
		page.visibility ? (page.visibility === "PRIVATE" ? "Private" : "Public") : "",
		page.ageRating ? h(page.ageRating.replace("AGE_RATING_", "").replace("_PLUS", "+")) : "",
	].filter(Boolean).join(" · ");
	const thumbs = page.thumbnails.length
		? page.thumbnails.map((url) => `<img src="${h(url)}" alt="" loading="lazy">`).join("")
		: `<div class="thumb-empty">No thumbnails</div>`;
	return `
		<div class="card">
			<div class="page-hero">
				${page.iconUrl ? `<img src="${h(page.iconUrl)}" alt="">` : `<img alt="">`}
				<div style="min-width:0"><div class="title">${h(page.name)}</div><div class="hint">${meta}</div></div>
			</div>
			<div class="thumbs">${thumbs}</div>
			${pageStatsHtml(page.stats)}
			<div class="section-title">Description</div>
			<div class="page-desc">${page.description ? h(page.description) : `<span class="hint">No description</span>`}</div>
			${page.devices.length ? `<div class="hint" style="margin-top:12px">Plays on ${h(page.devices.join(", "))}</div>` : ""}
		</div>`;
}

function pageChecksHtml(page) {
	const warnings = page.checks.filter((check) => check.level === "warn").length;
	const rows = page.checks.map((check) => `
		<li class="check ${check.level}">
			<span class="dot" aria-hidden="true">${CHECK_SYMBOLS[check.level]}</span>
			<div><b>${h(check.title)}</b>${check.detail ? `<div class="hint">${h(check.detail)}</div>` : ""}</div>
		</li>`).join("");
	return `
		<div class="card">
			<div class="card-head">
				<div><h2>${warnings ? `${warnings} thing${warnings === 1 ? "" : "s"} to look at` : "Ready for the update"}</h2><div class="hint">Checked against your plan for this game.</div></div>
				<button class="btn btn-sm" id="pgAgain">Check again</button>
			</div>
			${page.keyUsed ? "" : `<div class="callout callout-info" style="margin-bottom:10px">Add the API key to check private games and events.</div>`}
			<ul class="checks">${rows}</ul>
		</div>`;
}

function pageSkeletonHtml() {
	return `
		<div class="grid-2">
			<div class="card"><div class="skeleton" style="height:84px;margin-bottom:16px"></div><div class="skeleton" style="height:128px;margin-bottom:16px"></div><div class="skeleton" style="height:80px"></div></div>
			<div class="card"><div class="skeleton" style="height:22px;margin-bottom:16px;width:60%"></div><div class="skeleton" style="height:180px"></div></div>
		</div>`;
}

async function renderPage(root) {
	if (!currentGame()?.universeId) {
		root.innerHTML = `<div class="card">${emptyState("Add the game link first", "The page check reads your game's public page from Roblox.")}</div>`;
		return;
	}
	const selected = UD.selected;
	root.innerHTML = pageSkeletonHtml();
	try {
		const page = await api("GET", `/api/page?${gameQuery()}`);
		if (UD.view !== "page" || UD.selected !== selected) {
			return;
		}
		root.innerHTML = `<div class="grid-2"><div class="stack">${pagePreviewHtml(page)}</div><div class="stack">${pageChecksHtml(page)}</div></div>`;
		root.querySelector("#pgAgain").addEventListener("click", () => renderPage(root));
	} catch (error) {
		root.innerHTML = `<div class="card">${errorBox(error)}<button class="btn btn-sm" id="pgAgain" style="margin-top:12px">Try again</button></div>`;
		root.querySelector("#pgAgain").addEventListener("click", () => renderPage(root));
	}
}

UD.views.page = {
	label: "Game page",
	render: renderPage,
};
