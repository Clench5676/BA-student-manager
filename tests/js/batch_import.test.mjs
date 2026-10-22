// The shipped page on a stand-in DOM, game renderer and the shared import RPC contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { makeImportLayouts, find, renderImportTree, FRAME_META, framePixels } from "./import_prefabs.mjs";

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
  get firstElementChild() { return this.children[0] || null; }
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
const { importArtwork, clipButtonPatterns, selectionWindow, ROW_SELECTION, ROW_SCALE, ROW_WIDTH } = await import("../../src/ba_modding_toolkit/web/js/import-layout.js");
const { frameOutline } = await import("../../src/ba_modding_toolkit/web/js/row-thumbnail.js");
const { ROW_W: OPTION_WIDTH, rowBase, radioRow } = await import("../../src/ba_modding_toolkit/web/js/settings-rows.js");
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
const catalog = { families: ["a", "b", "c", "d", "e"].map((id) => ({ key: id, variants: [{
  key: id, custom: id === "a" ? ["Saved Alias"] : [], fileId: `${id}_spr`, spr: `${id}_spr`, lobby: `${id}_home`, portrait: `/portrait/${id}.png`, bg: `/bg/${id}.png`, names: { en: { full: `Student ${id}` }, ja: { full: `JP ${id}` } },
}] })) };

async function fixture({ licensed = false, native = true, suggest, countIcons = false } = {}) {
  body.replaceChildren(); observers.length = 0;
  const host = body.appendChild(new El()), dialog = body.appendChild(new El()); dialog.id = "dialog"; dialog.hidden = true;
  const calls = [], analyses = [], runs = [], sources = [], messages = [], answers = [], thumbs = [], scopes = [], popupStack = [], holds = [];
  let pickerHold = null, pickerPaths = [], pickError = null, optionsError = null, saveError = null, changed = 0;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "import.options") { if (optionsError) throw optionsError; return structuredClone(options); }
    if (method === "import.setOptions") { if (saveError) throw saveError; return structuredClone(params); }
    if (method === "import.pick") { if (pickError) throw pickError; if (pickerHold) return pickerHold.promise; return { paths: pickerPaths }; }
    if (["import.analyze", "import.run", "import.setSource"].includes(method)) {
      const list = method === "import.analyze" ? analyses : method === "import.run" ? runs : sources, job = { ...deferred(), id: `job-${calls.length}`, params };
      list.push(job); return job.id;
    }
    assert.fail(`Unexpected RPC ${method}`);
  };
  const node = (name, pos = [0, 0], widgets = [], children = []) => ({ name, pos, widgets, children, scale: [1, 1] });
  const layouts = makeImportLayouts(), layoutSnapshot = structuredClone(layouts), rendered = [], loaded = [];
  let renderHold = null, imagesHold = null, thumbsHold = null;
  const label = (text, fontSize, color, w_, h_, opts = {}) => ({ text, fontSize, color, w_, h_, pivot: 4, depth: 9, ...opts });
  const ui = { node, label, fitText: (text, fs) => ({ text, fs }), glyphWidth: (text, fs) => String(text).length * fs, init: async () => {},
    layout: async (name) => { loaded.push(name); assert.ok(layouts[name], `Unexpected layout ${name}`); return layouts[name]; },
    atlasIndex: () => ({ Common: { Card_Select_Line: FRAME_META, ...(countIcons ? Object.fromEntries(["Student", "Play", "Craft"].map((name) => [`Common_Icon_${name}`, { width: 48, height: 48 }])) : {}) } }),
    spritePixels: async () => framePixels(),
    find, render: async (tree, host, opts) => {
      rendered.push({ tree, opts, host }); const view = await renderImportTree(tree, host, opts);
      if (renderHold?.predicate(tree)) { const hold = renderHold; renderHold = null; await hold.promise; }
      if (imagesHold?.predicate(tree)) { view.images = [imagesHold.promise]; imagesHold = null; }
      return view;
    }, decoded: async () => {},
  };
  const popups = { ready: async () => {},
    message: async (message) => { messages.push(message); const answer = answers.shift() || { button: "cancel", checked: false }; return answer.promise || answer; },
    popupFrame: () => node("Popup"), opened: (host, close, { el, loading } = {}) => {
      if (loading) { el.style.visibility = "hidden"; el.inert = true; }
      popupStack.push({ host, close });
    },
    reveal: async (layer, work) => { await Promise.all(work); layer.style.visibility = ""; layer.inert = false; },
    closed: () => popupStack.pop(), closable() {},
    hit: (host, _view, _path, fn, attrs) => {
      const button = new El("button"); button.dataset.action = attrs.action; button.setAttribute("aria-label", attrs.name);
      button.addEventListener("click", fn); host.appendChild(button); return button;
    },
  };
  const page = createImportPage({ host, call, ui, popups, allowed: () => licensed, suggest,
    loading: { hold: (work, opts) => {
      const hold = { opts, active: true }; holds.push(hold);
      const done = Promise.resolve().then(work).finally(() => { hold.active = false; });
      opts.until.then(() => { hold.active = false; }); return done;
    } },
    jobs: (id, progress) => { const job = [...analyses, ...runs, ...sources].find((job) => job.id === id); job.progress = progress; return job.promise; },
    thumbnails: () => { const scope = { cancel: () => { scope.cancelled = true; }, thumb: (...args) => { thumbs.push(args); return thumbsHold?.promise || Promise.resolve(`blob:${args[0]}`); } }; scopes.push(scope); return scope; },
  });
  const destinations = [];
  const context = { info: { native }, go: (...args) => destinations.push(args), goOther: () => destinations.push("other"), invalidateRoster: () => changed++ };
  await page.show(context, catalog); await flush();
  const action = (name, parent = host) => walk(parent).find((element) => element.dataset.action === name);
  const row = (id) => walk(host).find((element) => element.dataset.entry === id);
  const phase = () => host.children[0].dataset.phase;
  const analyze = async (entries = mixed(), paths = entries.flatMap((entry) => entry.paths)) => {
    const adding = page.drop(paths); await flush(); analyses.at(-1).resolve({ entries, skipped: 0 }); await adding; await page.settled(); await flush(); return adding;
  };
  return { page, context, destinations, host, dialog, layouts, layoutSnapshot, rendered, loaded, calls,
    holds, holdPicker: () => { pickerHold = deferred(); return pickerHold; }, holdThumbs: () => { thumbsHold = deferred(); return thumbsHold; },
    holdImages: (predicate) => { const hold = { ...deferred(), predicate }; imagesHold = hold; return hold; },
    holdRender: (predicate) => { const hold = { ...deferred(), predicate }; renderHold = hold; return hold; }, analyses, runs, sources, messages, answers, thumbs, scopes, popupStack, action, row, phase, analyze,
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
  assert.equal(h.phase(), "analyzing"); assert.doesNotMatch(h.host.textContent, /Analyzing/);
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
  assert.equal(h.thumbs.length, 0, "declined Spine licence leaves thumbnail slots empty");
});

test("search includes all catalog names and aliases; state counts are unfiltered and sort toggles", async () => {
  const h = await fixture(); await h.analyze();
  await h.action("searchToggle").click();
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

test("Import starts immediately with only selected eligible entries and no confirmation popup", async () => {
  const h = await fixture(); await h.analyze();
  h.page.model.toggle("a", false);
  await h.action("start").click(); await flush();
  assert.equal(h.messages.length, 0); assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0].params.ids, ["b"]);
  h.runs[0].resolve({ results: [] }); await flush();
});

test("running captures IDs/options, follows job progress, survives hiding and shows per-Mod results", async () => {
  const h = await fixture(); await h.analyze(); h.answers.push({ button: "ok" });
  await h.action("start").click(); await flush();
  assert.equal(h.phase(), "running"); assert.deepEqual(h.runs[0].params, { ids: ["a", "b"], options });
  assert.equal(h.action("options").disabled, true); assert.equal(h.row("a").querySelector("input").disabled, true);
  h.runs[0].progress({ done: 0, index: 2, total: 2, current: "b", phase: "update", step: "import.step.crc" }); await h.page.settled();
  assert.equal(h.host.querySelector(".import-progress"), null);
  assert.doesNotMatch(h.host.textContent, /Updating.*Student b/);
  assert.equal(h.holds.findLast((hold) => hold.active).opts.progress(), "Updating Student b (Memorial Lobby) 2 / 2 - Repairing CRC");
  h.page.hide(); assert.equal(h.scopes[0].cancelled, true);
  h.runs[0].resolve({ results: [{ id: "a", outcome: "imported", reason: null, libraryId: "lib-a", applied: false },
    { id: "b", outcome: "failed", reason: "unreadable", libraryId: null, applied: false }] }); await flush();
  await h.page.show(h.context, catalog); assert.equal(h.phase(), "done"); assert.equal(h.changed(), 1);
  assert.equal(h.action("start").getAttribute("aria-label"), "View Results"); assert.doesNotMatch(h.host.textContent, /Done: 1, failed: 1/);
  await h.page.results();
  assert.match(h.dialog.textContent, /Added to Library/); assert.match(h.dialog.textContent, /Not Applied/);
  assert.match(h.dialog.textContent, /Unreadable File/);
  assert.equal(walk(h.dialog).filter((element) => element.dataset.result).length, 2);
  await h.action("ok", h.dialog).click(); assert.equal(h.dialog.hidden, true);
});

