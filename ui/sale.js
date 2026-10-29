const SALE_CHIPS = [10, 20, 25, 30, 40, 50];
const DEFAULT_SALE = { percentOff: 30, durationHours: 48, gamePasses: "all", developerProducts: "all" };
const DEFAULT_TAG = "[{percent}% OFF]";
const EXAMPLE_ITEM = "2x Power";

let saleItems = { game: null, items: null, error: null };

function sharedSale() {
	UD.draft.sale = UD.draft.sale || { ...DEFAULT_SALE };
	return UD.draft.sale;
}

function salePercent() {
	return UD.draft.sale?.percentOff ?? DEFAULT_SALE.percentOff;
}

function salePrice(price, percent) {
	return Math.max(1, Math.round(price * (1 - percent / 100)));
}

function ownSale(game) {
	if (!game || game.sale === false) {
		return null;
	}
	game.sale = game.sale || {};
	return game.sale;
}

function pickedIds(game, key) {
	const own = game?.sale ? game.sale[key] : undefined;
	return Array.isArray(own) ? own : null;
}

function pickMode(game) {
	return pickedIds(game, "gamePasses") || pickedIds(game, "developerProducts") ? "pick" : "all";
}

function saleWindow() {
	const sale = UD.draft.sale || {};
	const start = sale.startsAt ? new Date(sale.startsAt) : gameUpdateAt(currentGame());
	const end = sale.endsAt ? new Date(sale.endsAt) : new Date(start.getTime() + (sale.durationHours ?? DEFAULT_SALE.durationHours) * 36e5);
	return { start, end };
}

function summaryHtml() {
	const { start, end } = saleWindow();
	const follows = UD.draft.sale?.startsAt ? "" : " Starts with each game's update.";
	return `<b>${salePercent()}% off</b> from ${h(formatWhen(start))} to ${h(formatWhen(end))} (${formatSpan(end - start)}).${follows}`;
}

function tagExample() {
	const sale = UD.draft.sale || {};
	const tag = (sale.nameTag ?? "").replace(/\{percent\}/g, String(salePercent())).trim();
	if (!tag) {
		return "";
	}
	return sale.nameTagPosition === "suffix" ? `${EXAMPLE_ITEM} ${tag}` : `${tag} ${EXAMPLE_ITEM}`;
}

function discountHtml() {
	const percent = salePercent();
	const matched = SALE_CHIPS.includes(percent);
	const chips = SALE_CHIPS.map((pct) => `<button type="button" class="chip ${pct === percent ? "active" : ""}" data-pct="${pct}" aria-pressed="${pct === percent}">${pct}%</button>`);
	return `
		<div class="card-section">
			<div class="section-title">Discount</div>
			<div class="chips">
				${chips.join("")}
				<input type="number" id="saPercent" min="1" max="99" placeholder="Other %" aria-label="Other discount percent" value="${matched ? "" : percent}" style="width:110px">
			</div>
		</div>`;
}

function whenHtml() {
	const sale = UD.draft.sale || {};
	return `
		<div class="card-section">
			<div class="card-head" style="margin-bottom:10px">
				<div class="section-title" style="margin:0">When</div>
				<button class="link-btn" id="saAdmin">Use the admin-abuse hour</button>
			</div>
			<div class="row">
				<label class="field"><span>Starts</span><input type="datetime-local" id="saStarts" value="${sale.startsAt ? toLocalInput(sale.startsAt) : ""}"></label>
				<label class="field"><span>Ends</span><input type="datetime-local" id="saEnds" value="${sale.endsAt ? toLocalInput(sale.endsAt) : ""}"></label>
			</div>
			<div class="hint" style="margin:-4px 0 12px">Leave Starts empty to start at the update, and Ends empty to use a length.</div>
			<label class="field" ${sale.endsAt ? "hidden" : ""}><span>Or end after (hours)</span><input type="number" id="saHours" min="0.05" max="720" step="0.5" value="${sale.durationHours ?? DEFAULT_SALE.durationHours}"></label>
			<div class="callout callout-info" id="saSummary">${summaryHtml()}</div>
		</div>`;
}

function tagHtml() {
	const sale = UD.draft.sale || {};
	return `
		<div class="card-section">
			${switchHtml("saTagOn", Boolean(sale.nameTag), "Tag names during the sale", "Original names are put back when the sale ends.")}
			<div class="revealed" id="saTagFields" ${sale.nameTag ? "" : "hidden"}>
				<div class="row">
					<label class="field"><span>Tag</span><input type="text" id="saTag" placeholder="${DEFAULT_TAG}" value="${h(sale.nameTag ?? DEFAULT_TAG)}"><span class="hint">{percent} becomes the discount.</span></label>
					<label class="field"><span>Where</span>
						<select id="saTagPos">
							<option value="prefix" ${sale.nameTagPosition !== "suffix" ? "selected" : ""}>Before the name</option>
							<option value="suffix" ${sale.nameTagPosition === "suffix" ? "selected" : ""}>After the name</option>
						</select>
					</label>
				</div>
				<div class="hint">Example: <b id="saTagExample">${h(tagExample())}</b></div>
			</div>
		</div>`;
}

