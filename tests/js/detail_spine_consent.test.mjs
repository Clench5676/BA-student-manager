import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeAll } from "../../src/ba_modding_toolkit/web/js/image-decode.js";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const portraitCode = source.slice(source.indexOf("async function showSpine("), source.indexOf("// the detail screen's portrait framing"));
const noop = () => {};

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.classList = { add: noop, remove: noop };
  }
  appendChild(el) { el.parent = this; this.children.push(el); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((el) => el !== this); this.parent = null; }
  querySelectorAll() { return this.children; }
}

function portraitHarness(portrait, confirm = async () => false, decode = () => Promise.resolve()) {
  const host = new Element("div"), status = [], unexpected = [];
  const controller = new AbortController();
  let consentAllowed = false, retries = 0;
  const env = {
    ensureSpine: async () => { consentAllowed = await confirm(); return consentAllowed; },
    $: () => host, document: { createElement: (tag) => Object.assign(new Element(tag), tag === "img" ? { decode } : {}) },
    decodeAll, HARD_CAP: 15000,
    Loading: { covering: () => true }, commit: (fn) => fn(), variant: () => ({ portrait }),
    Lobby: { licenseRequired: (layer, retry) => status.push({ layer, retry }) },
    renderLeft: () => { retries++; }, prioritise: () => unexpected.push("prioritise"),
    loadSpineAssets: () => unexpected.push("assets"), clearTimeout: noop,
  };
  const show = new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
    let spineToken = 1, batch = null, blinkTimer, mainPlayer = null, open = true;
    ${portraitCode}; return showSpine;`)(env);
  return { host, status, unexpected, controller, show: () => show("preview", 1, controller.signal), retries: () => retries };
}

test("the detail portrait uses the collection image without loading preview assets", async () => {
  const h = portraitHarness("/asset/art/portrait/ibuki.png");
  await h.show();
  const image = h.host.children[0].children[0];
  assert.equal(image.tag, "img");
  assert.equal(image.className, "portrait-static");
  assert.equal(image.src, "/asset/art/portrait/ibuki.png");
  assert.equal(image.alt, "");
  assert.deepEqual(h.unexpected, []);
  assert.equal(h.status.length, 0);
});

test("the static portrait waits for decoding before its preview is ready", async () => {
  let finish, ready = false;
  const h = portraitHarness("/portrait.png", async () => false, () => new Promise((resolve) => { finish = resolve; }));
  const showing = h.show().then(() => { ready = true; });
  await new Promise(setImmediate);
  assert.equal(ready, false);
  assert.equal(h.host.children[0].children[0].src, "/portrait.png");
  finish();
  await showing;
  assert.equal(ready, true);
});

test("cancelling a pending static decode removes its layer and settles readiness", async () => {
  let decoding = false;
  const h = portraitHarness("/portrait.png", async () => false, () => { decoding = true; return new Promise(() => {}); });
  const showing = h.show();
  await new Promise(setImmediate);
  assert.equal(decoding, true);
  h.controller.abort();
  await showing;
  assert.equal(h.host.children.length, 0);
});

test("a missing collection portrait offers confirmation and retries the live detail view", async () => {
  const h = portraitHarness(null);
  await h.show();
  assert.equal(h.status.length, 1);
  await h.status[0].retry();
  assert.equal(h.retries(), 1);
  assert.deepEqual(h.unexpected, []);
});

test("a cancelled confirmation read cannot add a portrait after detail was left", async () => {
  let finish;
  const h = portraitHarness("/portrait.png", () => new Promise((resolve) => { finish = resolve; }));
  const showing = h.show();
  h.controller.abort();
  finish(false);
  await showing;
  assert.equal(h.host.children.length, 0);
});

test("detail thumbnail fallbacks use collection portraits only for the matching official source", () => {
  const code = source.slice(source.indexOf("function collectionPortrait("), source.indexOf("function begin()"));
  const variants = [{ key: "ibuki", spr: "ibuki_spr", portrait: "/ibuki.png", modList: [{ id: "added", kind: "spr" }] },
    { key: "special:npc", lobby: "npc" }];
  const read = new Function("fam", "spineBase", "variantBase", `${code}; return collectionPortrait;`)
    ({ variants }, (kind, core) => `${kind}/${core}`, (v) => `installed/${v.spr}`);
  assert.equal(read("official-spr/ibuki_spr"), "/ibuki.png");
  for (const base of ["spr/ibuki_spr", "installed/ibuki_spr", "mod/added"]) assert.equal(read(base), null);
  assert.equal(read("lobby/npc"), null);
  assert.equal(read("unknown"), null);
});
