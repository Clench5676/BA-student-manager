// The shipped page on a stand-in DOM, game renderer and the shared import RPC contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() { document.activeElement = this; }
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
  reason: state === "blocked" ? "no_target" : null, libraryId: state === "library" ? "lib-known" : null });
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
  const ui = { node, sprite: (sprite, w_, h_, opts) => ({ sprite, w_, h_, ...opts }),
    fitText: (text, fs) => ({ text, fs }), init: async () => {}, layout: async () => node("Collection", [0, 0], [], [node("BG")]),
    find: (tree, path) => path === "BG" ? tree.children[0] : null,
    render: async () => ({ nodes: new Map() }), decoded: async () => {},
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
    const adding = page.drop(paths); await flush(); analyses.at(-1).resolve({ entries, skipped: 0 }); await adding; await flush(); return adding;
  };
  return { page, context, host, dialog, calls, analyses, runs, messages, answers, thumbs, scopes, popupStack, action, row, phase, analyze,
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
  h.analyses[0].resolve({ entries: mixed(), skipped: 3 }); await pending;
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
  const filter = h.host.querySelector("select"); assert.match(filter.textContent, /Already in Library \(1\)/);
  filter.value = "blocked"; await filter.dispatch("change"); assert.ok(!h.row("b"));
  search.value = ""; await search.dispatch("input"); assert.ok(h.row("e"));
  filter.value = "all"; await filter.dispatch("change");
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
  h.runs[0].progress({ done: 1, total: 2, current: "b", phase: "update" });
  assert.match(h.host.textContent, /Updating - 1\/2 Student b/);
  assert.equal(h.host.querySelector("progress").value, 1);
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
  h.analyses[0].reject({ code: "game_running" }); await adding;
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

test("licensed previews use current game sources, library IDs and lazy thumbnails; incoming files never impersonate game art", async () => {
  const h = await fixture({ licensed: true }); await h.analyze();
  assert.ok(h.thumbs.some(([base]) => base.includes("/spr/a_spr/")));
  assert.match(h.host.textContent, /Preview Unavailable/);
  for (const observer of observers) observer.reveal(); await flush();
  assert.ok(h.thumbs.some(([base, frame]) => base.includes("/lobby/b_home/") && frame === "card"));
  h.page.model.select("c"); await flush();
  assert.ok(h.thumbs.some(([base]) => base.includes("/mod/lib-known/")));
  assert.ok(!h.thumbs.some(([base]) => base.includes("/import/")), "no invented incoming preview endpoint");
});

test("DOM drops forward native paths and browser-only drops explain native availability", async () => {
  const h = await fixture({ native: false });
  await h.host.children[0].dispatch("drop", { dataTransfer: { files: [{ name: "a.bundle" }] } });
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
  h.analyses[0].resolve({ entries: [entry("a")], skipped: 0 }); await pending;
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
