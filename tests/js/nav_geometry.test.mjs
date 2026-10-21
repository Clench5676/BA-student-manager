import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { insert, n, spr } from "./control_prefabs.mjs";

class El {
  children = []; style = {}; dataset = {}; attrs = {};
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; }
  get childNodes() { return this.children; }
  addEventListener() {}
  setAttribute(key, value) { this.attrs[key] = value; }
  querySelectorAll() { return this.children.flatMap((child) => [child, ...child.querySelectorAll()]); }
  getContext() { return { font: "", measureText(text) {
    const fs = parseFloat(/([\d.]+)px/.exec(this.font)?.[1] || 16);
    return { width: [...text].reduce((sum, c) => sum + fs * (/[\u2e80-\u9fff\uac00-\ud7af]/.test(c) ? 1 : 0.6), 0) };
  }, drawImage() {}, fillRect() {} }; }
  toBlob(fn) { const blob = new Blob(); blob.width = this.width; blob.height = this.height; fn(blob); }
}
const host = new El(), plate = new El();
globalThis.document = { createElement: () => new El(), documentElement: { lang: "en-US" },
  getElementById: (id) => id === "nav" ? host : null, querySelector: (s) => s === ".nav-bar" ? plate : null };
globalThis.addEventListener = () => {};
const blobs = new Map();
URL.createObjectURL = (blob) => { const url = `blob:${blobs.size}`; blobs.set(url, blob); return url; };
const { ITEMS } = await import("../../src/ba_modding_toolkit/web/js/nav-items.js");
const meta = Object.fromEntries(ITEMS.map((item, i) => [item.icon, { width: 1100 + i * 130, height: 1400 - i * 120 }]));
globalThis.Image = class {
  set src(url) {
    const image = blobs.get(url) || meta[url.split("/").at(-1).replace(/\.png$/, "")];
    assert.ok(image, url); this.naturalWidth = image.width; this.naturalHeight = image.height;
    queueMicrotask(() => this.onload?.());
  }
};
const lobby = n("UILobby"), collection = n("UICharacterCollection");
insert(lobby, "Front/Bottom/Menu/BG/BG", n("BG"));
insert(lobby, "Front/Bottom/Menu/BG/Grid", n("Grid", [0, 0], [], ITEMS.map((item, i) => {
  const entry = n(`Entry${i}`, [i * 200, 0], [], [
    n("Label", [5, 8 + i * 2], [{ text: "Label", fontSize: 39, w_: 200, h_: 40, pivot: 4, color: "#2c4564/1.00" }],
      [n("IconPlus", [77, 9], [spr("Common_Icon_Minus", 20, 22)])]),
    n("Able", [0, 94 + i], [spr(item.icon, 108 + i * 30, 130 + i * 20)]),
    n("Disable", [0, 0], [], [n("Icon", [0, 94 + i], [spr(item.icon, 108 + i * 30, 130 + i * 20)]), n("Lock")]),
  ]);
  entry.scale = [1 + i * 0.1, 1]; return entry;
})));
insert(collection, "SeletControl/Top/BG_W/Bg/Btn", n("Btn"));
insert(collection, "NUITop_Scenes/Top/Right/Option", n("Option"));
globalThis.fetch = async (url) => ({ ok: true, json: async () => {
  if (url.endsWith("atlases.json")) return { Common: meta };
  if (url.endsWith("textures.json")) return {};
  if (url.endsWith("UILobby.json")) return lobby;
  if (url.endsWith("UICharacterCollection.json")) return collection;
  assert.fail(url);
} });
const { renderNav } = await import("../../src/ba_modding_toolkit/web/js/nav.js");
const { setStrings } = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
const { S } = await import("../../src/ba_modding_toolkit/web/js/util.js");
const flat = (value, prefix = "", out = {}) => {
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "object") flat(item, `${prefix}${key}.`, out); else out[prefix + key] = item;
  }
  return out;
};

for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`all seven nav entries share an icon box and lifted label baseline in ${locale}`, async () => {
  document.documentElement.lang = locale;
  setStrings(locale, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8"))));
  await renderNav(1, { game: true });
  assert.equal(host.children.length, 7);
  const labelTops = [], iconTops = [];
  host.children.forEach((button, i) => {
    const label = button.children.find((e) => e.dataset.path.endsWith("/Label"));
    const icon = button.children.find((e) => /\/(Able|Disable\/Icon)$/.test(e.dataset.path));
    assert.equal(icon.style.backgroundSize, "contain");
    assert.ok(Math.abs(parseFloat(icon.style.width) - 80 * S) < 0.01);
    assert.ok(parseFloat(icon.style.top) >= 0, "icons stay inside the bar, below the panels");
    assert.ok(parseFloat(icon.style.top) + parseFloat(icon.style.height) < parseFloat(label.style.top), "icons clear the labels");
    assert.equal(icon.style.width, icon.style.height);
    iconTops.push(icon.style.top);
    const url = /url\("(.+)"\)/.exec(icon.style.backgroundImage)[1], encoded = blobs.get(url);
    const native = meta[ITEMS[i].icon];
    assert.ok(Math.abs(encoded.width / encoded.height / (native.width / native.height) - 1) < 0.01,
      `resampling preserves the native sprite aspect before CSS containment: ${encoded.width}x${encoded.height} from ${native.width}x${native.height}`);
    const bottom = parseFloat(label.style.top) + parseFloat(label.style.height);
    assert.ok(bottom <= 104 - 20 * S, "labels leave the game's half-label-height bottom inset");
    assert.ok(parseFloat(label.style.left) >= 0 && parseFloat(label.style.left) + parseFloat(label.style.width) <= 260);
    assert.ok(!label.textContent.includes("\n")); labelTops.push(label.style.top);
    assert.ok(!button.children.some((e) => e.dataset.path.endsWith("/Lock")));
    assert.ok(!button.children.some((e) => e.dataset.path.includes("/IconPlus")), "donor submenu badges are removed");
  });
  assert.equal(new Set(labelTops).size, 1);
  assert.equal(new Set(iconTops).size, 1);
});