function itemRowHtml(item, mode, picked, percent) {
	const sellable = item.isForSale && item.price !== null;
	const checked = mode === "all" ? sellable : (picked[item.kind] || []).includes(item.id);
	const price = sellable ? `<s>R$ ${item.price}</s><b>R$ ${salePrice(item.price, percent)}</b>` : `<span class="hint">Not for sale</span>`;
	const locked = mode === "all" || !sellable ? "disabled" : "";
	return `
		<label class="item-row ${checked ? "" : "off"}">
			<input type="checkbox" data-kind="${item.kind}" data-id="${item.id}" ${checked ? "checked" : ""} ${locked} aria-label="${h(item.name)}">
			${item.iconUrl ? `<img src="${h(item.iconUrl)}" alt="" loading="lazy">` : `<img alt="">`}
			<span style="min-width:0"><span class="kind">${item.kind === "gamePass" ? "Game pass" : "Product"}</span><br>${h(item.name)}</span>
			<span class="price">${price}</span>
		</label>`;
}

function itemsBodyHtml() {
	const game = currentGame();
	if (!game?.universeId) {
		return emptyState("Add the game link first", "Its passes and products load once UpdateDay knows the game.");
	}
	if (saleItems.game !== game.universeId) {
		return `<div class="items">${`<div class="item-row"><span></span><span class="skeleton" style="height:36px"></span><span class="skeleton" style="height:14px"></span><span></span></div>`.repeat(4)}</div>`;
	}
	if (saleItems.error) {
		const retry = /API key/.test(saleItems.error) ? "" : `<button class="btn btn-sm" id="saRetry" style="margin-top:10px">Try again</button>`;
		return `${errorBox(saleItems.error)}${retry}`;
	}
	const mode = pickMode(game);
	const picked = { gamePass: pickedIds(game, "gamePasses"), developerProduct: pickedIds(game, "developerProducts") };
	const rows = saleItems.items.map((item) => itemRowHtml(item, mode, picked, salePercent())).join("");
	return rows ? `<div class="items">${rows}</div>` : emptyState("No passes or products", "This game has nothing to put on sale yet.");
}

function itemsCardHtml() {
	const game = currentGame();
	if (game?.sale === false) {
		return `
			<div class="card">
				<div class="card-head"><div><h2>Items</h2></div></div>
				${emptyState("No sale for this game", "This game is left out of the sale.", `<button class="btn btn-sm" id="saInclude">Include it again</button>`)}
			</div>`;
	}
	const mode = pickMode(game);
	return `
		<div class="card">
			<div class="items-head">
				<div><h2>Items</h2><div class="hint">Prices shown after the discount.</div></div>
				<div style="display:flex;gap:8px;align-items:center">
					${segmentedHtml("saleMode", [["all", "Everything for sale"], ["pick", "Only ticked"]], mode)}
					<button class="icon-btn" id="saReload" aria-label="Reload items" title="Reload items">↻</button>
				</div>
			</div>
			<div id="saItems">${itemsBodyHtml()}</div>
			<div class="hint" style="margin-top:12px">Every price and name is saved before it changes, read back after, and put back when the sale ends.</div>
			<button class="link-btn" id="saExclude" style="margin-top:8px">Leave this game out of the sale</button>
		</div>`;
}

async function loadSaleItems(reload) {
	const game = currentGame();
	if (!game?.universeId) {
		return;
	}
	try {
		const result = await api("GET", `/api/items?${gameQuery()}${reload ? "&refresh=1" : ""}`);
		saleItems = { game: game.universeId, items: result.items, error: null };
	} catch (error) {
		saleItems = { game: game.universeId, items: null, error: error.message };
	}
	const box = $("saItems");
	if (box) {
		box.innerHTML = itemsBodyHtml();
		bindItems();
	}
}

function bindItems() {
	const game = currentGame();
	$("saRetry")?.addEventListener("click", () => {
		saleItems.game = null;
		$("saItems").innerHTML = itemsBodyHtml();
		loadSaleItems(true);
	});
	for (const check of document.querySelectorAll("#saItems input[type=checkbox]")) {
		check.addEventListener("change", () => {
			const own = ownSale(game);
			const key = check.dataset.kind === "gamePass" ? "gamePasses" : "developerProducts";
			const other = key === "gamePasses" ? "developerProducts" : "gamePasses";
			const id = Number(check.dataset.id);
			own[key] = (pickedIds(game, key) || []).filter((existing) => existing !== id);
			if (check.checked) {
				own[key].push(id);
			}
			if (!pickedIds(game, other)) {
				own[other] = [];
			}
			check.closest(".item-row").classList.toggle("off", !check.checked);
			markDirty();
		});
	}
}

