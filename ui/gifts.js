const MAX_GIFT_AMOUNT = 50;

let giftCategory = null;
let pendingGifts = null;

function giftCatalog() {
	return currentGame().gifts?.catalog ?? UD.draft.gifts?.catalog ?? {};
}

function setGiftCatalog(catalog) {
	const game = currentGame();
	game.gifts = { ...(game.gifts ?? {}), catalog };
	markDirty();
}

function splitList(text) {
	return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function catalogHtml() {
	const rows = Object.entries(giftCatalog()).map(([name, category]) => `
		<div class="cat-row" data-name="${h(name)}">
			<b>${h(name)}</b>
			<input type="text" data-k="items" value="${h((category.items ?? []).join(", "))}" placeholder="Items, comma separated" aria-label="${h(name)} items">
			<input type="text" data-k="tiers" value="${h((category.tiers ?? []).join(", "))}" placeholder="Tiers (optional)" aria-label="${h(name)} tiers">
			<button class="icon-btn" data-act="remove" aria-label="Remove ${h(name)}" title="Remove">✕</button>
		</div>`).join("");
	return `
		<div class="card">
			<div class="card-head"><div><h2>What this game can give</h2><div class="hint">Category names must match the handlers in UpdateDayGifts.luau.</div></div></div>
			${rows || `<div class="hint" style="margin-bottom:10px">No categories yet. Add one, e.g. Pet, Currency or Boost.</div>`}
			<form class="row" id="catForm" style="align-items:flex-end;margin-top:6px">
				<label class="field" style="flex:1"><span>New category</span><input type="text" id="catNew" placeholder="e.g. Pet"></label>
				<div class="field" style="flex:none"><button class="btn" type="submit">Add</button></div>
			</form>
		</div>`;
}

function bindCatalog(root) {
	for (const row of root.querySelectorAll(".cat-row")) {
		const name = row.dataset.name;
		for (const input of row.querySelectorAll("input")) {
			input.addEventListener("change", () => {
				const catalog = giftCatalog();
				catalog[name] = { ...(catalog[name] ?? {}), [input.dataset.k]: splitList(input.value) };
				setGiftCatalog(catalog);
				renderGiftForm();
			});
		}
		row.querySelector("[data-act=remove]").addEventListener("click", async () => {
			const sure = await dialog({ title: `Remove ${name}?`, body: "It comes off this game's gift list. Gifts already sent are not affected.", confirmText: "Remove", danger: true });
			if (!sure) {
				return;
			}
			const catalog = giftCatalog();
			delete catalog[name];
			setGiftCatalog(catalog);
			renderGifts(root);
		});
	}
	root.querySelector("#catForm").addEventListener("submit", (event) => {
		event.preventDefault();
		const name = $("catNew").value.trim();
		if (!name) {
			return;
		}
		setGiftCatalog({ ...giftCatalog(), [name]: { items: [], tiers: [] } });
		giftCategory = name;
		renderGifts(root);
	});
}

function renderGiftForm() {
	const slot = $("giftForm");
	if (!slot) {
		return;
	}
	const catalog = giftCatalog();
	const names = Object.keys(catalog);
	if (!currentPlayer) {
		slot.innerHTML = "";
		return;
	}
	if (names.length === 0) {
		slot.innerHTML = `<div class="callout callout-info">Add what this game can give first.</div>`;
		return;
	}
	giftCategory = names.includes(giftCategory) ? giftCategory : names[0];
	const category = catalog[giftCategory];
	const tiers = category.tiers ?? [];
	const items = category.items ?? [];
	slot.innerHTML = `
		<div class="section-title">Send a gift</div>
		<div class="chips" style="margin-bottom:12px" role="radiogroup" aria-label="Gift category">${names.map((name) => `<button type="button" class="chip ${name === giftCategory ? "active" : ""}" role="radio" aria-checked="${name === giftCategory}" data-cat="${h(name)}">${h(name)}</button>`).join("")}</div>
		<div class="row">
			<label class="field"><span>What</span>
				${items.length ? `<select id="giftItem">${items.map((item) => `<option>${h(item)}</option>`).join("")}</select>` : `<input type="text" id="giftItem" placeholder="Item name">`}
			</label>
			${tiers.length ? `<label class="field"><span>Tier</span><select id="giftTier">${tiers.map((tier) => `<option>${h(tier)}</option>`).join("")}</select></label>` : ""}
			<label class="field" style="max-width:130px"><span>How many</span><input type="number" id="giftAmount" min="1" max="${MAX_GIFT_AMOUNT}" value="1"></label>
		</div>
		<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
			<span class="hint">Arrives right away if @${h(currentPlayer.name)} is in a server, otherwise next time they join.</span>
			<button class="btn btn-primary" id="giftSend">Send gift</button>
		</div>`;
	for (const chip of slot.querySelectorAll("[data-cat]")) {
		chip.addEventListener("click", () => {
			giftCategory = chip.dataset.cat;
			renderGiftForm();
		});
	}
	$("giftSend").addEventListener("click", sendGift);
}

function pendingHtml() {
	if (!pendingGifts) {
		return "";
	}
	const rows = pendingGifts.map((gift) => `
		<div class="list-row">
			<span><b>${gift.amount}×</b></span>
			<span>${h(gift.item)}${gift.tier ? ` <span class="badge">${h(gift.tier)}</span>` : ""}<div class="hint">${h(gift.category)} · sent ${h(formatWhen(gift.sentAt))}</div></span>
			<button class="btn btn-sm btn-danger-ghost" data-gift="${h(gift.id)}">Cancel</button>
		</div>`).join("");
	return `
		<div class="section-title">Waiting in their gift box</div>
		${rows ? `<div class="list" style="margin-bottom:16px">${rows}</div>` : `<div class="hint" style="margin-bottom:16px">Nothing waiting. Delivered gifts leave the box.</div>`}`;
}

function showPending(gifts) {
	pendingGifts = gifts ?? [];
	const slot = $("giftPending");
	if (!slot) {
		return;
	}
	slot.innerHTML = pendingHtml();
	for (const button of slot.querySelectorAll("[data-gift]")) {
		button.addEventListener("click", async () => {
			try {
				const result = await api("DELETE", `/api/gifts?${gameQuery()}&userId=${currentPlayer.id}&id=${encodeURIComponent(button.dataset.gift)}`);
				showPending(result.gifts);
				toast("Gift cancelled", "success");
			} catch (error) {
				toast(error.message, "danger");
			}
		});
	}
}

async function sendGift() {
	const amount = Number($("giftAmount").value);
	if (!(amount >= 1 && amount <= MAX_GIFT_AMOUNT)) {
		toast(`Send between 1 and ${MAX_GIFT_AMOUNT} at a time`, "danger");
		return;
	}
	const item = $("giftItem").value.trim();
	if (!item) {
		$("giftItem").focus();
		return;
	}
	const button = $("giftSend");
	button.disabled = true;
	try {
		const result = await api("POST", `/api/gifts?${gameQuery()}&userId=${currentPlayer.id}`, {
			category: giftCategory,
			item,
			tier: $("giftTier")?.value ?? null,
			amount,
		});
		showPending(result.gifts);
		toast(`Sent ${amount}× ${item} to @${currentPlayer.name}`, "success");
	} catch (error) {
		toast(error.message, "danger");
	} finally {
		button.disabled = false;
	}
}

function renderGifts(root) {
	if (!currentGame()?.universeId) {
		root.innerHTML = `<div class="card">${emptyState("Add the game link first", "Gifts go through the game's own gift box.")}</div>`;
		return;
	}
	root.innerHTML = `
		<div class="grid-2">
			<div class="stack">
				<div class="card">
					<div class="card-head"><div><h2>Gift a player</h2><div class="hint">Give something through your game's gift box.</div></div></div>
					${lookupHtml("giftLookup")}
					<div id="giftPlayer">${currentPlayer ? playerHtml(currentPlayer) : emptyState("No player picked", "Search by username or user ID.")}</div>
					<div id="giftPending">${pendingHtml()}</div>
					<div id="giftForm"></div>
				</div>
			</div>
			<div class="stack">
				${catalogHtml()}
				<div class="callout callout-info">Needs <code>roblox/UpdateDayGifts.luau</code> in your game. Gifts are claimed safely, so a player never gets one twice.</div>
			</div>
		</div>`;
	bindCatalog(root);
	bindLookup("giftLookup", (result) => {
		$("giftPlayer").innerHTML = playerHtml(result.player);
		showPending(result.gifts);
		renderGiftForm();
	});
	if (pendingGifts) {
		showPending(pendingGifts);
	}
	renderGiftForm();
}

UD.views.gifts = {
	label: "Gifts",
	render: renderGifts,
};
