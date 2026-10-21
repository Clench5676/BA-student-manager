import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

class El {
  children = []; attrs = {}; style = {}; dataset = {};
  appendChild(el) { this.children.push(el); return el; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  getContext() { return { measureText: () => ({ width: 100 }) }; }
}

test("hit targets and NGUI labels retain accessible names without hover titles or hover interception", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => ({ ok: true, json: async () => url.endsWith("atlases.json")
    ? { Common: { Test: { width: 1, height: 1 } } } : {} }));
  const original = globalThis.document;
  globalThis.document = { createElement: () => new El(), documentElement: { lang: "en-US" } };
  try {
    const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
    const { hitButton } = await import("../../src/ba_modding_toolkit/web/js/util.js");
    const host = new El();
    const button = hitButton(host, [0, 0, 10, 10], () => {}, "Open Details");
    assert.equal(button.attrs["aria-label"], "Open Details");
    assert.equal(button.title, undefined);
    assert.equal(button.attrs.title, undefined);
    await NGUI.render(NGUI.node("Value", [0, 0], [NGUI.label("Long value", 40, "#ffffff/1.00", 100, 50,
      { title: "Legacy hover metadata", ariaLabel: "Complete value", ellipsis: true, effect: 3, effectColor: "#ffffff/1.00", effectDistance: [3, 3] })]), host);
    const label = host.children[1];
    assert.equal(label.attrs["aria-label"], "Complete value");
    assert.equal(label.title, undefined);
    assert.equal(label.attrs.title, undefined);
    assert.equal(label.style.pointerEvents, "none");
    assert.equal(label.children[0].textContent, "Long value");
    const canvas = label.children[0], pads = String(canvas.style.padding || "").split(" ").map(parseFloat);
    const scale = 1920 / 2960, fs = NGUI.fontSizeFor("Long value", 40) * scale;
    const required = (1.45 - 1.15) * fs / 2 + 3 * scale;
    assert.ok(pads[0] >= required - 1e-8 && pads[2] >= required - 1e-8,
      "the actual ellipsis canvas must include descenders and the prefab outline");
    assert.equal(parseFloat(canvas.style.marginTop), -pads[0]);
    assert.equal(parseFloat(canvas.style.marginBottom), -pads[2]);
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

test("NGUI renders row thumbnails with four sharp clip corners and an upright cover image", async (t) => {
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ Common: { Test: { width: 1, height: 1 } } }) }));
  const previous = globalThis.document;
  globalThis.document = { createElement: () => new El(), documentElement: { lang: "en-US" } };
  try {
    const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
    const { frameOutline, innerFrame } = await import("../../src/ba_modding_toolkit/web/js/row-thumbnail.js");
    const { framePixels, FRAME_META } = await import("./import_prefabs.mjs");
    const window = innerFrame({ w_: 240, h_: 220, type: 1, incline: 10, pivot: 4 }, FRAME_META, frameOutline(framePixels()), { scale: .68 });
    const bleed = Math.tan(window.incline * Math.PI / 180) * window.height / window.width * 100;
    const host = new El();
    await NGUI.render(NGUI.node("RowPicture", [window.x, window.y], [{ texture: "fixture", clipImage: null,
      w_: window.width, h_: window.height, pivot: 4, incline: window.incline, radius: window.radius,
      clipPolygon: window.clipPolygon, imgSize: "cover", imgPosition: "center", imgLeft: `${-bleed / 2}%`, imgWidth: `${100 + bleed}%` }]), host);
    const clip = host.children[0], image = clip.children[0];
    assert.equal(clip.style.borderRadius, "0.0px");
    assert.equal(clip.style.clipPath, "polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)");
    assert.equal(clip.style.transform, "skewX(-10deg)");
    assert.equal(image.style.transform, "skewX(10deg)");
    assert.equal(image.style.backgroundSize, "cover"); assert.equal(image.style.backgroundPosition, "center");
  } finally { globalThis.document = previous; }
});