function setPickMode(mode) {
	const game = currentGame();
	const own = ownSale(game);
	if (mode === "pick") {
		const items = saleItems.items || [];
		own.gamePasses = items.filter((item) => item.kind === "gamePass" && item.isForSale).map((item) => item.id);
		own.developerProducts = items.filter((item) => item.kind === "developerProduct" && item.isForSale).map((item) => item.id);
	} else {
		delete own.gamePasses;
		delete own.developerProducts;
		if (Object.keys(own).length === 0) {
			delete game.sale;
		}
	}
	markDirty();
	$("saItems").innerHTML = itemsBodyHtml();
	bindItems();
}

function refreshSaleBits() {
	const summary = $("saSummary");
	if (summary) {
		summary.innerHTML = summaryHtml();
	}
	const example = $("saTagExample");
	if (example) {
		example.textContent = tagExample();
	}
}

function setDate(key, value) {
	const sale = sharedSale();
	const iso = value ? fromLocalInput(value) : null;
	if (iso) {
		sale[key] = iso;
	} else {
		delete sale[key];
	}
	markDirty();
}

function bindSale(root) {
	root.querySelector("#saOn").addEventListener("change", (event) => {
		if (event.target.checked) {
			sharedSale();
		} else {
			delete UD.draft.sale;
		}
		markDirty();
		renderSale(root);
	});
	if (!UD.draft.sale) {
		return;
	}
	const sale = sharedSale();
	const setPercent = (value) => {
		if (value > 0 && value < 100) {
			sale.percentOff = value;
			markDirty();
			renderSale(root);
		}
	};
	for (const chip of root.querySelectorAll("[data-pct]")) {
		chip.addEventListener("click", () => setPercent(Number(chip.dataset.pct)));
	}
	root.querySelector("#saPercent").addEventListener("change", (event) => setPercent(Number(event.target.value)));
	root.querySelector("#saStarts").addEventListener("change", (event) => {
		setDate("startsAt", event.target.value);
		refreshSaleBits();
	});
	root.querySelector("#saEnds").addEventListener("change", (event) => {
		setDate("endsAt", event.target.value);
		renderSale(root);
	});
	root.querySelector("#saHours").addEventListener("input", (event) => {
		sale.durationHours = Number(event.target.value);
		markDirty();
		refreshSaleBits();
	});
	root.querySelector("#saAdmin").addEventListener("click", () => {
		delete sale.startsAt;
		delete sale.endsAt;
		sale.durationHours = (UD.draft.adminAbuseMinutes ?? 60) / 60;
		markDirty();
		renderSale(root);
		toast(`Sale set to the ${UD.draft.adminAbuseMinutes ?? 60}-minute admin-abuse window`, "success");
	});
	root.querySelector("#saTagOn").addEventListener("change", (event) => {
		if (event.target.checked) {
			sale.nameTag = sale.nameTag || DEFAULT_TAG;
		} else {
			delete sale.nameTag;
			delete sale.nameTagPosition;
		}
		root.querySelector("#saTagFields").hidden = !event.target.checked;
		markDirty();
		refreshSaleBits();
	});
	root.querySelector("#saTag").addEventListener("input", (event) => {
		sale.nameTag = event.target.value;
		markDirty();
		refreshSaleBits();
	});
	root.querySelector("#saTagPos").addEventListener("change", (event) => {
		sale.nameTagPosition = event.target.value;
		markDirty();
		refreshSaleBits();
	});
	const game = currentGame();
	root.querySelector("#saInclude")?.addEventListener("click", () => {
		delete game.sale;
		markDirty();
		renderSale(root);
	});
	root.querySelector("#saExclude")?.addEventListener("click", () => {
		game.sale = false;
		markDirty();
		renderSale(root);
	});
	bindSegmented(root, "saleMode", setPickMode);
	root.querySelector("#saReload")?.addEventListener("click", () => {
		saleItems.game = null;
		$("saItems").innerHTML = itemsBodyHtml();
		loadSaleItems(true);
	});
	bindItems();
}

function renderSale(root) {
	const on = Boolean(UD.draft.sale);
	root.innerHTML = `
		<div class="grid-2">
			<div class="stack">
				<div class="card">
					${switchHtml("saOn", on, "Sale at update time", "Discount game passes and developer products, then put every price back. Shared by all games.")}
					${on ? discountHtml() + whenHtml() + tagHtml() : ""}
				</div>
			</div>
			<div class="stack">${on ? itemsCardHtml() : `<div class="card">${emptyState("No sale planned", "Turn the sale on to pick a discount and the items in it.")}</div>`}</div>
		</div>`;
	bindSale(root);
	const game = currentGame();
	if (on && game?.universeId && game.sale !== false && saleItems.game !== game.universeId) {
		loadSaleItems(false);
	}
}

UD.views.sale = {
	label: "Sale",
	render: renderSale,
	refresh() {
		refreshSaleBits();
	},
};
