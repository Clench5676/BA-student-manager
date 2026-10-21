// The shipped page on a stand-in DOM, game renderer and the shared import RPC contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeImportLayouts, find, renderImportTree } from "./import_prefabs.mjs";

const walk = (element) => [element, ...element.children.flatMap(walk)];
function matches(element, selector) {
  if (selector === "*") return true;
  if (selector.endsWith(":not(:disabled)")) return !element.disabled && matches(element, selector.replace(":not(:disabled)", ""));
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  if (selector === "[data-action]") return !!element.dataset.action;
  return element.tagName === selector.toUpperCase();
}
class El {
  constructor(tag = "div") {
    Object.assign(this, { tagName: tag.toUpperCase(), children: [], parentNode: null, style: {}, dataset: {}, attrs: {}, listeners: {},
      className: "", _text: "", hidden: false, disabled: false, value: "", checked: false, scrollTop: 0 });
    this.classList = {
      contains: (key) => this.className.split(" ").includes(key),
      add: (...keys) => { this.className = [...new Set([...this.className.split(" "), ...keys])].join(" "); },
      remove: (...keys) => { this.className = this.className.split(" ").filter((key) => !keys.includes(key)).join(" "); },
      toggle: (key, on) => on ? this.classList.add(key) : this.classList.remove(key),
    };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(text) { this._text = String(text); this.replaceChildren(); }
  get childNodes() { return [...this.children]; }
  get isConnected() { return body.contains(this); }
  contains(element) { return walk(this).includes(element); }
  appendChild(element) { element.remove(); this.children.push(element); element.parentNode = this; return element; }
  append(...elements) { elements.forEach((element) => this.appendChild(element)); }
  replaceChildren(...elements) { [...this.children].forEach((child) => child.remove()); this.append(...elements); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
  querySelectorAll(selector) { return walk(this).slice(1).filter((element) => selector.split(/,\s*/).some((part) => matches(element, part))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let element = this; element; element = element.parentNode) if (matches(element, selector)) return element; return null; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = body; }
  async dispatch(type, props = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, ...props };
    for (let element = this; element; element = element.parentNode) {
      for (const fn of element.listeners[type] || []) await fn(event);
      if (event.stopped) break;
    }
    return event;
  }
  click() { return this.disabled ? Promise.resolve() : this.dispatch("click"); }
  getContext() { return { measureText: (text) => ({ width: text.length * 10 }) }; }
}
const body = new El("body");
globalThis.document = { body, activeElement: body, documentElement: new El("html"),
  createElement: (tag) => new El(tag), querySelector: () => null, getElementById: (id) => walk(body).find((element) => element.id === id),
};
Object.defineProperty(globalThis, "navigator", { value: { platform: "Mac" }, configurable: true });
globalThis.addEventListener = () => {};
const observers = [];
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; this.items = new Set(); observers.push(this); }
  observe(element) { this.items.add(element); }
  unobserve(element) { this.items.delete(element); }
  disconnect() { this.items.clear(); }
  reveal() { this.callback([...this.items].filter((item) => item.isConnected).map((target) => ({ target, isIntersecting: true }))); }
};
const { createImportPage, entryIdentity, catalogEntries } = await import("../../src/ba_modding_toolkit/web/js/batch-import.js");
const { importAssistants, suggestImports } = await import("../../src/ba_modding_toolkit/web/js/import-assistants.js");
const { importArtwork, clipButtonPatterns } = await import("../../src/ba_modding_toolkit/web/js/import-layout.js");
const { ROW_W: OPTION_WIDTH, rowBase, radioRow } = await import("../../src/ba_modding_toolkit/web/js/settings-rows.js");
const { searchTree, sortBody, orderBody } = await import("../../src/ba_modding_toolkit/web/js/roster-widgets.js");
const { S } = await import("../../src/ba_modding_toolkit/web/js/util.js");
const { createImportState } = await import("../../src/ba_modding_toolkit/web/js/import-state.js");
const { setStrings } = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
const flatten = (data, prefix = "", result = {}) => {
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "object") flatten(value, `${prefix}${key}.`, result); else result[prefix + key] = value;
  }
  return result;
};
setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };
const options = { strategy: "cont_name_type", types: ["ALL"], skipUnchanged: true, crc: "auto", compression: "lzma",
  extraBytes: "0x08080808", backup: true, workers: 4, output: null, enableAfterImport: true };
const entry = (id, state = "ready", kind = "spr") => ({ id, paths: [`/fixtures/${id}.bundle`], variant: id, core: `${id}_spr`, kind,
  files: [{ path: `/fixtures/${id}.bundle`, size: 1024, target: `${id}_spr.bundle` }], size: 1024, state,
  reason: state === "blocked" ? "no_target" : null, libraryId: state === "library" ? "lib-known" : null,
  preview: ["spr", "lobby"].includes(kind) ? { kind: "import", key: `source-${id}` } : null });
const mixed = () => [entry("a"), entry("b", "update", "lobby"), entry("c", "library"), entry("d", "installed"), entry("e", "blocked", "model")];
const catalog = { families: ["a", "b", "c", "d", "e"].map((id) => ({ key: id, custom: id === "a" ? ["Saved Alias"] : [], variants: [{
  key: id, fileId: `${id}_spr`, spr: `${id}_spr`, lobby: `${id}_home`, portrait: `/portrait/${id}.png`, names: { en: { full: `Student ${id}` }, ja: { full: `JP ${id}` } },
}] })) };

