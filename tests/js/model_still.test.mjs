import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelStills, modelStillKey, modelStillVersion } from "../../src/ba_modding_toolkit/web/js/model-still.js";
const turn = () => new Promise(setImmediate);
const fixture = (capture = async (url) => `blob:${url}`) => {
  const loads = [], disposed = [], reports = [];
  let contexts = 0, maxContexts = 0;
  const thumb = createModelStills({ report: (...args) => reports.push(args), renderer: async () => ({
    createStillView() {
      let url;
      contexts++; maxContexts = Math.max(contexts, maxContexts);
      return {
        async load(source, { signal }) { url = source; loads.push({ url, signal }); },
        renderStill: (signal) => capture(url, signal),
        dispose() { contexts--; disposed.push(url); },
      };
    },
  }) });
  return { thumb, loads, disposed, reports, maxContexts: () => maxContexts };
};

test("card, info panel and detail switch share a render; original, Mods, models and versions never share entries", async () => {
  const f = fixture(), options = { version: "install-a" };
  const a = f.thumb("hina", "official", options), b = f.thumb("hina", "official", options);
  assert.equal(a.thumbnail, true);
  assert.equal(await a, await b);
  assert.equal(await f.thumb("hina", "official", options), await a);
  const mod = await f.thumb("hina", "mod:pink", options);
  assert.notEqual(mod, await a); assert.match(mod, /source=mod%3Apink/);
  await f.thumb("hina", "mod:blue", options);
  await f.thumb("ibuki", "official", options);
  await f.thumb("hina", "official", { version: "install-b" });
  assert.equal(f.loads.length, 5); assert.equal(f.disposed.length, 5);
  assert.equal(f.maxContexts(), 1);
  assert.notEqual(modelStillKey("hina", "official", "a"), modelStillKey("hina", "mod:official", "a"));
});

test("cache revisions include installation, model parts, Mod updates and explicit invalidation", () => {
  const variant = { model: "hina", modelFiles: [{ path: "/game-a/hina", crc: 1 }], modList: [{ id: "m", kind: "model", files: [{ hash: "old" }] }] };
  const family = { version: "a", variants: [variant] };
  const key = () => modelStillVersion(family, variant);
  const a = key();
  Object.assign(variant.modList[0], { fresh: false, alias: "Owner label", label: "Original label" });
  assert.equal(key(), a, "display metadata cannot invalidate source bytes");
  family.version = "b"; assert.notEqual(key(), a);
  const b = key(); variant.modelFiles[0].path = "/game-b/hina"; assert.notEqual(key(), b);
  const c = key(); variant.modList[0].files[0].hash = "new"; assert.notEqual(key(), c);
  assert.notEqual(key(), modelStillVersion(family, variant, 1));
});

for (const error of [new Error("shader compilation failed"), null]) test(`failed ${error ? "GPU" : "empty"} capture is logged, leaves a placeholder and retries`, async () => {
  let failed = true;
  const f = fixture(async () => { if (failed) { if (error) throw error; return null; } return "blob:recovered"; });
  const request = f.thumb("pajamas", "mod:own");
  assert.equal(await request, null);
  assert.ok(request.failure());
  assert.equal(f.reports.length, 1); assert.match(f.reports[0][1], /pajamas.glb\?source=mod%3Aown/);
  assert.equal(f.reports[0][2], "thumbnail:model"); assert.equal(f.disposed.length, 1);
  failed = false;
  assert.equal(await f.thumb("pajamas", "mod:own"), "blob:recovered");
});

test("one consumer can cancel while another finishes; abandoning all consumers frees the renderer", async () => {
  const waiting = [];
  const f = fixture((_url, signal) => new Promise((resolve) => waiting.push({ resolve, signal })));
  const first = new AbortController(), second = new AbortController();
  const a = f.thumb("hina", "mod:pink", { signal: first.signal });
  const b = f.thumb("hina", "mod:pink", { signal: second.signal });
  await turn(); first.abort(); assert.equal(await a, null); assert.equal(waiting[0].signal.aborted, false);
  waiting[0].resolve("blob:shared"); assert.equal(await b, "blob:shared");
  const third = new AbortController(), c = f.thumb("ibuki", "official", { signal: third.signal });
  await turn(); third.abort(); assert.equal(await c, null); await turn();
  assert.equal(f.disposed.length, 2); assert.equal(waiting[1].signal.aborted, true); assert.equal(f.reports.length, 0);
  const fresh = f.thumb("ibuki", "official"); await turn(); waiting[2].resolve("blob:fresh"); assert.equal(await fresh, "blob:fresh");
});

test("a timeout advances fresh work, then retries for existing consumers and revokes a late blob", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const revoke = URL.revokeObjectURL, revoked = [];
  URL.revokeObjectURL = (url) => revoked.push(url);
  let finish;
  let attempts = 0;
  const f = fixture((url) => url.includes("stalled") ? (++attempts === 1 ? new Promise((resolve) => { finish = resolve; }) : "blob:recovered") : "blob:next");
  try {
    const a = f.thumb("stalled", "mod:pink"), b = f.thumb("next", "official");
    await turn(); t.mock.timers.tick(8000);
    assert.equal(await b, "blob:next");
    assert.equal(f.disposed.length, 2); assert.match(f.reports[0][0].message, /timed out/);
    finish("blob:too-late"); await turn(); assert.deepEqual(revoked, ["blob:too-late"]);
    t.mock.timers.tick(499); await turn(); assert.equal(attempts, 1);
    t.mock.timers.tick(1); await turn();
    assert.equal(await a, "blob:recovered"); assert.equal(attempts, 2);
    assert.equal(f.maxContexts(), 1); assert.equal(f.reports.length, 1);
    assert.equal(await f.thumb("stalled", "mod:pink"), "blob:recovered");
  } finally { URL.revokeObjectURL = revoke; t.mock.timers.reset(); }
});

test("timeouts have two retries with increasing backoff; every attempt is reported", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(() => new Promise(() => {}));
  try {
    const picture = f.thumb("always-stalled", "official");
    await turn(); t.mock.timers.tick(8000); await turn();
    t.mock.timers.tick(500); await turn(); assert.equal(f.loads.length, 2);
    t.mock.timers.tick(8000); await turn();
    t.mock.timers.tick(999); await turn(); assert.equal(f.loads.length, 2);
    t.mock.timers.tick(1); await turn(); assert.equal(f.loads.length, 3);
    t.mock.timers.tick(8000); await turn(); assert.equal(await picture, null);
    assert.equal(f.reports.length, 3); assert.equal(f.disposed.length, 3);
    t.mock.timers.tick(60000); await turn(); assert.equal(f.loads.length, 3);
  } finally { t.mock.timers.reset(); }
});

test("closing a model popup during backoff cancels its retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(() => new Promise(() => {})), scope = new AbortController();
  try {
    const picture = f.thumb("cancel-retry", "official", { signal: scope.signal });
    await turn(); t.mock.timers.tick(8000); await turn(); scope.abort();
    assert.equal(await picture, null);
    t.mock.timers.tick(60000); await turn(); assert.equal(f.loads.length, 1);
  } finally { t.mock.timers.reset(); }
});

test("cancellation during lazy import never allocates a late WebGL context", async () => {
  let finish;
  const thumb = createModelStills({ renderer: () => new Promise((resolve) => { finish = resolve; }) });
  const scope = new AbortController(), pending = thumb("hina", "official", { signal: scope.signal });
  await turn(); scope.abort(); assert.equal(await pending, null);
  finish({ createStillView: () => assert.fail("cancelled import must not allocate a context") }); await turn();
});
