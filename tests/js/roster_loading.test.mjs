import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/roster.js", import.meta.url), "utf8");
const rowsCode = source.slice(source.indexOf("async function renderRow("), source.indexOf("function maxScroll("));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

class El {
  children = []; dataset = {}; style = {};
  setAttribute() {}
  addEventListener() {}
  appendChild(el) { this.children.push(el); }
  insertBefore(el, before) { this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, el); }
  remove() {}
}

function harness() {
  const requested = [], host = new El(), pictures = new Map(), renders = new Map();
  const rows = new Map([0, 70, 150].map((top, key) => {
    pictures.set(key, deferred()); renders.set(key, deferred());
    return [key, { top, items: [{ x: 0, y: 0, e: { key, name: `Student ${key}`, mods: 0, spr: "spr" } }] }];
  }));
  const env = {
    document: { createElement: () => new El() }, rows, rendered: new Map(), dom: { scrollHost: host },
    CLIP_BOTTOM: 100, PITCH: 50, S: 1, ORIGIN: [0, 0], view: { scroll: 0 }, clipTop: () => 0, ctx: {},
    cardTree: (e) => e, portraitOf: (e) => `portrait-${e.key}`, countText: () => "", T: (key) => key,
    NGUI: { render: async (tree) => {
      requested.push(tree.key);
      await renders.get(tree.key).promise;
      return { pictures: [pictures.get(tree.key).promise] };
    } },
  };
  const api = new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
    ${rowsCode}
    return { syncRows };`)(env);
  return { ...api, requested, pictures, renders };
}

test("the first screenful waits for every portrait before overscan is requested", async () => {
  const h = harness();
  let ready = false;
  const first = h.syncRows().then(() => { ready = true; });
  assert.deepEqual(h.requested, [0, 1]);
  h.renders.get(0).resolve(); h.renders.get(1).resolve();
  await flush(); assert.equal(ready, false, "rendered card geometry is insufficient");
  h.pictures.get(0).resolve(); await flush();
  assert.equal(ready, false, "one finished portrait cannot reveal the row");
  h.pictures.get(1).resolve(); await first;
  assert.equal(ready, true);
  assert.deepEqual(h.requested, [0, 1, 2]);
  // The off-screen portrait may stay pending without delaying the first frame.
});

test("a repeated row sync still waits for rows whose portraits are being prepared", async () => {
  const h = harness();
  const first = h.syncRows();
  let ready = false;
  const second = h.syncRows().then(() => { ready = true; });
  await flush(); assert.equal(ready, false);
  assert.deepEqual(h.requested, [0, 1], "existing rows are reused");
  for (const key of [0, 1]) { h.renders.get(key).resolve(); h.pictures.get(key).resolve(); }
  await Promise.all([first, second]);
  assert.equal(ready, true);
});