async function fixture({ licensed = false, native = true, suggest } = {}) {
  body.replaceChildren(); observers.length = 0;
  const host = body.appendChild(new El()), dialog = body.appendChild(new El()); dialog.id = "dialog"; dialog.hidden = true;
  const calls = [], analyses = [], runs = [], messages = [], answers = [], thumbs = [], scopes = [], popupStack = [];
  let pickerPaths = [], pickError = null, optionsError = null, saveError = null, changed = 0;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "import.options") { if (optionsError) throw optionsError; return structuredClone(options); }
    if (method === "import.setOptions") { if (saveError) throw saveError; return structuredClone(params); }
    if (method === "import.pick") { if (pickError) throw pickError; return { paths: pickerPaths }; }
    if (["import.analyze", "import.run"].includes(method)) {
      const list = method === "import.analyze" ? analyses : runs, job = { ...deferred(), id: `job-${calls.length}`, params };
      list.push(job); return job.id;
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  const node = (name, pos = [0, 0], widgets = [], children = []) => ({ name, pos, widgets, children, scale: [1, 1] });
  const layouts = makeImportLayouts(), layoutSnapshot = structuredClone(layouts), rendered = [], loaded = [];
  let renderHold = null, imagesHold = null;
  const ui = { node, fitText: (text, fs) => ({ text, fs }), init: async () => {},
    layout: async (name) => { loaded.push(name); assert.ok(layouts[name], `Unexpected layout ${name}`); return layouts[name]; },
    find, render: async (tree, host, opts) => {
      rendered.push({ tree, opts, host }); const view = await renderImportTree(tree, host, opts);
      if (renderHold?.predicate(tree)) { const hold = renderHold; renderHold = null; await hold.promise; }
      if (imagesHold?.predicate(tree)) { view.images = [imagesHold.promise]; imagesHold = null; }
      return view;
    }, decoded: async () => {},
  };
  const popups = { ready: async () => {},
    message: async (message) => { messages.push(message); const answer = answers.shift() || { button: "cancel", checked: false }; return answer.promise || answer; },
    popupFrame: () => node("Popup"), opened: (host, close) => popupStack.push({ host, close }),
    closed: () => popupStack.pop(), closable() {},
    hit: (host, _view, _path, fn, attrs) => {
      const button = new El("button"); button.dataset.action = attrs.action; button.setAttribute("aria-label", attrs.name);
      button.addEventListener("click", fn); host.appendChild(button); return button;
    },
  };
  const page = createImportPage({ host, call, ui, popups, allowed: () => licensed, suggest,
    jobs: (id, progress) => { const job = [...analyses, ...runs].find((job) => job.id === id); job.progress = progress; return job.promise; },
    thumbnails: () => { const scope = { cancel: () => { scope.cancelled = true; }, thumb: (...args) => { thumbs.push(args); return Promise.resolve(`blob:${args[0]}`); } }; scopes.push(scope); return scope; },
  });
  const context = { info: { native }, invalidateRoster: () => changed++ };
  await page.show(context, catalog); await flush();
  const action = (name, parent = host) => walk(parent).find((element) => element.dataset.action === name);
  const row = (id) => walk(host).find((element) => element.dataset.entry === id);
  const phase = () => host.children[0].dataset.phase;
  const analyze = async (entries = mixed(), paths = entries.flatMap((entry) => entry.paths)) => {
    const adding = page.drop(paths); await flush(); analyses.at(-1).resolve({ entries, skipped: 0 }); await adding; await page.settled(); await flush(); return adding;
  };
  return { page, context, host, dialog, layouts, layoutSnapshot, rendered, loaded, calls,
    holdImages: (predicate) => { const hold = { ...deferred(), predicate }; imagesHold = hold; return hold; },
    holdRender: (predicate) => { const hold = { ...deferred(), predicate }; renderHold = hold; return hold; }, analyses, runs, messages, answers, thumbs, scopes, popupStack, action, row, phase, analyze,
    changed: () => changed, picker: (paths) => { pickerPaths = paths; }, pickError: (error) => { pickError = error; },
    optionsError: (error) => { optionsError = error; }, saveError: (error) => { saveError = error; } };
}

test("empty screen has add actions and zero Mods, without AI UI or tooltips", async () => {
  const h = await fixture();
  assert.equal(h.phase(), "idle"); assert.match(h.host.textContent, /No Mods/);
  assert.match(h.host.textContent, /0 Mods/); assert.equal(h.action("start").disabled, true);
  assert.equal(h.action("files").disabled, false); assert.equal(h.action("folder").disabled, false);
  assert.doesNotMatch(h.host.textContent, /AI|master switch|step/i);
  assert.ok(walk(h.host).every((element) => !element.getAttribute("title")));
});

test("analyzing locks edits; mixed states default to ready/update only, with aligned row cells", async () => {
  const h = await fixture(), pending = h.page.drop(["/fixtures/folder"]); await flush();
  assert.equal(h.phase(), "analyzing"); assert.match(h.host.textContent, /Analyzing/);
  for (const action of ["files", "folder", "clear", "recheck", "options", "start"]) assert.equal(h.action(action).disabled, true);
  h.analyses[0].resolve({ entries: mixed(), skipped: 3 }); await pending; await h.page.settled();
  assert.deepEqual([...h.page.model.state.checked], ["a", "b"]); assert.equal(h.action("start").getAttribute("aria-label"), "Import (2)");
  for (const id of ["c", "d", "e"]) {
    const input = h.row(id).querySelector("input"); assert.equal(input.checked, false); assert.equal(input.disabled, true);
    h.page.model.toggle(id, true); assert.equal(h.page.model.state.checked.has(id), false);
  }
  assert.match(h.row("e").textContent, /No Matching Game File/);
  assert.match(h.row("a").textContent, /Saved Alias/);
  assert.equal(h.row("a").children.length, h.row("e").children.length);
  assert.equal(h.thumbs.length, 0, "declined Spine licence leaves static catalog portraits");
});

