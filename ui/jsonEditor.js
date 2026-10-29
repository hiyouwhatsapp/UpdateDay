const JE_MODE_KEY = "updateday-json-mode";
const JE_LONG_TEXT = 70;
const JE_PREVIEW_KEYS = ["name", "displayName", "title", "type", "id"];
const JE_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const JE_NEW_TYPES = [["string", "Text"], ["number", "Number"], ["boolean", "True / false"], ["object", "Group { }"], ["array", "List [ ]"], ["null", "Empty (null)"]];
const JE_BLANKS = { string: "", number: 0, boolean: false, null: null };

function jeClone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function jeKind(value) {
	if (value === null) {
		return "null";
	}
	return Array.isArray(value) ? "array" : typeof value;
}

function jeBlank(type) {
	if (type === "object") {
		return {};
	}
	if (type === "array") {
		return [];
	}
	return JE_BLANKS[type];
}

function jeGet(root, path) {
	return path.reduce((node, key) => (node == null ? undefined : node[key]), root);
}

function jeSet(root, path, value) {
	jeGet(root, path.slice(0, -1))[path[path.length - 1]] = value;
}

function jeRemove(root, path) {
	const parent = jeGet(root, path.slice(0, -1));
	const key = path[path.length - 1];
	if (Array.isArray(parent)) {
		parent.splice(key, 1);
	} else {
		delete parent[key];
	}
}

