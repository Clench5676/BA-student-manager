import assert from "node:assert/strict";
import { test } from "node:test";
let epoch = "http-exports-v1";
globalThis.document = { documentElement: { lang: "en-US" }, querySelector: () => ({ content: epoch }),
  createElement: () => ({ getContext: () => ({}) }) };
const calls = [];
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  // Model a browser entry still fresh under the old max-age policy.
  return { ok: true, json: async () => options?.cache === "no-cache"
    ? { effect: 3, effectColor: "#ffffff/1", effectDistance: [3, 3], gradient: ["#fa8c21", "#e6780e"] }
    : { effect: 3 } };
};
const { uiExportUrl } = await import("../../src/ba_modding_toolkit/web/js/api.js");
const NGUI = await import("../../src/ba_modding_toolkit/web/js/ngui.js");
test("the bootstrap export epoch bypasses old fresh cache entries and is idempotent", () => {
  const first = uiExportUrl("/asset/ui/layout/Root.json?path=child");
  assert.equal(uiExportUrl(first), first); assert.match(first, /path=child.*export=http-exports-v1/);
  epoch = "next-schema";
  assert.notEqual(uiExportUrl("/asset/ui/layout/Root.json?path=child"), first);
  assert.equal(uiExportUrl("/asset/spine/mod/x/manifest.json"), "/asset/spine/mod/x/manifest.json");
});
test("layouts force HTTP validation instead of accepting the legacy fresh export", async () => {
  const layout = await NGUI.layout("CacheProof");
  assert.deepEqual(layout.effectDistance, [3, 3]); assert.equal(layout.gradient[0], "#fa8c21");
  assert.equal(calls.at(-1).options.cache, "no-cache"); assert.match(calls.at(-1).url, /export=next-schema/);
});
