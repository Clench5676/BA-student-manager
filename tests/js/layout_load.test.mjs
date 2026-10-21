import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.addEventListener = () => {};
const { layout } = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a cold layout export survives a long lobby teardown and shares its request with subtrees", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = deferred(), body = deferred(), requests = [];
  globalThis.fetch = (url) => { requests.push(url); return response.promise; };
  let state = "pending";
  const root = layout("ColdInventory");
  root.then(() => { state = "ready"; }, () => { state = "failed"; });
  const sub = layout("ColdInventory.Header");
  assert.equal(layout("ColdInventory"), root);
  t.mock.timers.tick(60000); await flush();
  assert.equal(state, "pending", "server-side discovery and bundle lock waits are legitimate work");
  response.resolve({ ok: true, json: () => body.promise }); await flush();
  t.mock.timers.tick(60000); await flush();
  assert.equal(state, "pending", "the response body is part of the same unbounded export");
  const header = { name: "Header", children: [] }, tree = { name: "ColdInventory", children: [header] };
  body.resolve(tree);
  assert.equal(await root, tree); assert.equal(await sub, header);
  assert.deepEqual(requests, ["/asset/ui/layout/ColdInventory.json"]);
});

test("HTTP and transport failures evict a layout so a later navigation can retry", async () => {
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error("connection closed");
    if (attempts === 2) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ name: "RetryInventory", children: [] }) };
  };
  await assert.rejects(layout("RetryInventory"), /connection closed/);
  await assert.rejects(layout("RetryInventory"), /HTTP 500/);
  assert.equal((await layout("RetryInventory")).name, "RetryInventory");
  assert.equal(attempts, 3);
});
