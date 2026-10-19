// Tests for web/js/image-decode.js (the pictures a screen waits for before it shows), run by tests/test_image_decode.py
// with Node's test runner: node --test tests/js/image_decode.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { cssUrls, decodeAll, imageUrls } from "../../src/ba_modding_toolkit/web/js/image-decode.js";

// an element as the page has it: only its inline style matters
const el = (backgroundImage) => ({ style: { backgroundImage } });

test("cssUrls reads the URLs of a background-image value as the browsers write it", () => {
  assert.deepEqual(cssUrls('url("blob:http://127.0.0.1:8790/0f3a-11")'), ["blob:http://127.0.0.1:8790/0f3a-11"]);
  assert.deepEqual(cssUrls("url(/asset/ui/sprite/Common/Common_Collect_CardBG.png)"), ["/asset/ui/sprite/Common/Common_Collect_CardBG.png"]);
  assert.deepEqual(cssUrls("url('a.png'), url(\"b.png\"), url(c.png)"), ["a.png", "b.png", "c.png"]);
  // escaped quotes and brackets inside a quoted URL
  assert.deepEqual(cssUrls('url("/asset/art/portrait/A \\"B\\" (1).png")'), ['/asset/art/portrait/A "B" (1).png']);
  // a data URL keeps its brackets and commas
  assert.deepEqual(cssUrls('url("data:image/svg+xml,<svg viewBox=\'0 0 1 1\'></svg>")'), ["data:image/svg+xml,<svg viewBox='0 0 1 1'></svg>"]);
});

test("cssUrls finds nothing in a value without a picture", () => {
  for (const value of ["", "none", undefined, null, "linear-gradient(red, blue)", 'url("")']) assert.deepEqual(cssUrls(value), []);
});

test("imageUrls gives each picture once, in the elements' order, and skips elements without one", () => {
  const els = [el('url("blob:x/1")'), el(""), el("none"), el('url("blob:x/2")'), el('url("blob:x/1")'), { style: {} }, {}, null];
  assert.deepEqual(imageUrls(els), ["blob:x/1", "blob:x/2"]);
  assert.deepEqual(imageUrls([]), []);
});

test("decodeAll waits for every picture and resolves with true", async () => {
  const done = [];
  const decode = (url) => new Promise((resolve) => setTimeout(() => { done.push(url); resolve(); }, url === "slow" ? 30 : 1));
  assert.equal(await decodeAll(["slow", "a", "b"], decode, 1000), true);
  assert.deepEqual(done.sort(), ["a", "b", "slow"]);
});

test("decodeAll counts a picture that fails, or throws, as done", async () => {
  const decode = (url) => {
    if (url === "throws") throw new Error("no picture");
    return url === "rejects" ? Promise.reject(new Error("broken")) : Promise.resolve();
  };
  assert.equal(await decodeAll(["ok", "rejects", "throws"], decode, 1000), true);
});

test("decodeAll gives up after cap ms and resolves with false", async () => {
  const t0 = performance.now();
  assert.equal(await decodeAll(["never"], () => new Promise(() => {}), 40), false);
  const waited = performance.now() - t0;
  assert.ok(waited >= 35 && waited < 1000, `waited ${waited} ms`);
});

test("decodeAll without pictures resolves at once, and without a cap waits as long as it takes", async () => {
  assert.equal(await decodeAll([], () => Promise.resolve(), 0), true);
  assert.equal(await decodeAll(["a"], () => new Promise((resolve) => setTimeout(resolve, 20))), true);
});