test("analysis and run errors remain visible and prevent stale execution until recheck", async () => {
  const h = await fixture(); const adding = h.page.drop(["/fixtures/new.bundle"]); await flush();
  h.analyses[0].reject({ code: "game_running" }); await adding; await h.page.settled();
  assert.equal(h.phase(), "error"); assert.match(h.messages.at(-1).lines.join(" "), /Close the game first/); assert.equal(h.action("start").disabled, true);
  const retry = h.page.model.recheck(); await flush(); assert.deepEqual(h.analyses[1].params.paths, ["/fixtures/new.bundle"]);
  h.analyses[1].resolve({ entries: [entry("a")], skipped: 0 }); await retry;
  h.answers.push({ button: "ok" }); await h.action("start").click(); await flush();
  h.runs[0].reject({ code: "future_error" }); await flush();
  assert.equal(h.phase(), "error"); assert.match(h.messages.at(-1).lines.join(" "), /Import Failed/); assert.doesNotMatch(h.host.textContent, /future_error/);
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
  assert.ok(h.thumbs.some(([base, frame]) => base.includes("/import/source-a/") && frame === "portrait"));
  assert.doesNotMatch(h.host.textContent, /Preview Unavailable/);
  for (const observer of observers) observer.reveal(); await flush();
  assert.ok(h.thumbs.some(([base, frame, , lobby]) => base.includes("/import/source-b/") && frame === "card" && lobby));
  assert.ok(!h.thumbs.some(([base, frame]) => base.includes("/lobby/b_home/") && frame === "card"));
  h.page.model.select("c"); await flush();
  assert.ok(h.thumbs.some(([base]) => base.includes("/mod/lib-known/")));
  h.page.model.select("b"); await flush();
  assert.ok(h.thumbs.some(([base]) => base.includes("/lobby/b_home/")));
});

test("missing incoming previews leave the slot empty and never borrow current game art", async () => {
  const h = await fixture({ licensed: true }); await h.analyze([{ ...entry("a"), preview: null }]);
  assert.match(h.host.textContent, /Preview Unavailable/);
  for (const observer of observers) observer.reveal(); await flush();
  assert.ok(h.thumbs.every(([base, frame]) => base.includes("/spr/a_spr/") && frame === "portrait"));
  assert.equal(h.row("a").querySelector(".import-thumb").dataset.source, undefined);
});

test("reanalysis replaces the incoming preview for the same entry ID", async () => {
  const h = await fixture({ licensed: true }); await h.analyze([entry("a")]);
  const checking = h.page.model.recheck(); await flush();
  h.analyses.at(-1).resolve({ entries: [{ ...entry("a"), preview: { kind: "import", key: "source-a-new" } }], skipped: 0 });
  await checking; await flush();
  assert.ok(h.thumbs.some(([base, frame]) => base.includes("/import/source-a-new/") && frame === "portrait"));
  assert.ok(h.host.querySelector(".incoming").querySelector(".import-preview-image").dataset.source.includes("/import/source-a-new/"));
});

test("special lobby categories keep lobby source selection and framing", async () => {
  const h = await fixture({ licensed: true });
  const special = structuredClone(catalog);
  special.families[1].variants[0].spineCategory = "spinebackground";
  await h.page.show(h.context, special);
  await h.analyze([entry("b", "ready", "lobby")]);
  assert.ok(h.thumbs.some(([base, frame, , lobby, framing]) => base.includes("/lobby/b_home/") && frame === "landscape" && lobby && framing === "scene"));
  assert.ok(h.thumbs.some(([base, frame, , lobby, framing]) => base.includes("/import/source-b/") && frame === "landscape" && lobby && framing === "scene"));
});

