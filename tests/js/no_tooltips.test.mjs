import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

class El {
  children = []; attrs = {}; style = {}; dataset = {};
  appendChild(el) { this.children.push(el); return el; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  getContext() { return {}; }
}

test("hit targets and NGUI labels retain accessible names without hover titles or hover interception", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({ ok: true, json: async () => url.endsWith("atlases.json")
    ? { Common: { Test: { width: 1, height: 1 } } } : {} }));
  const original = globalThis.document;
  globalThis.document = { createElement: () => new El() };
  try {
    const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
    const { hitButton } = await import("../../src/ba_modding_toolkit/web/js/util.js");
    const host = new El();
    const button = hitButton(host, [0, 0, 10, 10], () => {}, "Open Details");
    assert.equal(button.attrs["aria-label"], "Open Details");
    assert.equal(button.title, undefined);
    assert.equal(button.attrs.title, undefined);
    await NGUI.render(NGUI.node("Value", [0, 0], [NGUI.label("Long value", 40, "#ffffff/1.00", 100, 50,
      { title: "Legacy hover metadata", ariaLabel: "Complete value", ellipsis: true })]), host);
    const label = host.children[1];
    assert.equal(label.attrs["aria-label"], "Complete value");
    assert.equal(label.title, undefined);
    assert.equal(label.attrs.title, undefined);
    assert.equal(label.style.pointerEvents, "none");
    assert.equal(label.children[0].textContent, "Long value");
  } finally { globalThis.document = original; }
});

test("web UI sources cannot reintroduce native or custom tooltip attributes", () => {
  const web = new URL("../../src/ba_modding_toolkit/web/", import.meta.url);
  for (const name of readdirSync(new URL("js/", web)).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(new URL(`js/${name}`, web), "utf8").replace(/\bdocument\.title\s*=/g, "");
    assert.doesNotMatch(source, /\.title\s*=(?!=)|\[\s*["']title["']\s*\]\s*=|\bsetAttribute\s*\(\s*["']title["']/, name);
    assert.doesNotMatch(source, /data-tooltip|data-tip\b|role=["']tooltip/, name);
  }
  assert.doesNotMatch(readFileSync(new URL("index.html", web), "utf8"), /\stitle\s*=|data-tooltip|role=["']tooltip/i);
});
