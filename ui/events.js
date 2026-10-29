const EVENT_CATEGORIES = [
	["newContent", "New content"], ["newFeature", "New feature"], ["newSeason", "New season"],
	["newMap", "New map"], ["newLocation", "New location"], ["itemDrop", "Item drop"], ["festival", "Festival"],
	["challenge", "Challenge"], ["quest", "Quest"], ["earlyAccess", "Early access"], ["expansion", "Expansion"],
	["moreLevels", "More levels"],
];
const DEFAULT_AUTO_EVENT = { title: "New update!", subtitle: "Come play the update", durationHours: 2, visibility: "Public" };
const EVENT_LEAD_MINUTES = 15;

let editingEvent = undefined;
let eventsCache = null;

function categoryLabel(category) {
	return EVENT_CATEGORIES.find(([value]) => value === category)?.[1] ?? category;
}

function eventTimeRange(event) {
	const time = (date) => new Date(date).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
	return `${time(event.startTime)} – ${time(event.endTime)}`;
}

function eventRowHtml(event) {
	const start = new Date(event.startTime);
	const past = Date.parse(event.endTime) < Date.now();
	const live = !past && start.getTime() <= Date.now();
	const categories = (event.categories ?? []).map((item) => `<span class="badge">${h(categoryLabel(item.category))}</span>`).join(" ");
	const state = live ? `<span class="badge badge-success">Live</span>` : past ? `<span class="badge">Ended</span>` : "";
	return `
		<div class="event-row" data-id="${h(event.id)}">
			<div class="date-badge" aria-hidden="true"><span>${start.toLocaleDateString(LOCALE, { month: "short" })}</span><b>${start.getDate()}</b></div>
			<div style="min-width:0">
				<b>${h(event.title)}</b> ${state}
				${event.subtitle ? `<div class="hint">${h(event.subtitle)}</div>` : ""}
				<div class="hint">${h(start.toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" }))}, ${eventTimeRange(event)} · ${event.visibility === "private" ? "Private" : "Everyone"} ${categories}</div>
			</div>
			<div style="display:flex;gap:6px">
				<button class="btn btn-sm" data-act="edit" aria-label="Edit ${h(event.title)}">Edit</button>
				<button class="btn btn-sm btn-danger-ghost" data-act="delete" aria-label="Delete ${h(event.title)}">Delete</button>
			</div>
		</div>`;
}

function eventFormHtml(event) {
	const auto = UD.draft.event || DEFAULT_AUTO_EVENT;
	const updateAt = gameUpdateAt(currentGame()).toISOString();
	const values = event ?? {
		title: auto.title ?? "",
		subtitle: auto.subtitle ?? "",
		description: "",
		startTime: updateAt,
		endTime: new Date(Date.parse(updateAt) + (auto.durationHours ?? 2) * 36e5).toISOString(),
		visibility: "public",
		categories: [{ category: "newContent", rank: 0 }],
	};
	const category = values.categories?.[0]?.category ?? "newContent";
	return `
		<div class="card" id="evForm">
			<div class="card-head"><div><h2>${event ? "Edit event" : "New event"}</h2><div class="hint">Events have to start at least ${EVENT_LEAD_MINUTES} minutes from now.</div></div></div>
			<label class="field"><span>Title</span><input type="text" id="evTitle" maxlength="50" value="${h(values.title)}" required></label>
			<label class="field"><span>Subtitle</span><input type="text" id="evSubtitle" maxlength="100" value="${h(values.subtitle)}"></label>
			<label class="field"><span>Description</span><textarea id="evDescription" rows="3">${h(values.description ?? "")}</textarea></label>
			<div class="row">
				<label class="field"><span>Starts</span><input type="datetime-local" id="evStart" value="${toLocalInput(values.startTime)}"></label>
				<label class="field"><span>Ends</span><input type="datetime-local" id="evEnd" value="${toLocalInput(values.endTime)}"></label>
			</div>
			<div class="row">
				<label class="field"><span>Category</span><select id="evCategory">${EVENT_CATEGORIES.map(([value, label]) => `<option value="${value}" ${value === category ? "selected" : ""}>${label}</option>`).join("")}</select></label>
				<label class="field"><span>Who can see it</span>
					<select id="evVisibility">
						<option value="public" ${values.visibility !== "private" ? "selected" : ""}>Everyone</option>
						<option value="private" ${values.visibility === "private" ? "selected" : ""}>Only me (private)</option>
					</select>
				</label>
			</div>
			<label class="field"><span>Thumbnail</span><input type="file" id="evImage" accept="image/*"><span class="hint">Optional. 16:9 works best.</span></label>
			<div id="evError"></div>
			<div style="display:flex;gap:8px;justify-content:flex-end">
				<button class="btn" id="evCancel">Cancel</button>
				<button class="btn btn-primary" id="evSave">${event ? "Save changes" : "Create event"}</button>
			</div>
		</div>`;
}

function autoEventHtml() {
	const auto = UD.draft.event;
	return `
		<div class="card">
			${switchHtml("evAuto", Boolean(auto), "Create an event automatically", "Every game gets an event that starts at its update.")}
			<div class="revealed" id="evAutoFields" ${auto ? "" : "hidden"}>
				<label class="field"><span>Title</span><input type="text" id="evAutoTitle" maxlength="50" value="${h(auto?.title ?? "")}"></label>
				<label class="field"><span>Subtitle</span><input type="text" id="evAutoSubtitle" maxlength="100" value="${h(auto?.subtitle ?? "")}"></label>
				<label class="field"><span>Length (hours)</span><input type="number" id="evAutoHours" min="1" max="2160" value="${auto?.durationHours ?? 2}"></label>
			</div>
		</div>`;
}