function jeSame(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

function jePathText(path) {
	return path.join(".").toLowerCase();
}

function jeLabel(key) {
	return typeof key === "number" ? `[${key}]` : key;
}

function jePreview(value) {
	if (jeKind(value) !== "object") {
		return "";
	}
	const named = JE_PREVIEW_KEYS.find((key) => ["string", "number"].includes(typeof value[key]));
	if (named) {
		return String(value[named]);
	}
	const text = Object.values(value).find((item) => typeof item === "string");
	return text ?? "";
}

function jeCount(kind, size) {
	const noun = kind === "array" ? "item" : "field";
	return `${size} ${noun}${size === 1 ? "" : "s"}`;
}

function jeHighlight(text) {
	let out = "";
	let last = 0;
	text.replace(JE_TOKEN, (match, string, colon, word, offset) => {
		out += h(text.slice(last, offset));
		if (string && colon) {
			out += `<span class="je-k">${h(string)}</span>${colon}`;
		} else if (string) {
			out += `<span class="je-s">${h(string)}</span>`;
		} else if (word) {
			out += `<span class="${word === "null" ? "je-null" : "je-b"}">${word}</span>`;
		} else {
			out += `<span class="je-n">${match}</span>`;
		}
		last = offset + match.length;
		return match;
	});
	return out + h(text.slice(last)) + "\n";
}

function jeControlHtml(value, label) {
	const kind = jeKind(value);
	const aria = `aria-label="${h(label)}"`;
	if (kind === "boolean") {
		return `<input type="checkbox" role="switch" class="switch je-input" data-type="boolean" ${value ? "checked" : ""} ${aria}>`;
	}
	if (kind === "number") {
		return `<input type="number" step="any" class="je-input" data-type="number" value="${value}" ${aria}>`;
	}
	if (kind === "string" && (value.length > JE_LONG_TEXT || value.includes("\n"))) {
		return `<textarea class="je-input" data-type="string" rows="3" ${aria}>${h(value)}</textarea>`;
	}
	if (kind === "string") {
		return `<input type="text" class="je-input" data-type="string" value="${h(value)}" ${aria}>`;
	}
	return `<span class="je-empty">empty (null)</span>`;
}

function jeRemoveHtml(path, label) {
	return `<button type="button" class="icon-btn je-remove" data-path="${h(JSON.stringify(path))}" aria-label="Remove ${h(label)}" title="Remove">✕</button>`;
}

function jeNodeHtml(state, key, value, path, depth) {
	const kind = jeKind(value);
	const label = jeLabel(key);
	const pathAttr = h(JSON.stringify(path));
	const pathText = h(jePathText(path));
	if (kind !== "object" && kind !== "array") {
		const search = h(`${jePathText(path)} ${String(value)}`.toLowerCase());
		return `
			<div class="je-row je-leaf" data-path="${pathAttr}" data-pt="${pathText}" data-search="${search}">
				<span class="je-key" title="${h(path.join("."))}">${h(label)}</span>
				<span class="je-control">${jeControlHtml(value, path.join("."))}</span>
				${jeRemoveHtml(path, path.join("."))}
			</div>`;
	}
	const entries = kind === "array" ? value.map((item, index) => [index, item]) : Object.entries(value);
	const open = state.open ? state.open.has(JSON.stringify(path)) : depth < 1;
	const preview = jePreview(value);
	return `
		<details class="je-node" data-path="${pathAttr}" data-pt="${pathText}" data-search="${pathText}" ${open ? "open" : ""}>
			<summary class="je-row">
				<span class="je-key" title="${h(path.join("."))}">${h(label)}</span>
				<span class="je-meta"><span class="je-count">${jeCount(kind, entries.length)}</span>${preview ? `<span class="je-preview">${h(preview)}</span>` : ""}</span>
				${jeRemoveHtml(path, path.join("."))}
			</summary>
			<div class="je-children">
				${entries.map(([childKey, child]) => jeNodeHtml(state, childKey, child, [...path, childKey], depth + 1)).join("")}
				<button type="button" class="link-btn je-add" data-path="${pathAttr}">+ Add ${kind === "array" ? "item" : "field"}</button>
			</div>
		</details>`;
}

function jeFieldsHtml(state) {
	const kind = jeKind(state.value);
	if (kind === "null") {
		return emptyState("No saved data", "Start a save for this player from scratch.", `<button type="button" class="btn btn-sm je-start">Start with an empty group</button>`);
	}
	if (kind !== "object" && kind !== "array") {
		return `<div class="callout callout-info">This save is a single ${kind}. Edit it in the JSON view.</div>`;
	}
	const entries = kind === "array" ? state.value.map((item, index) => [index, item]) : Object.entries(state.value);
	return `
		<div class="je-tree">
			${entries.map(([key, child]) => jeNodeHtml(state, key, child, [key], 0)).join("")}
			<button type="button" class="link-btn je-add" data-path="[]">+ Add ${kind === "array" ? "item" : "field"}</button>
		</div>`;
}

function jeBarHtml(state) {
	const fields = state.mode === "fields";
	return `
		<div class="je-bar">
			${segmentedHtml("jeMode", [["fields", "Fields"], ["json", "JSON"]], state.mode)}
			${fields ? `<input type="search" class="je-search" placeholder="Find a field or value" aria-label="Find a field or value" value="${h(state.filter)}">` : `<span class="je-status" aria-live="polite"></span>`}
			<span class="je-spacer"></span>
			${fields ? `<button type="button" class="btn btn-ghost btn-sm" data-je="expand">Expand all</button><button type="button" class="btn btn-ghost btn-sm" data-je="collapse">Collapse all</button>` : `<button type="button" class="btn btn-ghost btn-sm" data-je="format">Format</button>`}
			<button type="button" class="btn btn-ghost btn-sm" data-je="copy">Copy</button>
		</div>`;
}

function jeCodeHtml() {
	return `
		<div class="je-code">
			<pre aria-hidden="true"></pre>
			<textarea class="je-text" spellcheck="false" autocomplete="off" aria-label="Saved data as JSON"></textarea>
		</div>`;
}

function jeMarkChanges(state) {
	for (const element of state.root.querySelectorAll(".je-body [data-path]:not(.je-add):not(.je-remove)")) {
		const path = JSON.parse(element.dataset.path);
		const differs = !jeSame(jeGet(state.original, path), jeGet(state.value, path));
		if (element.matches("details")) {
			element.querySelector(":scope > summary").classList.toggle("has-changes", differs);
		} else {
			element.classList.toggle("changed", differs);
		}
	}
}

function jeApplyFilter(state) {
	const query = state.filter.trim().toLowerCase();
	const items = [...state.root.querySelectorAll(".je-body [data-search]")];
	state.root.querySelector(".je-body").classList.toggle("filtering", Boolean(query));
	if (!query) {
		for (const item of items) {
			item.hidden = false;
		}
		return;
	}
	const matched = items.filter((item) => item.dataset.search.includes(query)).map((item) => item.dataset.pt);
	for (const item of items) {
		const own = item.dataset.pt;
		const visible = matched.some((hit) => hit === own || hit.startsWith(`${own}.`) || own.startsWith(`${hit}.`));
		item.hidden = !visible;
		if (visible && item.matches("details")) {
			item.open = true;
		}
	}
}

function jeRememberOpen(state) {
	state.open = new Set([...state.root.querySelectorAll(".je-body details[open]")].map((item) => item.dataset.path));
}

function jeValidate(state) {
	const status = state.root.querySelector(".je-status");
	try {
		state.value = JSON.parse(state.root.querySelector(".je-text").value);
		status.textContent = "Valid JSON";
		status.dataset.ok = "true";
		return true;
	} catch (error) {
		status.textContent = error.message.replace(/^JSON\.parse: /, "");
		status.dataset.ok = "false";
		return false;
	}
}

function jeRender(state) {
	if (state.mode === "fields" && state.root.querySelector(".je-tree")) {
		jeRememberOpen(state);
	}
	state.root.innerHTML = `<div class="je">${jeBarHtml(state)}<div class="je-body je-${state.mode}">${state.mode === "fields" ? jeFieldsHtml(state) : jeCodeHtml()}</div></div>`;
	bindSegmented(state.root, "jeMode", (mode) => jeSwitchMode(state, mode));
	if (state.mode === "json") {
		const text = state.root.querySelector(".je-text");
		const pre = state.root.querySelector(".je-code pre");
		text.value = JSON.stringify(state.value, null, 2);
		pre.innerHTML = jeHighlight(text.value);
		jeValidate(state);
		text.addEventListener("input", () => {
			pre.innerHTML = jeHighlight(text.value);
			if (jeValidate(state)) {
				state.onChange();
			}
		});
		text.addEventListener("scroll", () => {
			pre.scrollTop = text.scrollTop;
			pre.scrollLeft = text.scrollLeft;
		});
		return;
	}
	jeMarkChanges(state);
	jeApplyFilter(state);
	state.root.querySelector(".je-search")?.addEventListener("input", (event) => {
		state.filter = event.target.value;
		jeApplyFilter(state);
	});
}

function jeSwitchMode(state, mode) {
	if (mode === state.mode) {
		return;
	}
	if (mode === "fields" && !jeValidate(state)) {
		toast("Fix the JSON before switching to Fields", "danger");
		jeRender(state);
		return;
	}
	if (state.mode === "fields") {
		jeRememberOpen(state);
	}
	state.mode = mode;
	try {
		localStorage.setItem(JE_MODE_KEY, mode);
	} catch {
	}
	jeRender(state);
}

async function jeAddTo(state, path) {
	const target = jeGet(state.value, path);
	const isList = Array.isArray(target);
	const types = isList && target.length ? [["copy", "Copy of the last item"], ...JE_NEW_TYPES] : JE_NEW_TYPES;
	const sure = await dialog({
		title: isList ? "Add an item" : "Add a field",
		html: true,
		confirmText: "Add",
		body: `
			${isList ? "" : `<label class="field"><span>Name</span><input type="text" id="jeNewKey" class="mono" autocomplete="off"></label>`}
			<label class="field"><span>Type</span><select id="jeNewType">${types.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>`,
	});
	if (!sure) {
		return;
	}
	const type = $("jeNewType").value;
	const value = type === "copy" ? jeClone(target[target.length - 1]) : jeBlank(type);
	if (isList) {
		target.push(value);
		jeRememberOpen(state);
		state.open.add(JSON.stringify(path));
	} else {
		const key = $("jeNewKey").value.trim();
		if (!key) {
			toast("Give the field a name", "danger");
			return;
		}
		if (Object.hasOwn(target, key)) {
			toast(`There's already a field called ${key}`, "danger");
			return;
		}
		target[key] = value;
		jeRememberOpen(state);
		state.open.add(JSON.stringify(path));
	}
	jeRender(state);
	state.onChange();
}

function jeOnInput(state, input) {
	const row = input.closest("[data-path]");
	const path = JSON.parse(row.dataset.path);
	if (input.dataset.type === "boolean") {
		jeSet(state.value, path, input.checked);
	} else if (input.dataset.type === "number") {
		const number = Number(input.value);
		if (input.value === "" || Number.isNaN(number)) {
			return;
		}
		jeSet(state.value, path, number);
	} else {
		jeSet(state.value, path, input.value);
	}
	row.dataset.search = `${jePathText(path)} ${String(jeGet(state.value, path))}`.toLowerCase();
	jeMarkChanges(state);
	state.onChange();
}

async function jeOnClick(state, event) {
	const button = event.target.closest("button");
	if (!button || !state.root.contains(button)) {
		return;
	}
	if (button.matches(".je-remove")) {
		event.preventDefault();
		jeRememberOpen(state);
		jeRemove(state.value, JSON.parse(button.dataset.path));
		jeRender(state);
		state.onChange();
	} else if (button.matches(".je-add")) {
		jeAddTo(state, JSON.parse(button.dataset.path));
	} else if (button.matches(".je-start")) {
		state.value = {};
		jeRender(state);
		state.onChange();
	} else if (button.dataset.je === "expand" || button.dataset.je === "collapse") {
		for (const item of state.root.querySelectorAll(".je-body details")) {
			item.open = button.dataset.je === "expand";
		}
	} else if (button.dataset.je === "format") {
		if (jeValidate(state)) {
			jeRender(state);
		} else {
			toast("Fix the JSON first", "danger");
		}
	} else if (button.dataset.je === "copy") {
		try {
			await navigator.clipboard.writeText(JSON.stringify(state.mode === "json" ? JSON.parse(state.root.querySelector(".je-text").value) : state.value, null, 2));
			toast("Copied", "success");
		} catch {
			toast("Couldn't copy", "danger");
		}
	}
}

function jeSavedMode() {
	try {
		return localStorage.getItem(JE_MODE_KEY) === "json" ? "json" : "fields";
	} catch {
		return "fields";
	}
}

function createJsonEditor(root, value, onChange) {
	const state = { root, original: jeClone(value), value: jeClone(value) ?? null, mode: jeSavedMode(), open: null, filter: "", onChange };
	const primitive = !["object", "array", "null"].includes(jeKind(state.value));
	if (primitive) {
		state.mode = "json";
	}
	root.addEventListener("input", (event) => {
		if (event.target.matches(".je-input") && event.target.dataset.type !== "boolean") {
			jeOnInput(state, event.target);
		}
	});
	root.addEventListener("change", (event) => {
		if (event.target.matches(".je-input[data-type=boolean]")) {
			jeOnInput(state, event.target);
		}
	});
	root.addEventListener("click", (event) => jeOnClick(state, event));
	jeRender(state);
	return {
		getValue() {
			if (state.mode === "json" && !jeValidate(state)) {
				throw new Error(`That isn't valid JSON: ${state.root.querySelector(".je-status").textContent}`);
			}
			return jeClone(state.value);
		},
	};
}