test("DOM drops forward native paths and browser-only drops explain native availability", async () => {
  const h = await fixture({ native: false });
  await h.host.children[0].dispatch("drop", { dataTransfer: { files: [{ name: "a.bundle" }] } }); await h.page.settled();
  assert.match(h.messages.at(-1).lines.join(" "), /Not available in browser mode/); assert.equal(h.analyses.length, 0);
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

test("initial option loading locks selection and a changed context prevents starting", async () => {
  const reading = deferred(), model = createImportState({
    rpc: async (method) => method === "import.options" ? reading.promise : "job",
    waitJob: async () => ({ entries: [entry("a")], skipped: 0 }),
  });
  await model.add(entry("a").paths);
  const starting = model.start(); await flush();
  model.toggle("a", false); assert.equal(model.state.checked.has("a"), true);
  assert.equal(await model.add(["/fixtures/later.bundle"]), false);
  model.invalidate(); reading.resolve(options);
  assert.equal(await starting, false); assert.equal(model.state.valid, false);
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
  assert.match(h.messages.at(-1).lines.join(" "), /Game files changed, check again/); assert.equal(h.action("start").disabled, true);
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
    notify: () => assert.fail("no drop error"), T: (key) => key };
  new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${drop}`)(env);
  await handler({ paths: ["/fixtures/a.bundle"] }); assert.deepEqual(calls, [["/fixtures/a.bundle"]]);
});


const treeNodes = (tree) => [tree, ...(tree.children || []).flatMap(treeNodes)];
test("the page clones runtime Items/Mailbox widgets and has no invented empty preview or key hint", async () => {
  const h = await fixture();
  assert.deepEqual(h.loaded, ["UINonEquipmentInventory", "UIMailBox", "UIMailBoxContent", "UIPopup_FilterSort", "UINonEquipmentInventoryListItem",
    "UIPopup_GachaCharList.Btn_Checkbox"]);
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
    assert.equal(find(tree, "Label_From").pos[1], 20);
    assert.ok(find(tree, "TimeLimit").pos[1] <= 20);
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

test("analysis holds the page through generated stills and never flashes catalog thumbnails", async () => {
  const h = await fixture({ licensed: true }), gate = h.holdThumbs();
  const adding = h.page.drop(["/fixtures/a.bundle"]); await flush();
  assert.ok(h.holds.some((hold) => hold.active && hold.opts.all));
  h.analyses.at(-1).resolve({ entries: [entry("a")], skipped: 0 }); await adding; await flush();
  assert.equal(h.phase(), "idle");
  assert.ok(h.holds.some((hold) => hold.active), "the hold continues after analysis until generated stills settle");
  const image = h.row("a").querySelector(".import-thumb");
  assert.ok(!image.style.backgroundImage); assert.equal(image.dataset.source, undefined);
  const textures = h.rendered.filter(({ opts }) => opts.textures?.Icon_Arona || opts.textures?.Texture);
  for (const { opts } of textures) for (const source of Object.values(opts.textures)) assert.equal(await source, null);
  gate.resolve("blob:generated-still"); await h.page.settled(); await flush();
  assert.equal(image.dataset.source, "blob:generated-still");
  assert.equal(image.firstElementChild.style.backgroundSize, "cover"); assert.ok(image.style.clipPath.startsWith("polygon(") && image.style.clipPath.split(",").length > 4);
  for (const preview of h.host.querySelectorAll(".import-preview-image")) assert.equal(preview.style.backgroundPosition, "center top");
  assert.ok(!h.holds.some((hold) => hold.active));
});

test("leaving during thumbnail generation releases the hold and ignores late pictures", async () => {
  const h = await fixture({ licensed: true }), gate = h.holdThumbs();
  const adding = h.page.drop(["/fixtures/a.bundle"]); await flush();
  h.analyses.at(-1).resolve({ entries: [entry("a")], skipped: 0 }); await adding; await flush();
  const image = h.row("a").querySelector(".import-thumb");
  h.page.hide(); await flush();
  assert.ok(!h.holds.some((hold) => hold.active)); assert.equal(h.scopes.at(-1).cancelled, true);
  gate.resolve("blob:late-still"); await h.page.settled();
  assert.equal(image.dataset.source, undefined);
});

for (const wideFrame of [false, true]) test(`list and result text clears every thumbnail widget${wideFrame ? " with a wider inclined selection frame" : ""}`, async (t) => {
  const h = await fixture({ licensed: true });
  if (wideFrame) Object.assign(find(h.layouts.UINonEquipmentInventoryListItem, "Card/Normal/Cover_Select").widgets[0], { w_: 380, incline: 15 });
  const converting = { ...entry("a", "convert"), source: { server: "japan", platform: "android" }, target: { server: "global", platform: "windows" } };
  await h.analyze([converting, entry("b", "update"), entry("c", "installed")]);
  const gapOf = (row) => {
    const image = row.querySelector(".import-thumb"), [x, y, , height] = rectOf(image);
    assert.ok((wideFrame || x >= 0) && y >= 0 && y + height <= parseFloat(row.style.height || "216"));
    assert.equal(image.style.overflow, "hidden"); assert.ok(image.style.clipPath.startsWith("polygon(") && image.style.clipPath.split(",").length > 4);
    const slot = artworkBounds(h, row, (path) => /\/BG_Icon(?:\/|$)/.test(path));
    const selection = row.querySelector(".import-selection");
    if (selection) for (const box of artworkBounds(h, selection)) {
      slot.push([box[0] + parseFloat(selection.style.left), box[1], box[2] + parseFloat(selection.style.left), box[3]]);
    }
    const right = Math.max(...slot.map((box) => box[2]));
    const text = artworkBounds(h, row, (path) => /\/(Label_System|Label_Locale_Received|Platform|Label_Locale_Limit)$/.test(path));
    const gap = Math.min(...text.map((box) => box[0])) - right;
    assert.ok(gap >= 28, `thumbnail-to-text gap: ${gap.toFixed(2)} stage px`);
    const { tree, opts } = drawn(h, row);
    assert.equal(find(tree, "BG").widgets[0].w_, 2208);
    assert.equal(find(tree, "Label_From").pos[1], 20);
    assert.ok(find(tree, "TimeLimit").pos[1] <= 20);
    const title = text.find((box) => Math.abs(box[2] - (opts.origin[0] + 926 * opts.scale)) < 0.01);
    assert.ok(title, "the title keeps its right edge");
    if (selection) closeTo(parseFloat(row.querySelector(".import-check").style.left), 1192.32 - 66);
    return gap;
  };
  const listGap = Math.min(...["a", "b", "c"].map((id) => gapOf(h.row(id))));
  await h.action("start").click(); await flush();
  h.runs[0].resolve({ results: [converting, entry("b")].map((item) => ({ id: item.id, outcome: "imported", libraryId: `lib-${item.id}`, applied: true })) });
  await flush(); await h.page.results(); await h.page.settled();
  const resultGap = Math.min(...walk(h.dialog).filter((row) => row.dataset.result).map(gapOf));
  assert.ok(listGap >= 32 - 1e-8); assert.ok(resultGap >= 32 - 1e-8);
  t.diagnostic(`Minimum rendered gap: list ${listGap.toFixed(2)} px; results ${resultGap.toFixed(2)} px`);
});

test("both preview tags align to the panel top and both image slots to its header bottom", async () => {
  const h = await fixture(); await h.analyze([entry("a")]);
  const panel = h.host.querySelector(".import-panel"), header = h.host.querySelector(".import-header"), preview = h.host.querySelector(".import-detail");
  const paper = panel.art.children.find((e) => e.dataset.path === "ListBG/PaperBG");
  for (const box of h.host.querySelectorAll(".import-preview")) {
    const tag = box.art.children.find((e) => e.dataset.path === "EquipPos/Text_Type/TypeBG");
    const image = box.querySelector(".import-preview-image");
    const circle = box.art.children.find((e) => e.dataset.path === "EquipPos/BGCilcle");
    closeTo(parseFloat(preview.style.top) + parseFloat(tag.style.top), parseFloat(panel.style.top));
    closeTo(parseFloat(preview.style.top) + parseFloat(image.style.top), parseFloat(panel.style.top) + 44);
    assert.equal(circle, undefined, "preview decorations are removed from both pictures");
  }
  assert.equal(h.host.querySelectorAll(".import-preview").length, 2);
});

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
  const h = await fixture(); await h.action("searchToggle").click(); await h.page.openOptions(); await h.page.settled();
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

test("the Items header retains its own control sizes, transforms and states with hit areas over its widgets", async () => {
  const h = await fixture(), source = find(h.layouts.UINonEquipmentInventory, "Inventory_ListControl/RightCanvas/ListBG/BG_Top_Widget");
  const header = h.host.querySelector(".import-header");
  const assertTools = () => {
    const { tree, opts } = drawn(h, header);
    assert.equal(opts.scale, S); assert.deepEqual(tree.pos, [1272 / S - 692, 440 - 901]);
    const expanded = h.action("searchToggle").getAttribute("aria-expanded") === "true";
    for (const [key, path] of [["filter", "SortBtn/Btn_Normal"], ["order", "OrderBtn/Btn_Normal"], ["searchToggle", `SearchBtn/${expanded ? "Btn_Pressed" : "Btn_Normal"}`]]) {
      const n = find(tree, path), original = find(source, path), parent = path.split("/")[0];
      assert.deepEqual(n.widgets, original.widgets, `${key}: actual Items sprite`);
      assert.deepEqual(n.pos, original.pos); assert.deepEqual(find(tree, parent).pos, find(source, parent).pos);
      assert.deepEqual(find(tree, parent).scale, find(source, parent).scale);
      const graphic = header.art.children.find((e) => e.dataset.path === `BG_Top_Widget/${path}`);
      rectOf(h.action(key)).forEach((v, i) => closeTo(v, rectOf(graphic)[i]));
    }
    const ascending = h.action("order").getAttribute("aria-label") === "Ascending";
    assert.equal(find(tree, "OrderBtn/Btn_Normal/Icon_Up").active, ascending);
    assert.equal(find(tree, "OrderBtn/Btn_Normal/Icon_down").active, !ascending);
    const filtered = h.action("filter").getAttribute("aria-label").startsWith("Cannot Import");
    assert.equal(find(tree, "SortBtn/Btn_Normal/FilterMarker_On").active, filtered);
    assert.equal(find(tree, "SortBtn/Btn_Normal/FilterMarker_Off").active, !filtered);
    assert.equal(find(tree, "SortBtn/Btn_Normal/Type_2/Text").widgets[0].ellipsis, true);
  };
  assertTools(); await h.analyze(); await h.action("order").click(); await h.page.settled(); assertTools();
  await h.action("filter").click(); await flush(); await walk(h.dialog).find((e) => e.dataset.value === "blocked").click();
  await h.action("ok", h.dialog).click(); await h.page.settled(); assertTools();
  const search = h.host.querySelector(".import-search"), wrap = h.host.querySelector(".import-input-wrap"), list = h.host.querySelector(".import-list");
  assert.equal(wrap.hidden, true); closeTo(parseFloat(list.style.top), 202);
  await h.action("searchToggle").click(); await h.page.settled(); assertTools();
  assert.equal(wrap.hidden, false); assert.equal(document.activeElement, search); closeTo(parseFloat(list.style.top), 294);
  search.value = "JP e"; await search.dispatch("compositionend"); assert.ok(h.row("e"));
  await h.action("searchToggle").click(); await h.page.settled(); assertTools();
  assert.equal(wrap.hidden, true); closeTo(parseFloat(list.style.top), 202); assert.equal(search.value, "JP e");
  assert.deepEqual(h.layouts, h.layoutSnapshot);
});

// Include each inclined sprite's overhang; checking only the button rectangles missed earlier regressions.
function artworkBounds(h, element, predicate = () => true) {
  const { tree } = drawn(h, element);
  return element.art.children.filter((e) => predicate(e.dataset.path)).map((e) => {
    const path = e.dataset.path.split("/").slice(1).join("/"), n = path ? find(tree, path) : tree;
    const w = n.widgets.find((w) => "sprite" in w || "text" in w || "texture" in w);
    const [x, y, width, height] = rectOf(e), skew = Math.abs(Math.tan((w.incline || 0) * Math.PI / 180) * height / 2);
    return [x - skew, y, x + width + skew, y + height];
  });
}

test("empty, full, filtered and long Thai toolbars fit the header, with search and count clear of the list", async () => {
  const english = flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8")));
  const thai = flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/th-TH.json", import.meta.url), "utf8")));
  try {
    for (const strings of [english, thai, { ...thai,
      "webui.import.list": thai["webui.import.list"].repeat(12),
      "webui.import.filterCount": thai["webui.import.filterCount"].repeat(12),
      "webui.import.count": thai["webui.import.count"].repeat(12),
    }]) {
      setStrings(strings === english ? "en-US" : "th-TH", strings);
      const h = await fixture();
      const check = async () => {
        await h.page.settled();
        const header = h.host.querySelector(".import-header"), panel = h.host.querySelector(".import-panel");
        const [,, width] = rectOf(panel), headerBottom = parseFloat(header.style.height);
        for (const [l, t, r, b] of artworkBounds(h, header)) {
          assert.ok(l >= 0 && r <= width, `header x: ${l}..${r} outside 0..${width}`);
          assert.ok(t >= 0 && b <= headerBottom, `header y: ${t}..${b} outside 0..${headerBottom}`);
        }
        const title = artworkBounds(h, header, (p) => p.endsWith("Label_Locale_Title"))[0];
        const controls = artworkBounds(h, header, (p) => !p.endsWith("Label_Locale_Title"));
        assert.ok(title[2] < Math.min(...controls.map((r) => r[0])), "title stays left of the tools");
        const list = h.host.querySelector(".import-list"), count = h.host.querySelector(".import-count");
        const [cx, cy, cw, ch] = rectOf(count), [lx, ly, lw, lh] = rectOf(list);
        closeTo(cx + cw, lx + 1192.32); closeTo(cy + ch / 2, (352 + 60 * S - (704 / S - 152) * S / 2 + 202) / 2); assert.ok(cy + ch < ly);
        assert.equal(count.parentNode, panel, "count never scrolls with rows");
        assert.ok(cy > headerBottom); assert.ok(ly + lh < parseFloat(h.action("files").style.top));
        const countBounds = artworkBounds(h, count)[0];
        closeTo(countBounds[0], 0); closeTo(countBounds[1], 0); closeTo(countBounds[2], cw); closeTo(countBounds[3], ch);
        const wrap = h.host.querySelector(".import-input-wrap");
        if (!wrap.hidden) {
          const [sx, sy, sw, sh] = rectOf(wrap);
          assert.ok(sx >= 0 && sx + sw <= width); assert.ok(sy > cy && sy + sh < ly);
        }
        for (const n of [find(drawn(h, header).tree, "Label_Locale_Title"), find(drawn(h, header).tree, "SortBtn/Btn_Normal/Type_2/Text"), drawn(h, count).tree]) {
          const label = n.widgets.find((w) => "text" in w);
          assert.equal(label.ellipsis, true); assert.ok(!label.text.includes("\n"));
        }
      };
      await check(); await h.action("searchToggle").click(); await check();
      await h.analyze(Array.from({ length: 150 }, (_, i) => entry(`mod-${i}`, i % 2 ? "blocked" : "ready")));
      await check(); await h.action("order").click(); await check();
      await h.action("filter").click(); await flush();
      await walk(h.dialog).find((e) => e.dataset.value === "blocked").click(); await h.action("ok", h.dialog).click();
      await check(); const search = h.host.querySelector(".import-search");
      search.value = "missing"; await search.dispatch("input"); assert.equal(h.host.querySelectorAll(".import-row").length, 0); await check();
      await h.host.querySelector(".import-search-clear").click(); await check();
      await h.action("searchToggle").click(); await check();
    }
  } finally { setStrings("en-US", english); }
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

test("advanced popup stays hidden until its body images finish, with native fields aligned during preparation", async () => {
  const h = await fixture(), hold = h.holdImages((tree) => tree.name === "SearchNameArea");
  const opening = h.page.openOptions();
  try {
    await flush();
    const layer = h.dialog.children[0];
    assert.equal(layer.style.visibility, "hidden");
    const field = walk(h.dialog).find((element) => element.dataset.option === "extraBytes").querySelector("input");
    assert.ok(parseFloat(field.style.width) > 0);
    closeTo(parseFloat(field.style.top), 10 * S);
    hold.resolve(); await opening; await h.page.settled();
    assert.equal(layer.style.visibility, "");
    assert.equal(layer.inert, false);
  } finally { hold.resolve(); await opening; }
});


test("unknown source opens game radio choices and reanalyzes only its entry", async () => {
  const h = await fixture({ licensed: true });
  const unknown = { ...entry("a", "blocked"), reason: "source_unknown", source: null,
    target: { server: "global", platform: "windows" } };
  await h.analyze([unknown, entry("b")]);
  assert.match(h.host.textContent, /Unknown source, select manually/);
  assert.equal(find(drawn(h, h.row("a")).tree, "Platform"), undefined, "an unknown source is not a conversion route");
  assert.ok(h.thumbs.some(([base]) => base.includes("/import/source-a")), "blocked source keeps its preview");
  await h.action("source").click(); await flush(); await h.page.settled();
  assert.match(h.dialog.textContent, /Source Server/); assert.match(h.dialog.textContent, /Source Platform/);
  const radios = walk(h.dialog).filter((element) => element.getAttribute("role") === "radio");
  assert.deepEqual(radios.map((element) => element.dataset.value), ["global", "japan", "android", "ios", "windows"]);
  await radios.find((element) => element.dataset.value === "japan").click();
  await radios.find((element) => element.dataset.value === "ios").click();
  const accepting = h.action("ok", h.dialog).click(); await flush();
  assert.deepEqual(h.sources[0].params, { id: "a", server: "japan", platform: "ios" });
  assert.equal(h.action("source").disabled, true);
  h.sources[0].resolve({ ...unknown, state: "update", reason: null,
    source: { server: "japan", platform: "ios", detected: false } });
  await accepting; await h.page.settled();
  assert.equal(h.page.model.state.entries[1].id, "b"); assert.equal(h.analyses.length, 1);
  assert.ok(h.page.model.state.checked.has("a")); assert.ok(h.page.model.state.checked.has("b"));
  assert.match(h.host.textContent, /Japan iOS → Global PC/); assert.equal(h.dialog.hidden, true);
});

test("source selection cancellation leaves the entry untouched", async () => {
  const h = await fixture();
  const unknown = { ...entry("a", "blocked"), reason: "source_unknown", source: null,
    target: { server: "global", platform: "windows" } };
  await h.analyze([unknown]);
  await h.action("source").click(); await flush();
  await h.action("cancel", h.dialog).click();
  assert.equal(h.sources.length, 0); assert.equal(h.page.model.state.entries[0], unknown);
});

test("all six locales translate source routes, choices and conversion reasons", async () => {
  const load = (locale) => flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
  try {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      const strings = load(locale); setStrings(locale, strings);
      const h = await fixture();
      await h.analyze([{ ...entry("a", "blocked"), reason: "source_unknown", source: null,
        target: { server: "global", platform: "windows" } }]);
      assert.equal(h.action("source").getAttribute("aria-label"), strings["webui.import.source.choose"]);
      await h.action("source").click(); await flush(); await h.page.settled();
      assert.ok(h.dialog.textContent.includes(strings["webui.import.source.server"]));
      assert.ok(h.dialog.textContent.includes(strings["webui.import.source.platform"]));
      assert.equal(walk(h.dialog).filter((element) => element.getAttribute("role") === "radio").length, 5);
      assert.ok(!h.dialog.textContent.includes("import.source."));
      await h.action("cancel", h.dialog).click();
    }
  } finally { setStrings("en-US", load("en-US")); }
});

test("merged rows keep variant identity, count every asset kind in place, and select only eligible Mods", async () => {
  const h = await fixture({ licensed: true });
  const a = entry("a"), lobby = { ...entry("a-lobby", "update", "lobby"), variant: "a" };
  const model = { ...entry("a-model", "blocked", "model"), variant: "a" };
  const other = { ...entry("generic", "ready", "other"), variant: "a" };
  await h.analyze([a, lobby, model, other]);
  const merge = h.action("merge").querySelector("input"); assert.equal(merge.checked, false);
  assert.equal(walk(h.host).filter((e) => e.dataset.entry).length, 4);
  merge.checked = true; await merge.dispatch("change"); await h.page.settled();
  assert.equal(walk(h.host).filter((e) => e.dataset.entry).length, 2, "generic Mods never merge into a student");
  const row = h.row("a"), check = row.querySelector("input");
  check.checked = false; await check.dispatch("change");
  assert.deepEqual([...h.page.model.state.checked], ["generic"]);
  check.checked = true; await check.dispatch("change");
  assert.deepEqual([...h.page.model.state.checked].sort(), ["a", "a-lobby", "generic"]);
  assert.equal(h.page.model.state.checked.has("a-model"), false);
  const newPortrait = { ...entry("a-second"), variant: "a" };
  const adding = h.page.drop(newPortrait.paths); await flush();
  h.analyses.at(-1).resolve({ entries: [a, lobby, model, other, newPortrait], skipped: 0 });
  await adding; await h.page.settled();
  assert.equal(h.row("a"), row, "the student row survives adding more assets");
  const sender = find(drawn(h, row).tree, "Label_From");
  assert.deepEqual(sender.children.map((node) => node.name), ["spr", "lobby", "model"]);
  assert.equal(sender.children[0].children[0].widgets[0].text.replace(/\n/g, ""), "Portrait ×2");
  assert.ok(h.thumbs.some(([, , , , , bg]) => bg === "/bg/a.png"));
});

test("results omit state badges, follow the merge setting and route every student or generic Mod", async () => {
  const h = await fixture({ countIcons: true });
  const a = entry("a"), lobby = { ...entry("a-lobby", "update", "lobby"), variant: "a" },
    model = { ...entry("a-model", "ready", "model"), variant: "a" }, other = entry("generic", "ready", "other");
  await h.analyze([a, lobby, model, other]);
  const merge = h.action("merge").querySelector("input"); merge.checked = true; await merge.dispatch("change");
  h.answers.push({ button: "ok" }); await h.action("start").click(); await flush();
  h.runs[0].resolve({ results: [a, lobby, model, other].map((entry) => ({ id: entry.id, outcome: "imported", libraryId: `lib-${entry.id}`, applied: true })) });
  await flush(); await h.page.results(); await h.page.settled();
  const rows = walk(h.dialog).filter((element) => element.dataset.result);
  assert.equal(rows.length, 2); assert.match(h.dialog.textContent, /Applied/);
  for (const row of rows) assert.equal(find(drawn(h, row).tree, "TimeLimit").active, false);
  await h.action("go", rows[0]).click(); assert.deepEqual(h.destinations, [["a", "a", "portrait"]]); assert.equal(h.dialog.hidden, true);
  await h.page.results(); await h.page.settled();
  const lobbyCount = walk(h.dialog).find((element) => element.dataset.kind === "lobby");
  assert.ok(lobbyCount);
  const row = lobbyCount.parentNode, icon = row.art.children.find((element) => element.dataset.path === "List_01/Label_From/lobby/Icon");
  const [left, top, width, height] = rectOf(lobbyCount), [ix, iy, iw, ih] = rectOf(icon);
  assert.ok(left <= ix && top <= iy && left + width >= ix + iw && top + height >= iy + ih);
  await lobbyCount.click();
  assert.deepEqual(h.destinations.at(-1), ["a", "a", "lobby"]);
  await h.page.results(); await h.page.settled();
  await walk(h.dialog).find((element) => element.dataset.kind === "model").click();
  assert.deepEqual(h.destinations.at(-1), ["a", "a", "model"]);
  await h.page.results(); await h.page.settled();
  await h.action("go", walk(h.dialog).find((row) => row.dataset.result === "generic")).click();
  assert.equal(h.destinations.at(-1), "other");
});

test("leaving removes only completed entries and reanalysis uses the remaining paths", async () => {
  const h = await fixture(); await h.analyze([entry("a"), entry("b", "done"), entry("c", "blocked"), entry("d", "installed")]);
  h.page.model.toggle("b", true); assert.equal(h.page.model.state.checked.has("b"), false);
  h.answers.push({ button: "ok" }); await h.action("start").click(); await flush();
  h.runs[0].resolve({ results: [{ id: "a", outcome: "unchanged", libraryId: "lib-a", applied: false }] }); await flush(); await h.page.settled();
  assert.match(h.row("a").textContent, /Done/); assert.match(h.row("b").textContent, /Done/);
  h.page.hide(); await h.page.show(h.context, catalog); await h.page.settled();
  assert.deepEqual(h.page.model.state.entries.map(({ id }) => id), ["c", "d"]);
  assert.equal(h.row("a"), undefined); assert.equal(h.row("b"), undefined);
  assert.ok(h.row("c")); assert.ok(h.row("d"));
  const recheck = h.page.model.recheck(); await flush();
  assert.deepEqual(h.analyses.at(-1).params.paths, [...entry("c").paths, ...entry("d").paths]);
  h.analyses.at(-1).resolve({ entries: [entry("c", "blocked"), entry("d", "installed")], skipped: 0 });
  await recheck; await h.page.settled(); assert.equal(h.page.model.state.checked.size, 0);
});

test("leaving during Recheck keeps completed entries removed when its old response arrives", async () => {
  const h = await fixture();
  await h.analyze([entry("a", "done"), entry("b"), entry("c", "blocked")]);
  const pending = h.page.model.recheck(); await flush();
  h.page.hide();
  await h.page.show(h.context, catalog); await h.page.settled();
  assert.deepEqual(h.page.model.state.entries.map(({ id }) => id), ["b", "c"]);
  h.analyses.at(-1).resolve({ entries: [entry("a", "installed"), entry("b", "update"), entry("c", "blocked")], skipped: 0 });
  await pending; await h.page.settled();
  assert.deepEqual(h.page.model.state.entries.map(({ id }) => id), ["b", "c"]);
  assert.equal(h.row("a"), undefined);
  assert.deepEqual([...h.page.model.state.checked], ["b"]);
  const retry = h.page.model.recheck(); await flush();
  assert.deepEqual(h.analyses.at(-1).params.paths, [...entry("b").paths, ...entry("c").paths]);
  h.analyses.at(-1).resolve({ entries: [entry("b"), entry("c", "blocked")], skipped: 0 });
  await retry;
  // Removal only retires the in-flight response; explicitly adding the same paths later is allowed.
  const adding = h.page.model.add(entry("a").paths); await flush();
  h.analyses.at(-1).resolve({ entries: [entry("a", "installed"), entry("b"), entry("c", "blocked")], skipped: 0 });
  await adding; await h.page.settled();
  assert.ok(h.row("a"));
});

test("the shared page hold reports both analysis and import progress through artwork completion", async () => {
  const h = await fixture(); const analyzing = h.page.drop(entry("a").paths); await flush();
  const hold = () => h.holds.findLast((hold) => hold.active);
  assert.equal(hold().opts.all, true); h.analyses[0].progress({ done: 3, total: 12 });
  assert.equal(hold().opts.progress(), "Analyzing 3 / 12");
  h.analyses[0].resolve({ entries: [entry("a")], skipped: 0 }); await analyzing; await h.page.settled(); await flush();
  h.answers.push({ button: "ok" }); await h.action("start").click(); await flush();
  h.runs[0].progress({ done: 0, index: 1, total: 2, current: "a", phase: "apply", step: "import.step.apply" });
  assert.equal(hold().opts.progress(), "Applying Mods Saved Alias (Portrait) 1 / 2");
  h.runs[0].reject({ code: "internal" }); await flush(); await h.page.settled(); await flush();
  assert.equal(hold(), undefined);
});

test("all six locales use short completion, merge and applied labels", () => {
  for (const lang of ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "th-TH"]) {
    const data = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url))).webui.import;
    for (const text of [data.state.done, data.merge, data.applied, data.notApplied]) assert.ok(text && !/[{}]/.test(text));
    assert.deepEqual([...data.waitProgress.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), ["label", "done", "total"]);
    if (lang === "zh-CN") { assert.equal(data.state.done, "\u5df2\u5b8c\u6210"); assert.equal(data.applied, "\u5df2\u5e94\u7528"); }
  }
});

test("re-entering recreates cancelled row stills and merged rows prefer an available rendered asset", async () => {
  const h = await fixture({ licensed: true });
  const model = { ...entry("a-model", "ready", "model"), variant: "a" }, portrait = entry("a");
  await h.analyze([model, portrait]);
  const merge = h.action("merge").querySelector("input"); merge.checked = true; await merge.dispatch("change"); await h.page.settled();
  assert.ok(h.row("a"));
  const count = h.thumbs.filter(([base, frame]) => base.includes("/import/source-a/") && frame === "card").length;
  h.page.hide(); await h.page.show(h.context, catalog); await h.page.settled();
  assert.ok(h.thumbs.filter(([base, frame]) => base.includes("/import/source-a/") && frame === "card").length > count);
  assert.match(h.row("a").querySelector(".import-thumb").dataset.source, /source-a/);
});


test("conversion is eligible, counted separately, and routes sit below aligned metadata", async () => {
  const h = await fixture();
  const converting = { ...entry("a", "convert"), source: { server: "japan", platform: "android" },
    target: { server: "global", platform: "windows" } };
  await h.analyze([converting, entry("b", "update")]);
  assert.deepEqual([...h.page.model.state.checked], ["a", "b"]);
  const tree = drawn(h, h.row("a")).tree, meta = find(tree, "Label_Locale_Received"), platform = find(tree, "Platform");
  assert.equal(platform.widgets[0].text, "Japan Android → Global PC");
  assert.equal(platform.pos[0], meta.pos[0]); assert.ok(platform.pos[1] < meta.pos[1]);
  const graphics = h.row("a").art.children;
  const platformBox = rectOf(graphics.find((element) => element.dataset.path === "List_01/Platform"));
  const kindBox = rectOf(graphics.find((element) => element.dataset.path === "List_01/Label_From"));
  assert.ok(platformBox[1] >= kindBox[1] + kindBox[3], "route follows the entire kind block");
  assert.ok(platformBox[0] + platformBox[2] <= drawn(h, h.row("a")).opts.origin[0] + 926 * .54, "route stays inside the row text area");
  const noteBox = rectOf(graphics.find((element) => element.dataset.path === "List_01/Label_Locale_Limit"));
  assert.ok(platformBox[1] + platformBox[3] < noteBox[1]);
  assert.ok(!find(tree, "Label_Locale_Limit").widgets[0].text || noteBox[1] + noteBox[3] <= parseFloat(h.row("a").style.height));
  assert.doesNotMatch(h.host.querySelector(".import-detail").textContent, /→/);
  assert.equal(h.action("source").disabled, false, "detected origins remain manually correctable");
  await h.action("filter").click(); await flush(); await h.page.settled();
  assert.match(h.dialog.textContent, /Pending Conversion \(1\)/); assert.match(h.dialog.textContent, /Pending Update \(1\)/);
});

for (const merged of [false, true]) test(`only conversions reserve a platform line in ${merged ? "merged" : "individual"} list and result rows`, async () => {
  const h = await fixture(), target = { server: "global", platform: "windows" };
  const same = { ...entry("a"), source: { ...target, detected: true }, target };
  const lobby = { ...entry("a-lobby", "update", "lobby"), variant: "a", source: { ...target }, target };
  const platform = { ...entry("b", "convert"), source: { ...target, platform: "android" }, target };
  const server = { ...entry("c", "convert"), source: { ...target, server: "japan" }, target };
  const blocked = { ...entry("d", "blocked"), source: { ...target }, target };
  await h.analyze([same, lobby, platform, server, blocked]);
  if (merged) {
    const merge = h.action("merge").querySelector("input"); merge.checked = true; await merge.dispatch("change"); await h.page.settled();
  }
  const check = (row, route) => {
    const { tree, opts } = drawn(h, row), platform = find(tree, "Platform"), note = find(tree, "Label_Locale_Limit");
    assert.doesNotMatch(row.textContent, /Global PC → Global PC/);
    if (route) assert.equal(platform.widgets[0].text, route);
    else {
      assert.equal(platform, undefined);
      assert.ok(row.art.children.every((element) => !element.dataset.path.endsWith("/Platform")));
      assert.equal(note.pos[0] + note.widgets[0].w_, 926, "the note can use the row text band");
    }
    assert.ok(note.pos[1] <= -36 && (20 - note.pos[1]) % 56 === 0, "notes follow the wrapped metadata and route");
    const graphic = row.art.children.find((element) => element.dataset.path.endsWith("/Label_Locale_Limit"));
    closeTo(rectOf(graphic)[1], opts.origin[1] - note.pos[1] * opts.scale);
  };
  check(h.row("a")); if (!merged) check(h.row("a-lobby")); check(h.row("d"));
  check(h.row("b"), "Global Android → Global PC"); check(h.row("c"), "Japan PC → Global PC");
  await h.action("start").click(); await flush();
  h.runs[0].resolve({ results: [same, lobby, platform, server].map((item) => ({ id: item.id, outcome: "imported", libraryId: `lib-${item.id}`, applied: true })) });
  await flush(); await h.page.results(); await h.page.settled();
  for (const row of walk(h.dialog).filter((element) => element.dataset.result)) {
    check(row, { b: "Global Android → Global PC", c: "Japan PC → Global PC" }[row.dataset.result]);
    assert.match(row.textContent, /Applied/);
  }
});

test("the page has no status widget during analysis, completion or picker failures", async () => {
  const h = await fixture();
  const picker = h.holdPicker(), picking = h.action("files").click(); await flush();
  assert.equal(h.phase(), "picking");
  assert.equal(h.holds.some((hold) => hold.active), false, "native selection has no wait overlay");
  assert.equal(h.host.querySelector(".import-progress"), null);
  picker.resolve({ paths: [] }); await picking; await flush();
  h.pickError({ code: "native_unavailable" }); await h.action("files").click(); await flush();
  assert.match(h.messages.at(-1).lines.join(" "), /Not available in browser mode/);
  assert.equal(h.host.querySelector(".import-progress"), null);
});

test("row metadata, kind, badge text and checkbox share a top edge and fixed font in all six locales", async () => {
  try {
    for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
      setStrings(locale, flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8"))));
      const h = await fixture(); await h.analyze();
      for (const id of ["a", "b", "c", "d", "e"]) {
        const row = h.row(id), { tree } = drawn(h, row), prefix = tree.name;
        const paths = ["Label_Locale_Received", "Label_From", "TimeLimit/Label_Locale_TimeLimit"];
        const labels = paths.map((path) => find(tree, path).widgets[0]);
        assert.ok(labels[0].fontSize === 42);
        assert.deepEqual(labels.map((w) => w.fontSize), Array(3).fill(labels[0].fontSize));
        const tops = paths.map((path) => rectOf(row.art.children.find((el) => el.dataset.path === `${prefix}/${path}`))[1]);
        tops.push(parseFloat(row.querySelector(".import-check").style.top));
        tops.slice(0, 2).forEach((top) => closeTo(top, tops[0]));
        assert.ok(tops.every((top) => top >= tops[0] - 1e-8));
        const divider = find(tree, "Line"), title = find(tree, "Label_System");
        assert.equal(divider.widgets[0].pivot, 3);
        assert.equal(divider.pos[0], title.pos[0]);
        closeTo(divider.pos[0] + divider.widgets[0].w_, 926);
      }
    }
  } finally { setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8")))); }
});

test("the entire white mail gradient stretches to the card edge without clipping off its fade", async () => {
  const h = await fixture();
  for (const name of ["List_01", "List_02"]) find(h.layouts.UIMailBoxContent, name).children.push({ name: "Sprite", active: true,
    pos: [-210, 0], scale: [1, 1], widgets: [{ texture: "Mail_White_Highlight", w_: 1324, h_: 329, pivot: 4, prefabMarker: true }], children: [] });
  await h.analyze();
  for (const id of ["a", "c"]) {
    const { tree } = drawn(h, h.row(id)), gradient = find(tree, "Sprite"), bg = find(tree, "BG");
    assert.equal(gradient.widgets[0].w_, bg.widgets[0].w_);
    assert.equal(gradient.pos[0], bg.pos[0]);
    assert.equal(gradient.widgets[0].texture, "Mail_White_Highlight");
  }
});

test("manual source selection is limited to unknown sources and conversion routes", async () => {
  const h = await fixture(), target = { server: "global", platform: "windows" };
  await h.analyze([{ ...entry("a"), source: target, target }, { ...entry("b"), target },
    { ...entry("c"), source: { ...target, platform: "android" }, target }, { ...entry("d"), source: { platform: "windows" }, target }]);
  assert.equal(h.action("source"), undefined);
  for (const id of ["b", "c", "d"]) { h.page.model.select(id); await h.page.settled(); assert.ok(h.action("source")); }
  h.page.model.select("a"); await h.page.settled(); assert.equal(h.action("source"), undefined);
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`long metadata and kinds wrap at the beta font size in list and result rows in ${locale}`, async () => {
  try {
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8"));
    setStrings(locale, flatten(strings));
    for (const merged of [false, true]) for (const countIcons of [false, true]) {
      const h = await fixture({ countIcons });
      const entries = [
        { ...entry("a"), core: "shiroko_swimsuit_very_long_variant_identifier_spr", size: 123456789 },
        { ...entry("a-lobby", "ready", "lobby"), variant: "a" },
        { ...entry("a-model", "ready", "model"), variant: "a" }, entry("b", "update", "lobby"),
      ];
      await h.analyze(entries);
      if (merged) {
        const toggle = h.action("merge").querySelector("input"); toggle.checked = true;
        await toggle.dispatch("change"); await h.page.settled();
      }
      const check = (rows, result = false) => {
        let shared;
        for (const row of rows) {
          const { tree } = drawn(h, row), meta = find(tree, "Label_Locale_Received").widgets[0];
          shared ??= meta.fontSize; assert.equal(meta.fontSize, shared, "all rows share a size");
          const paths = ["Label_Locale_Received", ...(find(tree, "Label_From").children.length
            ? find(tree, "Label_From").children.map((n) => `Label_From/${n.name}/Count`) : ["Label_From"]),
            ...(!result && !merged ? ["TimeLimit/Label_Locale_TimeLimit"] : [])];
          const boxes = [];
          for (const path of paths) {
            const w = find(tree, path).widgets[0];
            assert.equal(w.fontSize, shared); assert.equal(w.ellipsis, false);
            assert.doesNotMatch(w.text, /…/); assert.ok(String(w.text).split("\n").every((line) => line.length * w.fontSize <= w.w_ + 0.01), path);
            boxes.push(rectOf(row.art.children.find((el) => el.dataset.path === `${tree.name}/${path}`)));
          }
          for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i - 1][0] + boxes[i - 1][2] <= boxes[i][0] || boxes[i - 1][1] + boxes[i - 1][3] <= boxes[i][1], "text cells do not overlap");
          const boundary = result ? parseFloat(h.action("go", row).style.left) : parseFloat(row.querySelector(".import-check").style.left);
          assert.ok(boxes.at(-1)[0] + boxes.at(-1)[2] < boundary, "text clears the action control");
        }
      };
      const rows = walk(h.host).filter((el) => el.dataset.entry); check(rows);
      if (!merged) {
        const expected = strings.webui.import.metaOne.replace("{id}", entries[0].core).replace("{n}", "1").replace("{size}", "117.7 MB");
        assert.equal(find(drawn(h, h.row("a")).tree, "Label_Locale_Received").widgets[0].text.replace(/\n/g, ""), expected);
      }
      await h.action("start").click(); await flush();
      h.runs[0].resolve({ results: entries.map(({ id }) => ({ id, outcome: "imported", libraryId: `lib-${id}` })) });
      await flush(); await h.page.results(); await h.page.settled();
      check(walk(h.dialog).filter((el) => el.dataset.result), true);
    }
  } finally { setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))))); }
});

test("import identities and search keep aliases on the selected skin", () => {
  const data = { families: [{ key: "base", variants: [
    { key: "base", custom: ["Original nickname"], names: { en: { full: "Original" } } },
    { key: "skin", custom: ["Skin nickname", "Search skin"], names: { en: { full: "Maid" } } },
    { key: "other", names: { en: { full: "Swimsuit" } } },
  ] }] };
  const catalog = catalogEntries(data), identity = (variant) => entryIdentity({ variant }, catalog);
  assert.equal(identity("skin").name, "Skin nickname"); assert.match(identity("skin").search, /search skin/);
  assert.equal(identity("base").name, "Original nickname"); assert.doesNotMatch(identity("base").search, /skin nickname|search skin/);
  assert.equal(identity("other").name, "Swimsuit"); assert.doesNotMatch(identity("other").search, /nickname/);
});

test("portrait comparisons are vertical side by side; lobbies are landscape with current above incoming", async () => {
  for (const kind of ["spr", "lobby"]) {
    const h = await fixture({ licensed: true }); await h.analyze([entry("a", "ready", kind)]);
    const column = h.host.querySelector(".import-detail"), boxes = h.host.querySelectorAll(".import-preview");
    const images = boxes.map((box) => box.querySelector(".import-preview-image"));
    const bounds = boxes.map(rectOf), pictures = images.map(rectOf);
    assert.match(boxes[0].textContent, /Current Game/); assert.match(boxes[1].textContent, /Incoming Mod/);
    if (kind === "spr") {
      assert.ok(bounds[0][0] + bounds[0][2] < bounds[1][0]); closeTo(bounds[0][1], bounds[1][1]);
      assert.ok(pictures.every(([, , w, h]) => h > w));
    } else {
      assert.ok(bounds[0][1] + bounds[0][3] < bounds[1][1]); closeTo(bounds[0][0], bounds[1][0]);
      assert.ok(pictures.every(([, , w, h]) => w > h));
    }
    const banner = rectOf(h.host.querySelector(".import-name-banner"));
    for (let i = 0; i < 2; i++) {
      const [x, y, w, hgt] = bounds[i];
      assert.ok(x >= 0 && x + w <= parseFloat(column.style.width));
      assert.ok(y + hgt <= banner[1]);
      const tag = boxes[i].art.children.find((el) => el.dataset.path === "EquipPos/Text_Type/TypeBG");
      assert.ok(rectOf(tag)[1] + rectOf(tag)[3] <= pictures[i][1] + 0.01, "caption stays with its picture");
    }
    assert.ok(parseFloat(column.style.top) + parseFloat(column.style.height) < 861.5, "the comparison stays above the footer");
  }
});


test("list and result pictures follow the same small rounded frame contour in every selection state", async () => {
  const h = await fixture({ licensed: true });
  const frame = find(h.layouts.UINonEquipmentInventoryListItem, "Card/Normal/Cover_Select");
  Object.assign(frame.widgets[0], { w_: 246, h_: 228, incline: 12, radius: 27 });
  await h.analyze([entry("a"), entry("b"), entry("c", "installed")]);
  const expected = selectionWindow({ ...frame, pos: [0, 0] }, { Common: { Card_Select_Line: FRAME_META } }, frameOutline(framePixels()));
  const check = (row) => {
    const { tree, opts } = drawn(h, row), slot = find(tree, "BG_Icon/Icon_Arona").widgets[0];
    const picture = row.querySelector(".import-thumb"), [x, y, w, height] = rectOf(picture);
    closeTo(w, expected.width * opts.scale);
    closeTo(height, expected.height * opts.scale);
    assert.ok(w < 246 * ROW_SELECTION.scale * opts.scale / ROW_SCALE);
    assert.ok(height < 228 * ROW_SELECTION.scale * opts.scale / ROW_SCALE);
    assert.ok(picture.style.clipPath.startsWith("polygon(") && picture.style.clipPath.split(",").length > 4);
    closeTo(x + w / 2, opts.origin[0] + expected.x * opts.scale);
    closeTo(y + height / 2, opts.origin[1] - expected.y * opts.scale);
    assert.equal(slot.incline, 12); assert.equal(slot.radius, 0, "the measured polygon supplies the frame rounding");
    assert.ok(slot.clipPolygon.length > 4);
    closeTo(parseFloat(picture.style.borderRadius), slot.radius * opts.scale);
    assert.equal(picture.style.transform, "skewX(-12deg)");
    assert.equal(picture.firstElementChild.style.transform, "skewX(12deg)", "the subject remains upright");
    assert.equal(picture.firstElementChild.style.backgroundSize, "cover");
    assert.equal(picture.firstElementChild.style.backgroundPosition, "center");
    const bleed = Math.tan(12 * Math.PI / 180) * height / w * 100;
    closeTo(parseFloat(slot.imgWidth), 100 + bleed); closeTo(parseFloat(slot.imgLeft), -bleed / 2);
    return [w, height, slot.incline, slot.radius];
  };
  assert.deepEqual(check(h.row("a")), check(h.row("b")));
  assert.deepEqual(check(h.row("a")), check(h.row("c")));
  assert.equal(h.row("b").querySelector(".import-selection").hidden, true);
  for (const selected of ["b", "a"]) {
    h.page.model.select(selected); await h.page.settled();
    assert.equal(h.row(selected).querySelector(".import-selection").hidden, false);
    assert.equal(h.row(selected === "a" ? "b" : "a").querySelector(".import-selection").hidden, true);
    assert.deepEqual(check(h.row("a")), check(h.row("b")), "selection only changes the frame's visibility");
  }
  await h.action("start").click(); await flush();
  h.runs[0].resolve({ results: ["a", "b"].map((id) => ({ id, outcome: "imported", libraryId: `lib-${id}` })) });
  await flush(); await h.page.results(); await h.page.settled();
  for (const row of walk(h.dialog).filter((el) => el.dataset.result)) check(row);
});

test("atlas slice cuts never become the thumbnail corner radius", () => {
  const frame = { name: "Frame", active: true, pos: [0, 0], scale: [1, 1], widgets: [{ sprite: "Frame", atlas: "Items", w_: 240, h_: 220, incline: 9 }], children: [] };
  const win = selectionWindow(frame, { Items: { Frame: FRAME_META } }, frameOutline(framePixels()));
  assert.equal(win.radius, 0); assert.equal(win.incline, 9);
  assert.ok(win.clipPolygon.length > 4);
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`merged and result row kinds share the metadata font and top line in ${locale}`, async () => {
  try {
    setStrings(locale, flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8"))));
    for (const merged of [false, true]) for (const countIcons of [false, true]) {
      const h = await fixture({ countIcons });
      const entries = [entry("a"), { ...entry("a-lobby", "ready", "lobby"), variant: "a" },
        { ...entry("a-model", "ready", "model"), variant: "a" }];
      await h.analyze(entries);
      if (merged) {
        const merge = h.action("merge").querySelector("input"); merge.checked = true;
        await merge.dispatch("change"); await h.page.settled();
      }
      const check = (row, result = false) => {
        const { tree } = drawn(h, row), sender = find(tree, "Label_From");
        const kinds = sender.children.length ? sender.children.map((kind) => `Label_From/${kind.name}/Count`) : ["Label_From"];
        const paths = ["Label_Locale_Received", ...kinds, ...(result || merged) ? [] : ["TimeLimit/Label_Locale_TimeLimit"]];
        for (const path of paths) assert.equal(find(tree, path).widgets[0].fontSize, find(tree, paths[0]).widgets[0].fontSize, path);
        const tops = paths.map((path) => rectOf(row.art.children.find((el) => el.dataset.path === `${tree.name}/${path}`))[1]);
        if (!result) tops.push(parseFloat(row.querySelector(".import-check").style.top));
        tops.slice(0, 2).forEach((top) => closeTo(top, tops[0]));
        assert.ok(tops.every((top) => top >= tops[0] - 1e-8));
      };
      for (const row of walk(h.host).filter((el) => el.dataset.entry)) check(row);
      await h.action("start").click(); await flush();
      h.runs[0].resolve({ results: entries.map(({ id }) => ({ id, outcome: "imported", libraryId: `lib-${id}` })) });
      await flush(); await h.page.results(); await h.page.settled();
      const rows = walk(h.dialog).filter((el) => el.dataset.result);
      assert.equal(rows.length, merged ? 1 : 3);
      rows.forEach((row) => check(row, true));
    }
  } finally { setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8")))); }
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`owner review: source badge and result paragraphs fit in ${locale}`, async () => {
  try {
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)));
    setStrings(locale, flatten(strings));
    const h = await fixture();
    await h.analyze([{ ...entry("a", "blocked"), source: null, target: { server: "global", platform: "windows" }, reason: "source_unknown" }]);
    const badge = find(drawn(h, h.row("a")).tree, "TimeLimit/Label_Locale_TimeLimit").widgets[0];
    assert.equal(badge.text, strings.webui.import.reason.source_unknown);
    assert.ok(badge.text.length * badge.fontSize <= badge.w_);
    assert.ok(h.action("source"));
    await h.action("source").click(); await h.page.settled();
    const titles = walk(h.dialog).filter((el) => el.style.height === "60px");
    assert.equal(titles.length, 2);
    assert.ok(titles.every((el) => el.style.position === "relative"), "each prefab label anchors to its own title row");
    h.page.hide();
    const ready = await fixture();
    const mobile = { ...entry("mobile", "convert", "lobby"), source: { server: "global", platform: "android" }, target: { server: "global", platform: "windows" } };
    await ready.analyze([mobile, entry("same")]);
    await ready.action("start").click(); await flush();
    ready.runs[0].resolve({ results: ["mobile", "same"].map((id) => ({ id, outcome: "updated", libraryId: id, applied: true })) });
    await flush(); await ready.page.results(); await ready.page.settled();
    for (const row of walk(ready.dialog).filter((el) => el.dataset.result)) {
      const { tree } = drawn(ready, row), paths = ["Label_Locale_Received", ...(find(tree, "Platform") ? ["Platform"] : []), "Label_Locale_Limit"];
      const list = drawn(ready, ready.row(row.dataset.result)), resultDraw = drawn(ready, row);
      assert.equal(find(list.tree, "Label_Locale_Received").widgets[0].fontSize, 42);
      assert.equal(find(tree, "Label_Locale_Received").widgets[0].fontSize, 42);
      const labels = paths.map((p) => find(tree, p));
      const fs = labels[0].widgets[0].fontSize;
      for (const [i, n] of labels.entries()) {
        const w = n.widgets[0]; assert.equal(w.fontSize, fs); assert.equal(w.pivot, 0);
        assert.ok(n.pos[1] - w.h_ >= -329 / 2 - (tree.rowHeight - 348) + 12, "text and descenders clear the card bottom");
        if (i) assert.ok(labels[i - 1].pos[1] - n.pos[1] >= 56 && (labels[i - 1].pos[1] - n.pos[1]) % 56 === 0);
      }
    }
  } finally { setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))))); }
});

test("source popup title labels occupy distinct prefab rows", async () => {
  const h = await fixture();
  await h.analyze([{ ...entry("a", "blocked"), source: null, reason: "source_unknown", target: { server: "global", platform: "windows" } }]);
  await h.action("source").click(); await h.page.settled();
  const titles = walk(h.dialog).filter((el) => el.style.height === "60px");
  assert.equal(titles.length, 2);
  const bounds = titles.map((title) => {
    const [, y, , height] = rectOf(title.art.children[0]);
    const siblings = title.parentNode.children, index = siblings.indexOf(title);
    const offset = title.style.position === "relative"
      ? siblings.slice(0, index).reduce((sum, el) => sum + (parseFloat(el.style.height) || 0), 0) : 0;
    return { top: offset + y, bottom: offset + y + height };
  });
  assert.ok(bounds[0].bottom + 24 <= bounds[1].top, "Source Server and Source Platform never share a label canvas");
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`result paragraphs use even spacing and clear the footer in ${locale}`, async () => {
  try {
    setStrings(locale, flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)))));
    const h = await fixture();
    await h.analyze([{ ...entry("a", "convert", "lobby"), source: { server: "global", platform: "android" }, target: { server: "global", platform: "windows" } }, entry("b")]);
    await h.action("start").click(); await flush();
    h.runs[0].resolve({ results: ["a", "b"].map((id) => ({ id, outcome: "updated", libraryId: id, applied: true })) });
    await flush(); await h.page.results(); await h.page.settled();
    for (const row of walk(h.dialog).filter((el) => el.dataset.result)) {
      const { tree } = drawn(h, row);
      const paragraphs = [find(tree, "Label_Locale_Received"), find(tree, "Platform"), find(tree, "Label_Locale_Limit")].filter(Boolean);
      for (const [i, n] of paragraphs.entries()) {
        const w = n.widgets[0]; assert.equal(w.fontSize, paragraphs[0].widgets[0].fontSize);
        assert.equal(w.pivot, 0); assert.ok(n.pos[1] - w.h_ >= -329 / 2 - (tree.rowHeight - 348) + 12);
        if (i) assert.ok(paragraphs[i - 1].pos[1] - n.pos[1] >= 56 && (paragraphs[i - 1].pos[1] - n.pos[1]) % 56 === 0);
      }
    }
  } finally { setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))))); }
});


test("nested selection widgets retain their derived picture position and draw above its edges", async () => {
  const h = await fixture({ licensed: true });
  const frame = find(h.layouts.UINonEquipmentInventoryListItem, "Card/Normal/Cover_Select"), w = frame.widgets[0];
  frame.widgets = []; frame.children = [{ name: "Border", active: true, pos: [6, -3], scale: [.8, 1.2],
    widgets: [{ ...w, pivot: 1, incline: 13 }], children: [] }];
  await h.analyze([entry("a"), entry("b")]);
  const expected = selectionWindow({ ...frame, pos: [0, 0] }, { Common: { Card_Select_Line: FRAME_META } }, frameOutline(framePixels()));
  for (const id of ["a", "b"]) {
    const row = h.row(id), { opts } = drawn(h, row);
    const [x, y, width, height] = rectOf(row.querySelector(".import-thumb"));
    closeTo(x + width / 2, opts.origin[0] + expected.x * opts.scale);
    closeTo(y + height / 2, opts.origin[1] - expected.y * opts.scale);
  }
  const css = readFileSync(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  const z = (name) => Number(new RegExp(`\\.${name} \\{[^}]*z-index: ([0-9]+)`).exec(css)?.[1]);
  assert.ok(z("import-selection") > z("import-art"), "the game frame covers the picture's border");
});

test("visible ready, conversion, unknown and failed rows keep the beta type-size floor", async () => {
  for (const state of ["ready", "convert", "blocked"]) {
    const h = await fixture();
    const item = { ...entry("a", state), ...(state === "blocked" ? { reason: "source_unknown", source: null, target: { server: "global", platform: "windows" } } : {}) };
    await h.analyze([item]);
    assert.equal(find(drawn(h, h.row("a")).tree, "Label_Locale_Received").widgets[0].fontSize, 42);
  }
  const h = await fixture();
  await h.analyze([{ ...entry("a"), paths: ["/fixtures/" + "long-folder/".repeat(80) + "mod.bundle"] }]);
  await h.action("start").click(); await flush();
  h.runs[0].resolve({ results: [{ id: "a", outcome: "failed", reason: "library_io_error" }] });
  await flush(); await h.page.results(); await h.page.settled();
  const row = walk(h.dialog).find((el) => el.dataset.result), { tree } = drawn(h, row);
  assert.equal(find(tree, "Label_Locale_Received").widgets[0].fontSize, 42);
  assert.equal(find(tree, "Label_Locale_Limit").widgets[0].ellipsis, true);
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) for (const [reason, params, expected] of [
  ["dev_path_outside", { path: "/profile/library/staging/import-abc/output/mod.bundle" }, "/profile/library/staging/import-abc/output/mod.bundle"],
  ["mod_parts_missing", { files: "first.bundle, second.bundle" }, "first.bundle, second.bundle"],
]) test(`result notes preserve all parameters for ${reason} in ${locale}`, async () => {
  try {
    setStrings(locale, flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8"))));
    const h = await fixture(); await h.analyze([entry("a")]);
    await h.action("start").click(); await flush();
    h.runs[0].resolve({ results: [{ id: "a", outcome: "failed", reason, params }] });
    await flush(); await h.page.results(); await h.page.settled();
    const row = walk(h.dialog).find((el) => el.dataset.result), { tree } = drawn(h, row);
    assert.ok(find(tree, "Label_Locale_Limit").widgets[0].text.includes(expected));
  } finally {
    setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));
  }
});

test("blocked entry notes preserve error parameters", async () => {
  const h = await fixture(), path = "/profile/input/refused.bundle";
  await h.analyze([{ ...entry("a", "blocked"), reason: "dev_path_outside", params: { path } }]);
  assert.ok(find(drawn(h, h.row("a")).tree, "Label_Locale_Limit").widgets[0].text.includes(path));
});

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`merged unknown-source states keep the manual-identification wording in ${locale}`, async () => {
  try {
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)));
    setStrings(locale, flatten(strings));
    const h = await fixture();
    await h.analyze([entry("a"), { ...entry("a-lobby", "blocked", "lobby"), variant: "a", source: null, reason: "source_unknown" }]);
    const merge = h.action("merge").querySelector("input");
    merge.checked = true; await merge.dispatch("change"); await h.page.settled();
    const row = h.row("a");
    assert.ok(row.textContent.replace(/\s/g, "").includes(strings.webui.import.reason.source_unknown.replace(/\s/g, "")));
    assert.ok(!row.textContent.includes(strings.webui.import.state.blocked));
  } finally { setStrings("en-US", flatten(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))))); }
});
