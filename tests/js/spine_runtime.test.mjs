import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../src/ba_modding_toolkit/web/", import.meta.url);
const source = readFileSync(new URL("js/spine-runtime.js", root), "utf8");
let sequence = 0;
async function harness(choice = null) {
  const nodes = [], calls = [];
  delete globalThis.spine;
  globalThis.document = {
    createElement: (tag) => ({ tag, remove() { nodes.splice(nodes.indexOf(this), 1); } }),
    head: { appendChild: (node) => nodes.push(node) },
  };
  globalThis.spineRuntimeRpc = async (method) => { calls.push(method); return choice; };
  const code = source.replace('import { rpc } from "./api.js";', "const rpc = globalThis.spineRuntimeRpc;");
  const mod = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// ${sequence++}`).toString("base64")}`);
  return { mod, nodes, calls, complete: () => {
    globalThis.spine = {};
    nodes.find((node) => node.tag === "script").onload();
  } };
}

test("the document has no static Spine script or stylesheet", () => {
  assert.doesNotMatch(readFileSync(new URL("index.html", root), "utf8"), /<(?:script|link)\b[^>]*(?:src|href)=["'][^"']*spine-player/i);
});

test("unanswered, declined and malformed choices never append or use the runtime", async () => {
  for (const choice of [null, false, "true", 1, {}]) {
    const h = await harness(choice);
    globalThis.spine = {};
    assert.equal(await h.mod.ensureSpine(), false, "an existing global cannot bypass confirmation");
    assert.deepEqual(h.nodes, []);
    assert.deepEqual(h.calls, ["app.spineConsent"]);
    assert.equal(h.mod.runtimeLoaded(), false);
  }
});

test("confirmation loads one script and stylesheet for concurrent and repeated previews", async () => {
  const h = await harness(true);
  const first = h.mod.ensureSpine(), second = h.mod.ensureSpine();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, ["app.spineConsent"]);
  assert.deepEqual(h.nodes.map((node) => node.tag), ["link", "script"]);
  assert.equal(h.nodes[0].rel, "stylesheet");
  assert.match(h.nodes[1].src, /spine-player-4\.2\.120\/spine-player\.min\.js$/);
  h.complete();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(await h.mod.ensureSpine(), true);
  assert.equal(h.nodes.length, 2);
});

test("granting after refusal starts loading; withdrawal before loading prevents it", async () => {
  const h = await harness(false);
  assert.equal(await h.mod.ensureSpine(), false);
  h.mod.setSpineConsent(true);
  h.mod.setSpineConsent(false);
  assert.equal(await h.mod.ensureSpine(), false);
  assert.equal(h.nodes.length, 0);
  h.mod.setSpineConsent(true);
  const ready = h.mod.ensureSpine();
  h.complete();
  assert.equal(await ready, true);
});

test("withdrawal keeps the loaded session usable and a fresh start requires confirmation again", async () => {
  const h = await harness(true), ready = h.mod.ensureSpine();
  await new Promise(setImmediate); h.complete(); await ready;
  h.mod.setSpineConsent(false);
  assert.equal(h.mod.spineAllowed(), true);
  assert.equal(await h.mod.ensureSpine(), true);
  const next = await harness(false);
  assert.equal(await next.mod.ensureSpine(), false);
  assert.equal(next.nodes.length, 0);
});

test("a failed script can be retried without leaving duplicate assets", async () => {
  const h = await harness(true), first = h.mod.ensureSpine();
  await new Promise(setImmediate);
  h.nodes.find((node) => node.tag === "script").onerror();
  await assert.rejects(first, /failed to load/);
  assert.equal(h.nodes.length, 0);
  const retry = h.mod.ensureSpine();
  h.complete();
  assert.equal(await retry, true);
  assert.equal(h.nodes.length, 2);
});

test("a script without the runtime namespace cleans up before retry", async () => {
  const h = await harness(true), first = h.mod.ensureSpine();
  await new Promise(setImmediate);
  h.nodes.find((node) => node.tag === "script").onload();
  await assert.rejects(first, /runtime unavailable/);
  assert.equal(h.nodes.length, 0);
  const retry = h.mod.ensureSpine(); h.complete();
  assert.equal(await retry, true);
  assert.equal(h.nodes.length, 2);
});

test("thumbnails declined before loading use their callers' static images without requests or players", async () => {
  const { setSpineConsent } = await import("../../src/ba_modding_toolkit/web/js/spine-runtime.js");
  const { thumb, thumbnailScope } = await import("../../src/ba_modding_toolkit/web/js/thumbs.js");
  setSpineConsent(false);
  globalThis.fetch = () => assert.fail("declined thumbnails need no manifest");
  globalThis.document.createElement = () => assert.fail("declined thumbnails need no player host");
  globalThis.spine = { SpinePlayer: class { constructor() { assert.fail("declined thumbnail player"); } } };
  const scope = thumbnailScope();
  assert.equal(await thumb("/asset/spine/spr/portrait/skeleton"), null);
  assert.equal(await scope.thumb(`/asset/spine/spr/portrait/${"a".repeat(64)}/skeleton`), null);
  scope.cancel();
});
