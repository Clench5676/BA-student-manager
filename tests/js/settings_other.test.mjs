import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const web = new URL("../../src/ba_modding_toolkit/web/js/", import.meta.url);
const source = readFileSync(new URL("settings-other.js", web), "utf8");
const settings = readFileSync(new URL("settings.js", web), "utf8");
const strip = (s) => s.replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
function harness({ locale = "en-US", answer = "ok", used = true, error = null, result = {} } = {}) {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
  const T = (key, values = {}) => key.split(".").reduce((v, k) => v[k], strings).replace(/\{(\w+)\}/g, (_, k) => values[k]);
  const calls = [], messages = [], refused = [];
  let changed = 0;
  const deps = { T, Loading: { task: (fn) => fn(() => {}) },
    ModSwitch: { refresh: async () => {}, refused: (...args) => refused.push(args) },
    Popup: { message: async (opts) => { messages.push(opts); return { button: answer }; } },
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (error) throw error;
      return method === "mods.removalInfo" ? { name: "UI Pack", used } : "job1";
    }, waitJob: async (id) => { assert.equal(id, "job1"); return result; }, toast: (s) => calls.push(["toast", s]),
  };
  const api = new Function("deps", `const {${Object.keys(deps)}} = deps; ${strip(source)}; return { rows, select, remove };`)(deps);
  return { ...api, T, calls, messages, refused, changed: () => { changed++; }, changes: () => changed };
}
const mod = { id: "m1", label: "UI Pack", target: "other-set:ui", files: ["ui-textures.bundle", "music-audio.bundle"], state: "official", selected: false };

test("Settings switches generic Mods through the shared apply and restore jobs", async () => {
  const h = harness();
  await h.select(mod, h.changed, true);
  await h.select({ ...mod, selected: true }, h.changed, false);
  assert.deepEqual(h.calls, [
    ["actions.apply", { variant: mod.target, kind: "other", source: "mod:m1" }],
    ["actions.restore", { variant: mod.target, kind: "other" }],
  ]);
  assert.equal(h.changes(), 2);
});

test("Settings deletion reuses the named confirmation in all six locales", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
    const h = harness({ locale });
    await h.remove(mod, h.changed);
    assert.deepEqual(h.messages[0].lines, [h.T("mods.deleteConfirm", { name: "UI Pack" }), h.T("mods.deleteRestore")]);
    assert.deepEqual(h.calls, [["mods.removalInfo", { id: "m1" }], ["mods.remove", { id: "m1", confirm: true }]]);
    assert.equal(h.changes(), 1);
  }
});

test("cancel, close and failed lookups cannot delete; unused sources omit the restore fragment", async () => {
  for (const answer of ["cancel", null]) {
    const h = harness({ answer, used: false });
    await h.remove(mod, h.changed);
    assert.deepEqual(h.messages[0].lines, [h.T("mods.deleteConfirm", { name: "UI Pack" })]);
    assert.equal(h.calls.length, 1);
  }
  const error = { code: "library_io_error" }, h = harness({ error });
  await h.remove(mod, h.changed);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.refused, [[error]]);
});

test("refused writes keep the list and expose the shared refusal flow", async () => {
  const error = { code: "classic_open" }, h = harness({ error });
  await h.select(mod, h.changed);
  assert.equal(h.changes(), 0);
  assert.deepEqual(h.refused, [[error, "actions.apply", { variant: mod.target, kind: "other", source: "mod:m1" }]]);
});

class El {
  children = []; attrs = {}; style = {}; dataset = {};
  appendChild(el) { this.children.push(el); return el; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  remove() {}
  getContext() { return { measureText: (s) => ({ width: s.length * 20 }) }; }
}

test("generic Settings rows render names, every target file, status and actions in a stand-in DOM", async (t) => {
  const original = globalThis.document;
  globalThis.document = { documentElement: new El(), createElement: () => new El() };
  t.mock.method(globalThis, "fetch", async (url) => ({ ok: true, json: async () => url.endsWith("atlases.json")
    ? { Common: { Test: { width: 1, height: 1 } } } : {} }));
  try {
    const NGUI = await import(new URL("ngui.js", web));
    const { wrapPath } = await import(new URL("util.js", web));
    const h = harness();
    const deps = { NGUI, T: h.T, wrapPath };
    const valueRow = new Function("deps", `const {${Object.keys(deps)}} = deps; ${strip(settings)}; return valueRow;`)(deps);
    const rows = h.rows([mod, { ...mod, id: "m2", label: "Missing Pack", state: "missing" }], valueRow, h.changed);
    const host = new El();
    const tree = NGUI.node("Rows", [0, 0], [], rows.map((r) => r.tree));
    const labelsOnly = (n) => ({ ...n, widgets: n.widgets.filter((w) => "text" in w), children: n.children.map(labelsOnly) });
    await NGUI.render(labelsOnly(tree), host);
    const texts = host.children.flatMap((el) => [el.textContent || "", ...el.children.map((span) => span.textContent || "")]);
    const text = texts.join(" ").replace(/\n/g, "");
    for (const caption of [mod.label, ...mod.files, h.T("settings.mods.otherState.official"), h.T("settings.mods.useMod"), h.T("settings.mods.official"), h.T("btn.delete")]) assert.ok(text.includes(caption), caption);
    assert.equal(rows[0].hits.length, 3);
    assert.equal(rows[1].hits.length, 1);
    assert.ok(rows[0].h > 240);
    await rows[0].hits[0].fn();
    assert.equal(h.calls[0][0], "actions.apply");
    assert.doesNotMatch(source, /tooltip|setAttribute\(["']title/);
  } finally { globalThis.document = original; }
});
