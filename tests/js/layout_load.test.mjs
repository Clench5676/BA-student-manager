import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.addEventListener = () => {};
const { init, layout } = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a cold layout export survives a long lobby teardown and shares its request with subtrees", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = deferred(), body = deferred(), requests = [];
  let tracked = 0, completed = 0;
  globalThis.BAMTRecovery = { request: () => { tracked++; return () => { completed++; }; } };
  t.after(() => { delete globalThis.BAMTRecovery; });
  globalThis.fetch = (url) => { requests.push(url); return response.promise; };
  let state = "pending";
  const root = layout("ColdInventory");
  root.then(() => { state = "ready"; }, () => { state = "failed"; });
  const sub = layout("ColdInventory.Header");
  assert.equal(layout("ColdInventory"), root);
  t.mock.timers.tick(60000); await flush();
  assert.equal(state, "pending", "server-side discovery and bundle lock waits are legitimate work");
  assert.equal(tracked, 1, "subtrees and repeated callers share one tracked request");
  assert.equal(completed, 0);
  response.resolve({ ok: true, json: () => body.promise }); await flush();
  t.mock.timers.tick(60000); await flush();
  assert.equal(state, "pending", "the response body is part of the same unbounded export");
  assert.equal(completed, 0);
  const header = { name: "Header", children: [] }, tree = { name: "ColdInventory", children: [header] };
  body.resolve(tree);
  assert.equal(await root, tree); assert.equal(await sub, header);
  assert.equal(completed, 1);
  assert.deepEqual(requests, ["/asset/ui/layout/ColdInventory.json"]);
});

test("HTTP, transport and body failures release boot grace and permit a later retry", async (t) => {
  let attempts = 0, pending = 0;
  globalThis.BAMTRecovery = { request: () => { pending++; return () => { pending--; }; } };
  t.after(() => { delete globalThis.BAMTRecovery; });
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error("connection closed");
    if (attempts === 2) return { ok: false, status: 500 };
    if (attempts === 3) return { ok: true, json: async () => { throw new Error("invalid body"); } };
    return { ok: true, json: async () => ({ name: "RetryInventory", children: [] }) };
  };
  await assert.rejects(layout("RetryInventory"), /connection closed/);
  assert.equal(pending, 0);
  await assert.rejects(layout("RetryInventory"), /HTTP 500/);
  assert.equal(pending, 0);
  await assert.rejects(layout("RetryInventory"), /invalid body/);
  assert.equal(pending, 0);
  assert.equal((await layout("RetryInventory")).name, "RetryInventory");
  assert.equal(attempts, 4);
  assert.equal(pending, 0);
});

test("UI index requests retain boot grace through body parsing", async (t) => {
  const atlases = deferred(), textures = deferred();
  let pending = 0;
  globalThis.BAMTRecovery = { request: () => { pending++; return () => { pending--; }; } };
  t.after(() => { delete globalThis.BAMTRecovery; });
  globalThis.fetch = async url => ({ ok: true, json: () => url.includes("atlases") ? atlases.promise : textures.promise });
  const ready = init();
  await flush();
  assert.equal(pending, 2);
  atlases.resolve({ Common: { Icon: { width: 1, height: 1 } } });
  await flush();
  assert.equal(pending, 1);
  textures.resolve({});
  await ready;
  assert.equal(pending, 0);
});