test("search includes all catalog names and aliases; state counts are unfiltered and sort toggles", async () => {
  const h = await fixture(); await h.analyze();
  const search = h.host.querySelector(".import-search"); search.value = "JP b";
  await search.dispatch("input", { isComposing: true }); assert.ok(h.row("a"));
  await search.dispatch("compositionend"); assert.ok(!h.row("a")); assert.ok(h.row("b"));
  await h.action("filter").click(); await flush(); await h.page.settled();
  assert.match(h.dialog.textContent, /Already in Library \(1\)/);
  await walk(h.dialog).find((e) => e.dataset.value === "blocked").click();
  await h.action("ok", h.dialog).click(); await h.page.settled(); assert.ok(!h.row("b"));
  search.value = ""; await search.dispatch("input"); assert.ok(h.row("e"));
  await h.action("filter").click(); await flush();
  await walk(h.dialog).find((e) => e.dataset.value === "all").click();
  await h.action("ok", h.dialog).click(); await h.page.settled();
  const before = walk(h.host).filter((element) => element.dataset.entry).map((element) => element.dataset.entry);
  await h.action("order").click();
  assert.deepEqual(walk(h.host).filter((element) => element.dataset.entry).map((element) => element.dataset.entry), before.reverse());
});

test("all/none follow eligibility; removal keeps source files out of the next full analysis", async () => {
  const h = await fixture(); await h.analyze();
  await h.action("none").click(); assert.equal(h.page.model.state.checked.size, 0);
  await h.action("all").click(); assert.deepEqual([...h.page.model.state.checked], ["a", "b"]);
  await h.row("b").querySelector("button").click(); await h.action("remove").click(); assert.ok(!h.row("b"));
  const recheck = h.page.model.recheck(); await flush();
  assert.deepEqual(h.analyses.at(-1).params.paths, mixed().filter((entry) => entry.id !== "b").flatMap((entry) => entry.paths));
  h.analyses.at(-1).resolve({ entries: mixed().filter((entry) => entry.id !== "b"), skipped: 0 }); await recheck;
  await h.action("clear").click(); assert.equal(h.page.model.state.entries.length, 0); assert.equal(h.action("start").disabled, true);
});

test("file and folder pickers follow the contract; recursive resets off and cancellation adds nothing", async () => {
  const h = await fixture();
  await h.action("files").click(); await flush();
  assert.deepEqual(h.calls.find((call) => call.method === "import.pick").params, { folder: false, recursive: false });
  assert.equal(h.analyses.length, 0);
  h.answers.push({ button: "ok", checked: true }); await h.action("folder").click(); await flush();
  assert.deepEqual(h.calls.filter((call) => call.method === "import.pick").at(-1).params, { folder: true, recursive: true });
  h.answers.push({ button: "cancel", checked: true }); await h.action("folder").click(); await flush();
  assert.equal(h.messages.at(-1).check.checked, false);
  assert.equal(h.calls.filter((call) => call.method === "import.pick").length, 2);
});

test("duplicate source paths are silently skipped; new input analyzes all retained files", async () => {
  const h = await fixture(); await h.analyze([entry("a")]);
  await h.page.drop(entry("a").paths); assert.equal(h.analyses.length, 1);
  const adding = h.page.drop([...entry("a").paths, ...entry("b").paths]); await flush();
  assert.deepEqual(h.analyses.at(-1).params.paths, ["/fixtures/a.bundle", "/fixtures/b.bundle"]);
  h.analyses.at(-1).resolve({ entries: [entry("a"), entry("b")], skipped: 1 }); await adding;
  assert.equal(h.page.model.state.entries.length, 2); assert.doesNotMatch(h.host.textContent, /duplicate/i);
});

test("confirmation counts only selected eligible states and Cancel never starts a job", async () => {
  const h = await fixture(); await h.analyze();
  await h.action("start").click(); await flush();
  assert.deepEqual(h.messages[0].lines, ["Ready: 1", "Needs Update: 1"]); assert.equal(h.messages[0].ok, "Import (2)");
  assert.equal(h.runs.length, 0);
  const check = h.row("a").querySelector("input"); check.checked = false; await check.dispatch("change");
  await h.action("start").click(); await flush(); assert.deepEqual(h.messages[1].lines, ["Needs Update: 1"]);
});

test("running captures IDs/options, follows job progress, survives hiding and shows per-Mod results", async () => {
  const h = await fixture(); await h.analyze(); h.answers.push({ button: "ok" });
  await h.action("start").click(); await flush();
  assert.equal(h.phase(), "running"); assert.deepEqual(h.runs[0].params, { ids: ["a", "b"], options });
  assert.equal(h.action("options").disabled, true); assert.equal(h.row("a").querySelector("input").disabled, true);
  h.runs[0].progress({ done: 1, total: 2, current: "b", phase: "update" }); await h.page.settled();
  assert.match(h.host.textContent, /Updating - 1\/2 Student b/);
  assert.equal(h.host.querySelector(".import-progress").getAttribute("aria-valuenow"), "1");
  h.page.hide(); assert.equal(h.scopes[0].cancelled, true);
  h.runs[0].resolve({ results: [{ id: "a", outcome: "imported", reason: null, libraryId: "lib-a", applied: false },
    { id: "b", outcome: "failed", reason: "unreadable", libraryId: null, applied: false }] }); await flush();
  await h.page.show(h.context, catalog); assert.equal(h.phase(), "done"); assert.equal(h.changed(), 1);
  assert.equal(h.action("start").getAttribute("aria-label"), "View Results"); assert.match(h.host.textContent, /Done: 1, failed: 1/);
  await h.page.results();
  assert.match(h.dialog.textContent, /Added to Library/); assert.match(h.dialog.textContent, /Not Applied/);
  assert.match(h.dialog.textContent, /Unreadable File/);
  assert.equal(walk(h.dialog).filter((element) => element.dataset.result).length, 2);
  await h.action("ok", h.dialog).click(); assert.equal(h.dialog.hidden, true);
});

