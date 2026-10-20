import assert from "node:assert/strict";
import { test } from "node:test";
import { atStep, previewError } from "../../src/ba_modding_toolkit/web/js/preview-error.js";

test("preview causes go to the console and session RPC with their URL and step exactly once", async () => {
  const previousFetch = globalThis.fetch, previousError = console.error;
  const requests = [], logged = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...JSON.parse(options.body) });
    return { ok: true, json: async () => ({ result: null }) };
  };
  console.error = (...args) => logged.push(args);
  try {
    const err = atStep(new Error("Missing Repacked/Art.PNG"), "/rev/ArtBook.atlas", "atlas");
    previewError(err, "/source/skeleton", "detail");
    previewError(err, "/source/skeleton", "detail");
    await new Promise(setImmediate);
    assert.equal(logged.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "preview.failed");
    assert.equal(requests[0].params.url, "/rev/ArtBook.atlas");
    assert.equal(requests[0].params.step, "atlas");
    assert.match(requests[0].params.error, /Missing Repacked\/Art.PNG/);
  } finally { globalThis.fetch = previousFetch; console.error = previousError; }
});
