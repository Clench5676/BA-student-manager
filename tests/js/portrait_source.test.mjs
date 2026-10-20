import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetSpineAssets, loadSpineAssets, spineBase } from "../../src/ba_modding_toolkit/web/js/api.js";

const base = spineBase("spr", "ibuki_spr");
const revision = (letter) => `${base.slice(0, base.lastIndexOf("/"))}/${letter.repeat(64)}/skeleton`;

function manifests(t, answers) {
  const requests = [];
  forgetSpineAssets();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url, options]);
    const answer = answers.shift();
    assert.ok(answer, `Unexpected manifest request ${url}`);
    return { ok: answer.status === 200, status: answer.status,
      json: async () => ({ revision: answer.revision?.repeat(64) }) };
  });
  return requests;
}

test("a current portrait resolves live files again after clearing the asset cache", async (t) => {
  const requests = manifests(t, [{ status: 200, revision: "a" }, { status: 200, revision: "a" }]);
  const loaded = [];
  for (let reload = 0; reload < 2; reload++) {
    assert.equal(await loadSpineAssets(base, async (resolved) => { loaded.push(resolved); return "magenta"; }), "magenta");
    forgetSpineAssets();
  }
  assert.deepEqual(loaded, [revision("a"), revision("a")]);
  assert.ok(requests.every(([url, options]) => url === "/asset/spine/spr/ibuki_spr/manifest.json" && options.cache === "no-store"));
});

test("a portrait rejected after its manifest reloads the changed revision once", async (t) => {
  const requests = manifests(t, [{ status: 200, revision: "a" }, { status: 200, revision: "b" }]);
  const warning = t.mock.method(console, "warn", () => {}), loaded = [];
  const failure = new Error(`Couldn't load binary ${revision("a")}.skel: status 404`);
  assert.equal(await loadSpineAssets(base, async (resolved) => {
    loaded.push(resolved);
    if (loaded.length === 1) throw failure;
    return "magenta";
  }), "magenta");
  assert.deepEqual(loaded, [revision("a"), revision("b")]);
  assert.equal(requests.length, 2);
  assert.ok(warning.mock.calls.some(({ arguments: args }) => args.includes(base) && args.includes(failure)));
});

test("a portrait keeps the original failure when the revision did not change", async (t) => {
  manifests(t, [{ status: 200, revision: "a" }, { status: 200, revision: "a" }]);
  const cause = new Error("Cannot decode atlas page"), loaded = [];
  await assert.rejects(loadSpineAssets(base, async (resolved) => { loaded.push(resolved); throw cause; }), (err) => err === cause);
  assert.deepEqual(loaded, [revision("a")]);
});

test("a portrait retries at most once while the game files keep changing", async (t) => {
  const requests = manifests(t, [{ status: 200, revision: "a" }, { status: 200, revision: "b" }]);
  t.mock.method(console, "warn", () => {});
  let loads = 0;
  await assert.rejects(loadSpineAssets(base, async () => { throw new Error(`failure ${++loads}`); }), /failure 2/);
  assert.equal(loads, 2);
  assert.equal(requests.length, 2);
});

for (const status of [404, 500]) test(`a failed portrait manifest reports its URL and HTTP ${status}`, async (t) => {
  manifests(t, [{ status }]);
  const warning = t.mock.method(console, "warn", () => {});
  await assert.rejects(loadSpineAssets(base, () => assert.fail("No player without a manifest")),
    status === 404 ? /Spine source unavailable.*ibuki_spr/ : /ibuki_spr\/manifest.json: HTTP 500/);
  if (status === 404) assert.match(String(warning.mock.calls[0].arguments[0]), /ibuki_spr\/manifest.json: HTTP 404/);
});

test("an invalid portrait revision reports the manifest URL", async (t) => {
  manifests(t, [{ status: 200, revision: "invalid" }]);
  await assert.rejects(loadSpineAssets(base, () => assert.fail("No player without a revision")), /ibuki_spr\/manifest.json: HTTP 200: invalid revision/);
});

for (const body of [null, {}, [], { revision: 123 }]) test(`a malformed manifest body is rejected (${JSON.stringify(body)})`, async (t) => {
  forgetSpineAssets();
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => body }));
  await assert.rejects(loadSpineAssets(base, () => assert.fail("No player without a revision")),
    /ibuki_spr\/manifest.json: HTTP 200: invalid revision/);
});

test("invalid manifest JSON retains its URL, status and decoding cause", async (t) => {
  forgetSpineAssets();
  const cause = new SyntaxError("Unexpected token");
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, json: async () => { throw cause; } }));
  await assert.rejects(loadSpineAssets(base, () => assert.fail("No player without a manifest")), (err) => {
    assert.match(err.message, /ibuki_spr\/manifest.json: HTTP 200: invalid JSON/);
    assert.equal(err.cause.cause, cause);
    return true;
  });
});

test("a manifest network failure retains its URL and cause and can be retried", async (t) => {
  forgetSpineAssets();
  const cause = new TypeError("Failed to fetch");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw cause; });
  await assert.rejects(loadSpineAssets(base, () => assert.fail("No player without a manifest")), (err) => {
    assert.match(err.message, /ibuki_spr\/manifest.json: Failed to fetch/);
    assert.equal(err.cause, cause);
    return true;
  });
  fetch.mock.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ revision: "a".repeat(64) }) }));
  assert.equal(await loadSpineAssets(base, (resolved) => resolved), revision("a"));
});

test("a failed refresh preserves the player's original asset failure", async (t) => {
  const requests = manifests(t, [{ status: 200, revision: "a" }, { status: 500 }]);
  const cause = new Error(`Cannot load ${revision("a")}.atlas: HTTP 404`);
  const warning = t.mock.method(console, "warn", () => {});
  await assert.rejects(loadSpineAssets(base, async () => { throw cause; }), (err) => err === cause);
  assert.equal(requests.length, 2);
  assert.ok(warning.mock.calls.some(({ arguments: args }) => args.some((arg) => String(arg).includes("HTTP 500"))));
});

test("leaving a portrait during a failed load prevents a retry", async (t) => {
  const requests = manifests(t, [{ status: 200, revision: "a" }]);
  const controller = new AbortController();
  await assert.rejects(loadSpineAssets(base, async () => { controller.abort(); throw new Error("cancelled"); },
    { signal: controller.signal }), /cancelled/);
  assert.equal(requests.length, 1);
});