test("analysis and run errors remain visible and prevent stale execution until recheck", async () => {
  const h = await fixture(); const adding = h.page.drop(["/fixtures/new.bundle"]); await flush();
  h.analyses[0].reject({ code: "game_running" }); await adding; await h.page.settled();
  assert.equal(h.phase(), "error"); assert.match(h.host.textContent, /Close the game first/); assert.equal(h.action("start").disabled, true);
  const retry = h.page.model.recheck(); await flush(); assert.deepEqual(h.analyses[1].params.paths, ["/fixtures/new.bundle"]);
  h.analyses[1].resolve({ entries: [entry("a")], skipped: 0 }); await retry;
  h.answers.push({ button: "ok" }); await h.action("start").click(); await flush();
  h.runs[0].reject({ code: "future_error" }); await flush();
  assert.equal(h.phase(), "error"); assert.match(h.host.textContent, /Import Failed/); assert.doesNotMatch(h.host.textContent, /future_error/);
  assert.equal(h.action("start").disabled, true); assert.equal(h.action("recheck").disabled, false);
});

test("advanced options save the exact Options contract and isolate ALL from individual types", async () => {
  const h = await fixture(); await h.page.openOptions();
  const inputs = walk(h.dialog).filter((element) => element.tagName === "INPUT");
  const types = h.dialog.querySelector("fieldset").querySelectorAll("input");
  assert.equal(types[0].checked, true); types[1].checked = true; await types[1].dispatch("change"); assert.equal(types[0].checked, false);
  const workers = inputs.find((input) => input.type === "number"); workers.value = "0"; await workers.dispatch("input");
  await h.action("ok", h.dialog).click(); assert.match(h.dialog.textContent, /Threads: 1 or more/); assert.equal(h.dialog.hidden, false);
  workers.value = "8"; await workers.dispatch("input");
  const output = inputs.find((input) => input.getAttribute("aria-label") === "Output Folder"); output.value = " /fixtures/output "; await output.dispatch("input");
  await h.action("ok", h.dialog).click();
  assert.equal(h.dialog.hidden, true);
  assert.deepEqual(h.calls.find((call) => call.method === "import.setOptions").params, { ...options, types: ["Texture2D"], workers: 8, output: "/fixtures/output" });
});

test("options save errors keep the dialog open and report localized text", async () => {
  const h = await fixture(); await h.page.openOptions(); h.saveError({ code: "bad_params" });
  await h.action("ok", h.dialog).click(); assert.equal(h.dialog.hidden, false); assert.match(h.dialog.textContent, /Invalid parameters/);
  await h.action("cancel", h.dialog).click(); assert.equal(h.dialog.hidden, true);
});

test("licensed previews pair the current game with analyzed sources and draw incoming row thumbnails", async () => {
  const h = await fixture({ licensed: true }); await h.analyze();
  assert.ok(h.thumbs.some(([base]) => base.includes("/spr/a_spr/")));
  assert.ok(h.thumbs.some(([base, frame]) => base.includes("/import/source-a/") && frame === "bust"));
  assert.doesNotMatch(h.host.textContent, /Preview Unavailable/);
  for (const observer of observers) observer.reveal(); await flush();
  assert.ok(h.thumbs.some(([base, frame, , lobby]) => base.includes("/import/source-b/") && frame === "card" && lobby));
  assert.ok(!h.thumbs.some(([base, frame]) => base.includes("/lobby/b_home/") && frame === "card"));
  h.page.model.select("c"); await flush();
  assert.ok(h.thumbs.some(([base]) => base.includes("/mod/lib-known/")));
  h.page.model.select("b"); await flush();
  assert.ok(h.thumbs.some(([base]) => base.includes("/lobby/b_home/")));
});

test("missing incoming previews keep the static fallback and never borrow current game art", async () => {
  const h = await fixture({ licensed: true }); await h.analyze([{ ...entry("a"), preview: null }]);
  assert.match(h.host.textContent, /Preview Unavailable/);
  for (const observer of observers) observer.reveal(); await flush();
  assert.ok(h.thumbs.every(([base, frame]) => base.includes("/spr/a_spr/") && frame === "bust"));
  assert.equal(h.row("a").querySelector(".import-thumb").dataset.source, "/portrait/a.png");
});

test("reanalysis replaces the incoming preview for the same entry ID", async () => {
  const h = await fixture({ licensed: true }); await h.analyze([entry("a")]);
  const checking = h.page.model.recheck(); await flush();
  h.analyses.at(-1).resolve({ entries: [{ ...entry("a"), preview: { kind: "import", key: "source-a-new" } }], skipped: 0 });
  await checking; await flush();
  assert.ok(h.thumbs.some(([base, frame]) => base.includes("/import/source-a-new/") && frame === "bust"));
  assert.ok(h.host.querySelector(".incoming").querySelector(".import-preview-image").dataset.source.includes("/import/source-a-new/"));
});

test("special lobby categories keep lobby source selection and framing", async () => {
  const h = await fixture({ licensed: true });
  const special = structuredClone(catalog);
  special.families[1].variants[0].spineCategory = "spinebackground";
  await h.page.show(h.context, special);
  await h.analyze([entry("b", "ready", "lobby")]);
  assert.ok(h.thumbs.some(([base, frame, , lobby, framing]) => base.includes("/lobby/b_home/") && frame === "bust" && lobby && framing === "scene"));
  assert.ok(h.thumbs.some(([base, frame, , lobby, framing]) => base.includes("/import/source-b/") && frame === "bust" && lobby && framing === "scene"));
});