function bindAutoEvent(root) {
	const fields = root.querySelector("#evAutoFields");
	const auto = () => UD.draft.event || (UD.draft.event = { ...DEFAULT_AUTO_EVENT });
	root.querySelector("#evAuto").addEventListener("change", (event) => {
		if (event.target.checked) {
			const values = auto();
			root.querySelector("#evAutoTitle").value = values.title;
			root.querySelector("#evAutoSubtitle").value = values.subtitle;
			root.querySelector("#evAutoHours").value = values.durationHours;
		} else {
			delete UD.draft.event;
		}
		fields.hidden = !event.target.checked;
		markDirty();
	});
	root.querySelector("#evAutoTitle").addEventListener("input", (event) => {
		auto().title = event.target.value;
		markDirty();
	});
	root.querySelector("#evAutoSubtitle").addEventListener("input", (event) => {
		auto().subtitle = event.target.value;
		markDirty();
	});
	root.querySelector("#evAutoHours").addEventListener("input", (event) => {
		auto().durationHours = Number(event.target.value);
		markDirty();
	});
}

async function eventThumbnail() {
	const file = $("evImage").files[0];
	if (!file) {
		return null;
	}
	const result = await api("POST", `/api/event-image?${gameQuery()}`, await file.arrayBuffer(), true);
	return [{ mediaId: result.assetId, rank: 0 }];
}

async function saveEventForm() {
	const button = $("evSave");
	const title = $("evTitle").value.trim();
	if (!title) {
		$("evError").innerHTML = errorBox("Give the event a title.");
		$("evTitle").focus();
		return;
	}
	button.disabled = true;
	button.textContent = "Saving…";
	try {
		const body = {
			title,
			subtitle: $("evSubtitle").value.trim(),
			description: $("evDescription").value.trim(),
			startTime: fromLocalInput($("evStart").value),
			endTime: fromLocalInput($("evEnd").value),
			visibility: $("evVisibility").value === "private" ? "Private" : "Public",
			categories: [{ category: $("evCategory").value, rank: 0 }],
		};
		const thumbnails = await eventThumbnail();
		if (thumbnails) {
			body.thumbnails = thumbnails;
		}
		const id = editingEvent?.id;
		await api(id ? "PATCH" : "POST", `/api/events?${gameQuery()}${id ? `&id=${encodeURIComponent(id)}` : ""}`, body);
		toast(id ? "Event updated" : "Event created", "success");
		editingEvent = undefined;
		renderEvents($("view"));
	} catch (error) {
		button.disabled = false;
		button.textContent = "Try again";
		$("evError").innerHTML = errorBox(error);
	}
}

function openEventForm(event) {
	editingEvent = event;
	const slot = $("evFormSlot");
	slot.innerHTML = eventFormHtml(event);
	$("evSave").addEventListener("click", saveEventForm);
	$("evCancel").addEventListener("click", () => {
		editingEvent = undefined;
		slot.innerHTML = "";
	});
	slot.scrollIntoView({ block: "nearest", behavior: "smooth" });
	$("evTitle").focus();
}

function eventListHtml(events) {
	if (!events.length) {
		return emptyState("No events yet", "Events show on your game page and in players' calendars. Make one for every update.");
	}
	const upcoming = events.filter((event) => Date.parse(event.endTime) >= Date.now()).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
	const past = events.filter((event) => Date.parse(event.endTime) < Date.now()).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
	const group = (title, list) => list.length ? `<div class="section-title" style="margin-top:8px">${title}</div>${list.map(eventRowHtml).join("")}` : "";
	return group("Upcoming", upcoming) + group("Past", past);
}

async function loadEvents(root) {
	const list = root.querySelector("#evList");
	try {
		const { events } = await api("GET", `/api/events?${gameQuery()}`);
		eventsCache = events;
		list.innerHTML = eventListHtml(events);
		for (const row of list.querySelectorAll(".event-row")) {
			const event = events.find((item) => item.id === row.dataset.id);
			row.querySelector("[data-act=edit]").addEventListener("click", () => openEventForm(event));
			row.querySelector("[data-act=delete]").addEventListener("click", async () => {
				const sure = await dialog({ title: "Delete this event?", body: `"${event.title}" will be removed from Roblox. This can't be undone.`, confirmText: "Delete event", danger: true });
				if (!sure) {
					return;
				}
				try {
					await api("DELETE", `/api/events?${gameQuery()}&id=${encodeURIComponent(event.id)}`);
					toast("Event deleted", "success");
					loadEvents(root);
				} catch (error) {
					toast(error.message, "danger");
				}
			});
		}
	} catch (error) {
		list.innerHTML = errorBox(error);
	}
}

function renderEvents(root) {
	root.innerHTML = `
		<div class="grid-2">
			<div class="stack">
				<div id="evFormSlot"></div>
				<div class="card">
					<div class="card-head">
						<div><h2>Roblox events</h2><div class="hint">Live from Roblox for this game.</div></div>
						<button class="btn btn-primary btn-sm" id="evNew">+ New event</button>
					</div>
					<div id="evList"><div class="skeleton" style="height:64px;margin-bottom:10px"></div><div class="skeleton" style="height:64px"></div></div>
				</div>
			</div>
			<div class="stack">${autoEventHtml()}</div>
		</div>`;
	root.querySelector("#evNew").addEventListener("click", () => openEventForm(null));
	bindAutoEvent(root);
	if (!currentGame()?.universeId) {
		root.querySelector("#evList").innerHTML = emptyState("Add the game link first", "Events load once UpdateDay knows the game.");
		return;
	}
	loadEvents(root);
}

UD.views.events = {
	label: "Events",
	render: renderEvents,
};
