import assert from "node:assert/strict";
import { test } from "node:test";
import { createPreviewCache } from "../../src/ba_modding_toolkit/web/js/preview-cache.js";
import { createModelStills } from "../../src/ba_modding_toolkit/web/js/model-still.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const configured = (store, generation = "one", enabled = true) => store.configure({ previewCache: enabled, previewCacheGeneration: generation });
function backend() {
  const files = new Map(), calls = [];
  let generation = "one", revision = "a".repeat(64);
  return { files, calls, clear() { generation = "two"; files.clear(); }, revision(value) { revision = value; },
    async request(method, args) {
      calls.push([method, args]);
      if (method === "preview.modelRevision" || method === "preview.assetRevision") return { revision, generation };
      if (method === "preview.cacheGet") return { allowed: true, generation, data: files.get(args.key) ?? null };
      if (method === "preview.cachePut") {
        if (args.generation !== generation) return false;
        files.set(args.key, args.data); return true;
      }
      assert.fail(method);
    },
  };
}
const options = (server, extra = {}) => ({ request: server.request, digest: async (key) => key,
  fetchImage: async () => ({ blob: async () => new Blob([png], { type: "image/png" }) }),
  makeUrl: (bytes) => { assert.deepEqual(bytes, png); return "blob:persisted"; }, ...extra });

test("preview disk access waits for settings and cached lossless bytes survive a new page", async () => {
  const server = backend(), first = createPreviewCache(options(server));
  assert.equal(first.ticket("source"), null);
  assert.equal(await first.get(null), null); assert.equal(await first.put(null, "blob:x"), false);
  assert.equal(server.calls.length, 0);
  configured(first);
  assert.equal(await first.put(first.ticket("revision+camera"), "blob:x"), true);
  const second = createPreviewCache(options(server)); configured(second);
  assert.equal(await second.get(second.ticket("revision+camera")), "blob:persisted");
  assert.equal(await second.get(second.ticket("new-revision+camera")), null);
});

test("preview cache defaults on after settings load and preserves explicit opt-out", async () => {
  const server = backend(), store = createPreviewCache(options(server));
  store.configure({ previewCacheGeneration: "one" });
  assert.ok(store.ticket("default-on"));
  assert.equal(await store.put(store.ticket("default-on"), "blob:x"), true);
  store.configure({ previewCache: false, previewCacheGeneration: "one" });
  assert.equal(store.ticket("saved-off"), null);
  const calls = server.calls.length;
  assert.equal(await store.put(null, "blob:x"), false);
  assert.equal(server.calls.length, calls);
});

test("stalled optional cache RPCs time out and fall back without blocking rendering", async () => {
  const calls = [], store = createPreviewCache(options(backend(), {
    timeout: 5, request(method, args, options) {
      calls.push([method, options.timeout]);
      return new Promise(() => {});
    },
  }));
  configured(store);
  assert.equal(await store.get(store.ticket("source")), null);
  assert.equal(await store.modelTicket("source", "student", "live"), null);
  assert.equal(await store.assetTicket(store.ticket("source"), ["/asset/art/bg/BG_Cafe.png"]), null);
  assert.equal(await store.put(store.ticket("source"), "blob:x"), false);
  assert.deepEqual(calls, [["preview.cacheGet", 5], ["preview.modelRevision", 5], ["preview.assetRevision", 5], ["preview.cachePut", 5]]);
});

test("clear or opt-out prevents a pending thumbnail upload from restoring old cache", async () => {
  for (const clear of [true, false]) {
    const server = backend(); let release;
    const store = createPreviewCache(options(server, { fetchImage: async () => ({
      blob: () => new Promise((resolve) => { release = () => resolve(new Blob([png], { type: "image/png" })); }),
    }) })); configured(store);
    const pending = store.put(store.ticket("old"), "blob:x");
    await new Promise(setImmediate);
    if (clear) server.clear();
    configured(store, clear ? "two" : "one", clear);
    release(); assert.equal(await pending, false); assert.equal(server.files.size, 0);
  }
});

test("an obsolete read cannot roll back a newer clear generation", async () => {
  const server = backend(); let release;
  const store = createPreviewCache(options(server, { request: () => new Promise((resolve) => { release = resolve; }) }));
  configured(store);
  const pending = store.get(store.ticket("old")); await new Promise(setImmediate);
  configured(store, "two");
  release({ allowed: true, generation: "one", data: btoa(String.fromCharCode(...png)) });
  assert.equal(await pending, null);
  assert.equal(store.ticket("new").generation, "two");
});

test("oversized PNGs and cancelled reads do not alter picture quality or publish a result", async () => {
  const server = backend(), store = createPreviewCache(options(server, { fetchImage: async () => ({
    blob: async () => new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/png" }),
  }) })); configured(store);
  assert.equal(await store.put(store.ticket("large"), "blob:large"), false);
  assert.equal(server.files.size, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal(await store.get(store.ticket("a"), { signal: controller.signal }), null);
  assert.equal(server.calls.length, 0);
});

test("model thumbnail identity includes exact validated GLB bytes", async () => {
  const server = backend(), store = createPreviewCache(options(server)); configured(store);
  const a = await store.modelTicket("render-parameters", "student", "live");
  server.revision("b".repeat(64));
  const b = await store.modelTicket("render-parameters", "student", "live");
  assert.notEqual(a.key, b.key);
  assert.equal(await store.put(a, "blob:a"), false, "do not publish art under a source that changed while rendering");
  assert.equal(await store.get(b), null);
  assert.equal(await store.put(b, "blob:b"), true);
  assert.equal(await store.get(b), "blob:persisted");
});

test("background and framing dependencies invalidate stills and are rechecked after capture", async () => {
  const server = backend(), store = createPreviewCache(options(server)); configured(store);
  const paths = ["/asset/art/bg/collection.png", `/asset/spine/lobby/core/${"f".repeat(64)}/framing.json`];
  const a = await store.assetTicket(store.ticket("same-spine"), paths);
  server.revision("c".repeat(64));
  const b = await store.assetTicket(store.ticket("same-spine"), paths);
  assert.notEqual(a.key, b.key);
  assert.equal(await store.put(a, "blob:old-background"), false);
  assert.equal(await store.put(b, "blob:current-background"), true);
  assert.equal(await store.get(a), null);
  assert.equal(await store.get(b), "blob:persisted");
});

test("a persisted model still avoids renderer creation and does not rewrite cached PNGs", async () => {
  let reads = 0;
  const thumbnail = createModelStills({ renderer: () => assert.fail("No GPU work on a persistent hit"),
    persistent: { modelTicket: async () => ({}), get: async () => { reads++; return "blob:cached-model"; },
      put: () => assert.fail("No duplicate write on hit") }, report: () => assert.fail("Cache hit must not report an error") });
  assert.equal(await thumbnail("student", "live", { version: "source" }), "blob:cached-model");
  assert.equal(await thumbnail("student", "live", { version: "source" }), "blob:cached-model");
  assert.equal(reads, 1);
  await new Promise(setImmediate);
});