test("DOM drops forward native paths and browser-only drops explain native availability", async () => {
  const h = await fixture({ native: false });
  await h.host.children[0].dispatch("drop", { dataTransfer: { files: [{ name: "a.bundle" }] } }); await h.page.settled();
  assert.match(h.host.textContent, /Not available in browser mode/); assert.equal(h.analyses.length, 0);
  await h.host.children[0].dispatch("drop", { dataTransfer: { files: [{ path: "/fixtures/a.bundle" }] } }); await flush();
  assert.deepEqual(h.analyses[0].params, { paths: ["/fixtures/a.bundle"], recursive: false });
  h.analyses[0].resolve({ entries: [entry("a")], skipped: 0 }); await flush();
});

test("optional helpers are consulted on copies, failures are contained and selection stays authoritative", async () => {
  const h = await fixture({ suggest: async ({ entries }) => { entries[0].state = "blocked"; return [{ select: ["e"] }]; } });
  await h.analyze(); await flush(); assert.equal(h.page.model.state.entries[0].state, "ready");
  assert.deepEqual([...h.page.model.state.checked], ["a", "b"]); assert.deepEqual(h.page.model.state.suggestions, [{ select: ["e"] }]);
  const provider = () => [{ match: "a" }], broken = () => { throw new Error("optional"); };
  importAssistants.add(provider); importAssistants.add(broken);
  try { assert.deepEqual(await suggestImports({ entries: [] }), [{ match: "a" }]); } finally { importAssistants.clear(); }
  assert.equal(entryIdentity(entry("a"), catalogEntries(catalog)).name, "Saved Alias");
});

test("confirmation locks selection and drops until answered, and changed game files invalidate its snapshot", async () => {
  const h = await fixture(); await h.analyze(); const answer = deferred(); h.answers.push(answer);
  await h.action("start").click(); await flush();
  assert.equal(h.action("files").disabled, true); h.page.model.toggle("a", false);
  assert.equal(h.page.model.state.checked.has("a"), true);
  await h.page.drop(["/fixtures/later.bundle"]); assert.equal(h.analyses.length, 1);
  h.page.model.invalidate(); answer.resolve({ button: "ok" }); await flush();
  assert.equal(h.runs.length, 0); assert.equal(h.action("start").disabled, true);
});

test("recheck respects manual deselection and automatically selects newly eligible entries", async () => {
  const h = await fixture(); await h.analyze(); h.page.model.toggle("a", false);
  const recheck = h.page.model.recheck(); await flush();
  const entries = mixed(); entries[4].state = "ready"; entries[4].reason = null;
  h.analyses.at(-1).resolve({ entries, skipped: 0 }); await recheck;
  assert.deepEqual([...h.page.model.state.checked], ["b", "e"]);
});

test("a game-file change during analysis requires another check before import", async () => {
  const h = await fixture(), pending = h.page.drop(["/fixtures/a.bundle"]); await flush(); h.page.model.invalidate();
  h.analyses[0].resolve({ entries: [entry("a")], skipped: 0 }); await pending; await h.page.settled();
  assert.equal(h.page.model.state.valid, false); assert.equal(h.phase(), "error");
  assert.match(h.host.textContent, /Game files changed, check again/); assert.equal(h.action("start").disabled, true);
});

test("failed option reads cannot release an in-flight analysis lock", async () => {
  const reading = deferred(), checking = deferred(); let optionReads = 0;
  const model = createImportState({ rpc: async (method) => {
    if (method === "import.options") { optionReads++; return reading.promise; }
    return "job";
  }, waitJob: () => checking.promise });
  const firstRead = model.loadOptions(), secondRead = model.loadOptions();
  const analyzing = model.add(["/fixtures/a.bundle"]); await flush();
  reading.reject({ code: "bad_params" }); await firstRead; await secondRead;
  assert.equal(optionReads, 1); assert.equal(model.state.phase, "analyzing"); assert.equal(model.busy(), true);
  checking.resolve({ entries: [entry("a")], skipped: 0 }); await analyzing;
  assert.equal(model.state.phase, "idle"); assert.equal(model.state.valid, true);
});

test("the window's native drop event goes directly to Batch Import on its route", async () => {
  const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
  const drop = source.slice(source.indexOf('  on("drop",'), source.indexOf('  $("top-option").addEventListener'));
  const calls = []; let handler;
  const env = { on: (_event, fn) => { handler = fn; }, location: { hash: "#/import" },
    BatchImport: { drop: async (paths) => calls.push(paths) }, ModAdd: { add: () => assert.fail("use the import analyzer") },
    toast: () => assert.fail("no drop error"), T: (key) => key };
  new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${drop}`)(env);
  await handler({ paths: ["/fixtures/a.bundle"] }); assert.deepEqual(calls, [["/fixtures/a.bundle"]]);
});


const treeNodes = (tree) => [tree, ...(tree.children || []).flatMap(treeNodes)];
test("the page clones runtime Items/Mailbox widgets and has no invented empty preview or key hint", async () => {
  const h = await fixture();
  assert.deepEqual(h.loaded, ["UINonEquipmentInventory", "UIMailBox", "UIMailBoxContent", "UIPopup_FilterSort", "UINonEquipmentInventoryListItem", "UICharacterCollection"]);
  assert.equal(h.host.querySelector(".import-detail").textContent, "");
  await h.analyze(); await h.page.openOptions(); await h.page.settled();
  assert.equal(h.dialog.querySelector("select"), null, "options use the game's radio widgets");
  for (const { tree } of h.rendered.filter(({ tree }) => !tree.name.startsWith("Option_"))) for (const n of treeNodes(tree)) for (const w of n.widgets) {
    if ("w_" in w) assert.equal(w.prefabMarker, true, `invented widget: ${n.name}`);
  }
  assert.deepEqual(h.layouts, h.layoutSnapshot, "runtime cached prefabs are never mutated");
  assert.equal(h.host.querySelector("img"), null, "pictures bind to prefab UITexture widgets");
  assert.equal(h.host.querySelector(".import-preview-image").dataset.path, "EquipPos/Texture");
  assert.equal(h.row("a").querySelector(".import-thumb").dataset.path, "List_01/BG_Icon/Icon_Arona");
  const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/batch-import.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /ui\.(sprite|node)\(|import\.choose|\b[Kk]ey[Hh]int/);
  const css = readFileSync(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  const rules = css.slice(css.indexOf("/* Batch Import:"), css.indexOf("/* Batch Import:") + css.slice(css.indexOf("/* Batch Import:")).indexOf("\n/*", 3));
  assert.doesNotMatch(rules, /border-radius|box-shadow|#[0-9a-f]{3,8}|linear-gradient|drop-shadow/i);
});

test("mail row columns and native checkbox/selection widgets stay aligned for every state", async () => {
  const h = await fixture(); await h.analyze();
  const cards = h.rendered.filter(({ tree }) => ["List_01", "List_02"].includes(tree.name));
  assert.equal(cards.length, 5);
  for (const { tree } of cards) {
    assert.deepEqual(find(tree, "Label_From").pos, [110, -23]);
    assert.deepEqual(find(tree, "TimeLimit").pos, [605, -23]);
    assert.ok(find(tree, "Label_System").widgets[0].prefabMarker);
    assert.equal(find(tree, "Btn_Receive"), undefined, "row actions are selection, not a decorative receive button");
  }
  const tones = cards.map(({ tree }) => find(tree, "TimeLimit/Bg").widgets[0].color);
  assert.equal(new Set(tones).size, 5, "status tones come from distinct game widgets");
  for (const id of ["a", "b", "c", "d", "e"]) {
    assert.ok(h.row(id).querySelector(".import-check-art"));
    assert.equal(h.row(id).querySelector(".import-selection").hidden, id !== "a");
  }
  h.page.model.select("e"); await h.page.settled();
  assert.equal(h.row("a").querySelector(".import-selection").hidden, true);
  assert.equal(h.row("e").querySelector(".import-selection").hidden, false);
  assert.equal(h.row("e").querySelector("input").checked, false);
});

test("state filter cancellation preserves the list and advanced radio controls save the exact option values", async () => {
  const h = await fixture(); await h.analyze();
  await h.action("filter").click(); await flush();
  await walk(h.dialog).find((e) => e.dataset.value === "blocked").click();
  await h.action("cancel", h.dialog).click(); assert.ok(h.row("a")); assert.ok(h.row("e"));
  await h.page.openOptions();
  for (const value of ["path_id", "off", "lz4"]) await walk(h.dialog).find((e) => e.dataset.value === value).click();
  await h.action("ok", h.dialog).click();
  assert.deepEqual(h.calls.find((c) => c.method === "import.setOptions").params,
    { ...options, strategy: "path_id", crc: "off", compression: "lz4" });
});

test("a late button render cannot replace a newer count or enabled state", async () => {
  const h = await fixture();
  const hold = h.holdRender((tree) => treeNodes(tree).some((n) => n.widgets.some((w) => w.text === "Import (1)")));
  const adding = h.page.drop(entry("a").paths); await flush();
  h.analyses[0].resolve({ entries: [entry("a")], skipped: 0 }); await adding; await flush();
  h.page.model.toggle("a", false); await flush();
  hold.resolve(); await h.page.settled();
  assert.equal(h.action("start").disabled, true);
  assert.equal(h.action("start").getAttribute("aria-label"), "Import (0)");
  assert.equal(h.action("start").textContent, "Import (0)");
});


test("resized real button patterns are clipped to the inclined body at every page scale and flip", async () => {
  const layouts = makeImportLayouts(), art = importArtwork({ find, fitText: (text, fs) => ({ text, fs }) }, layouts);
  for (const primary of [false, true]) for (const width of [180, 230, 330]) for (const scale of [0.34, 0.4, 0.5, 0.6]) for (const flip of [0, 3]) {
    const tree = art.button("A long action caption", width / scale, primary);
    for (const n of treeNodes(tree)) for (const w of n.widgets) if (/_Pt$/.test(w.sprite || "")) w.flip = flip;
    const view = await renderImportTree(tree, new El(), { scale, origin: [width / 2, 50] });
    clipButtonPatterns(view);
    for (const [path, entry] of view.nodes) {
      const w = entry.node.widgets.find((w) => /_Pt$/.test(w.sprite || "")); if (!w) continue;
      const parent = view.nodes.get(path.slice(0, path.lastIndexOf("/")));
      const bg = parent.node.widgets.find((w) => w.sprite === "Common_Btn_BG");
      const rect = (e) => ["left", "top", "width", "height"].map((k) => parseFloat(e.style[k]));
      const [bl, bt, bw, bh] = rect(parent.els[0]), [pl, pt, pw, ph] = rect(entry.els[0]);
      assert.ok(entry.els[0].style.clipPath.startsWith("polygon("));
      const points = entry.els[0].style.clipPath.match(/-?[\d.]+(?=px)/g).map(Number);
      assert.equal(points.length, 8); assert.ok(points.every(Number.isFinite));
      for (let i = 0; i < points.length; i += 2) {
        const x = pl + pw / 2 + (points[i] - pw / 2) * (flip === 3 ? -1 : 1);
        const y = pt + ph / 2 + (points[i + 1] - ph / 2) * (flip === 3 ? -1 : 1);
        const left = bl + Math.tan(bg.incline * Math.PI / 180) * (bh / 2 - (y - bt));
        assert.ok(y >= bt - 1e-6 && y <= bt + bh + 1e-6);
        assert.ok(x >= left - 1e-6 && x <= left + bw + 1e-6, "pattern escapes the prefab body");
      }
    }
  }
});

const drawn = (h, element) => h.rendered.findLast((item) => item.host === element.art);
const rectOf = (element) => ["left", "top", "width", "height"].map((key) => parseFloat(element.style[key]));
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.02, `${actual} != ${expected}`);

test("every page action swaps its whole disabled prefab, including both dotted patterns, through the job lifecycle", async () => {
  const h = await fixture();
  const actions = ["files", "folder", "options", "clear", "remove", "all", "none", "recheck", "start"];
  const check = async () => {
    await h.page.settled();
    for (const action of actions) {
      const button = h.action(action), { tree } = drawn(h, button);
      const patterns = treeNodes(tree).flatMap((n) => n.widgets.filter((w) => /_Pt$/.test(w.sprite || "")));
      assert.ok(patterns.length);
      const kind = button.disabled ? "B_C" : action === "start" ? "Y_S" : "B_S";
      assert.ok(patterns.every((w) => w.sprite === `Common_Btn_Normal_${kind}_Pt`), action);
      if (button.disabled && action !== "start") {
        assert.equal(patterns.length, 2, "the entire Mailbox disabled state is retained");
        assert.equal(patterns[1].color, "#ffffff/0.80");
        assert.equal(patterns[1].flip, 3);
      }
      for (const n of treeNodes(tree)) assert.ok(n.scale.every((scale) => scale > 0));
    }
  };
  await check();
  const pending = h.page.drop(entry("a").paths); await flush(); await check();
  h.analyses[0].resolve({ entries: [entry("a")], skipped: 0 }); await pending; await check();
  const graphic = h.row("a").querySelector(".import-check-art");
  assert.equal(find(drawn(h, graphic).tree, "CheckBoxIcon").active, true);
  h.answers.push({ button: "ok" }); await h.action("start").click(); await flush(); await check();
  assert.equal(find(drawn(h, graphic).tree, "CheckBoxIcon").active, false);
  assert.equal(find(drawn(h, graphic).tree, "CheckBoxIcon_Disable").active, true);
  h.runs[0].resolve({ results: [{ id: "a", outcome: "imported", libraryId: "lib-a", applied: false }] });
  await flush(); await check();
  assert.equal(h.action("start").disabled, false, "View Results uses the enabled primary state");
  assert.equal(h.action("all").disabled, true);
});

test("advanced boolean, choice, resource and input rows share Settings' body, title, dotted line and spacing", async () => {
  const h = await fixture(); await h.page.openOptions(); await h.page.settled();
  const groups = walk(h.dialog).filter((element) => element.dataset.option);
  assert.equal(groups.length, 10);
  for (const group of groups) {
    const { tree, opts } = drawn(h, group), key = group.dataset.option;
    const height = parseFloat(group.style.height) / S;
    const base = rowBase(`Option_${key}`, 0, height, find(tree, "Title").widgets[0].text);
    assert.deepEqual(tree.widgets, base.widgets);
    assert.deepEqual(find(tree, "Title"), find(base, "Title"));
    assert.deepEqual(find(tree, "DotLine"), find(base, "DotLine"));
    assert.equal(opts.scale, S); closeTo(parseFloat(group.style.width), OPTION_WIDTH * S);
    closeTo(parseFloat(group.style.marginBottom), 24 * S);
  }
  const enable = groups.find((group) => group.dataset.option === "enableAfterImport");
  assert.equal(enable.querySelector("input"), null, "boolean options show labelled On/Off choices");
  const off = walk(enable).find((element) => element.dataset.value === "false");
  await off.click(); await h.page.settled();
  assert.equal(off.getAttribute("aria-checked"), "true");
  assert.equal(walk(enable).find((element) => element.dataset.value === "true").getAttribute("aria-checked"), "false");
  const expected = radioRow("Option_enableAfterImport", 0, "Enable Mods After Import", [[true, "On"], [false, "Off"]], false, () => {}).tree;
  assert.deepEqual(drawn(h, enable).tree, expected);
  await h.action("ok", h.dialog).click();
  assert.equal(h.calls.find((call) => call.method === "import.setOptions").params.enableAfterImport, false);
});

test("search and editable option fields cover the real sprite, keep text inside its frame, and put clear above the art", async () => {
  const h = await fixture(); await h.page.openOptions(); await h.page.settled();
  for (const wrap of [...h.host.querySelectorAll(".import-input-wrap"), ...h.dialog.querySelectorAll(".import-input-wrap")]) {
    const { tree, opts } = drawn(h, wrap), input = wrap.querySelector("input");
    const body = tree.widgets.find((w) => "sprite" in w), line = find(tree, "BG_Line").widgets.find((w) => "sprite" in w);
    closeTo(body.w_ * opts.scale, parseFloat(wrap.style.width));
    closeTo(line.w_, body.w_); closeTo(line.h_, body.h_);
    const [x, y, w, height] = rectOf(input);
    assert.ok(x >= 0 && x + w <= parseFloat(wrap.style.width));
    assert.ok(y >= 0 && y + height <= 112 * S);
    closeTo(y + height / 2, 56 * S);
    assert.equal(find(tree, "InputField/Label_Search").widgets[0].text, "");
    assert.equal(find(tree, "InputField/Label_Locale_Input").widgets[0].text, "");
    if (input.classList.contains("import-search")) {
      const clear = wrap.querySelector(".import-search-clear"), [cx, cy, cw, ch] = rectOf(clear);
      assert.ok(cx >= x + w && cx + cw <= parseFloat(wrap.style.width));
      closeTo(cy + ch / 2, 56 * S);
      assert.equal(cw, 110 * S);
      assert.equal(input.type, "text", "the roster's native input avoids a second browser search cancel icon");
    } else {
      assert.equal(find(tree, "Icon_Search").active, false);
      assert.equal(find(tree, "Btn_Close").active, false);
      closeTo(w, (body.w_ - 60) * S);
    }
  }
  await h.action("cancel", h.dialog).click(); await h.analyze();
  const input = h.host.querySelector(".import-search"); input.value = "b_home"; await input.dispatch("input");
  assert.equal(h.row("a"), undefined);
  await h.host.querySelector(".import-search-clear").click(); assert.ok(h.row("a")); assert.equal(document.activeElement, input);
  await input.dispatch("keydown", { key: "Enter", isComposing: true }); assert.equal(document.activeElement, input);
  await input.dispatch("keydown", { key: "Enter" }); assert.equal(document.activeElement, body);
});

test("the import toolbar uses the roster builders and scale for both filter and order states", async () => {
  const h = await fixture(), collection = h.layouts.UICharacterCollection;
  const search = searchTree(collection);
  assert.equal(find(search, "SearchName/SearchNameArea").widgets.find((w) => "sprite" in w).h_, 112);
  const assertTools = () => {
    const filter = drawn(h, h.action("filter")), order = drawn(h, h.action("order"));
    assert.equal(filter.opts.scale, S); assert.equal(order.opts.scale, S);
    const caption = h.action("filter").getAttribute("aria-label");
    assert.deepEqual(filter.tree, { ...sortBody(collection, { text: caption, fs: 48 }, 570, caption !== "All (0)" && caption !== "All (5)"), pos: [0, 0] });
    assert.deepEqual(order.tree, { ...orderBody(collection, h.action("order").getAttribute("aria-label") === "Ascending"), pos: [0, 0] });
    closeTo(parseFloat(h.action("order").style.width), 243 * S);
    closeTo(parseFloat(h.action("filter").style.height), 116 * S);
  };
  assertTools(); await h.analyze(); await h.action("order").click(); await h.page.settled(); assertTools();
  await h.action("filter").click(); await flush(); await walk(h.dialog).find((e) => e.dataset.value === "blocked").click();
  await h.action("ok", h.dialog).click(); await h.page.settled(); assertTools();
});

test("footer artwork clears the whole bottom nav and the list and dialog contents leave room for their buttons", async () => {
  const h = await fixture();
  const navTop = 1080 - 104;
  for (const action of ["options", "recheck", "start"]) {
    const button = h.action(action), top = parseFloat(button.style.top), height = parseFloat(button.style.height);
    assert.ok(top + height <= navTop - 24 + 0.01);
    for (const child of button.art.children) {
      if (child.style.clipPath) continue; // The inclined body's clipping bounds its decorative patterns.
      const [, y, , h] = rectOf(child); assert.ok(top + y + h <= navTop - 24 + 0.1);
    }
  }
  const panel = h.host.querySelector(".import-panel"), list = h.host.querySelector(".import-list");
  assert.ok(parseFloat(panel.style.top) + parseFloat(panel.style.height) < parseFloat(h.action("start").style.top));
  assert.ok(parseFloat(list.style.top) + parseFloat(list.style.height) < parseFloat(h.action("all").style.top));
  const css = readFileSync(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  assert.match(css, /\.import-search-clear\s*\{\s*z-index:\s*40/);
  const rule = css.match(/\.import-dialog-content\s*\{([^}]+)\}/)[1];
  const top = Number(rule.match(/top:\s*(\d+)px/)[1]), height = Number(rule.match(/height:\s*(\d+)px/)[1]);
  const popupButtonTop = 540 - (-12 - 1360 / 2 + 122 - 4) * S - 177 * S / 2;
  assert.ok(top + height < popupButtonTop - 16);
});

test("all six locales retain option labels, On/Off choices and the same saved values", async () => {
  const load = (locale) => flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
  try {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const strings = load(locale); setStrings(locale, strings);
      const h = await fixture(); await h.page.openOptions(); await h.page.settled();
      for (const group of walk(h.dialog).filter((element) => element.dataset.option)) {
        const key = group.dataset.option, title = strings[`webui.import.options.${key}`];
        assert.ok(title, `${locale}: ${key}`);
        assert.ok(group.textContent.includes(title), `${locale}: visible ${key}`);
        if (["extraBytes", "workers", "output"].includes(key)) assert.equal(group.querySelector("input").getAttribute("aria-label"), title);
        if (["backup", "skipUnchanged", "enableAfterImport"].includes(key)) {
          assert.equal(group.getAttribute("aria-label"), title);
          const controls = group.querySelectorAll("button");
          assert.deepEqual(controls.map((control) => control.getAttribute("aria-label")), [strings["webui.settings.post.on"], strings["webui.settings.post.off"]]);
        }
      }
      await h.action("ok", h.dialog).click();
      assert.deepEqual(h.calls.find((call) => call.method === "import.setOptions").params, options);
    }
  } finally { setStrings("en-US", load("en-US")); }
});

test("native option fields align as soon as prefab geometry is ready, before deferred sprite images", async () => {
  const h = await fixture(), hold = h.holdImages((tree) => tree.name === "SearchNameArea");
  try {
    await h.page.openOptions(); await flush();
    const field = walk(h.dialog).find((element) => element.dataset.option === "extraBytes").querySelector("input");
    assert.ok(parseFloat(field.style.width) > 0);
    closeTo(parseFloat(field.style.top), 10 * S);
  } finally { hold.resolve(); await h.page.settled(); }
});
