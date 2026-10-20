import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Exercise the actual detail-screen apply callback without loading its renderers.
const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const start = source.indexOf("async function applyCandidate(");
const end = source.indexOf("\n}\n", start) + 2;
async function apply(result, kind) {
  const calls = [];
  const v = { key: "dress", spr: "dress_spr", lobby: "dress_home" };
  const ctx = {
    variant: () => v, sourceOf: (key) => key, ctx: { invalidateRoster: () => calls.push("roster") },
    forget: () => calls.push("forget"), spineBase: (kind, core) => `${kind}/${core}`,
    call: (fn) => fn(), rpc: async () => ({ key: "family", variants: [v] }),
    renderAll: async () => calls.push("cards"), renderLeft: async () => calls.push("left"),
    reload: async () => calls.push("reload"), changeInPlace: (fn) => fn(),
    clearTimeout() {}, open: true, fam: { key: "family" }, shownLeft: kind,
    expression: "00", blinkTimer: null, mainPlayer: {},
    lobbyStale: false, lobbyShot: {}, lobbySeq: {}, lobbyAll: true, shownKey: "dress",
    job: async (_method, _params, opts) => { await opts.onDone(result); await opts.after(true, result); },
  };
  vm.createContext(ctx);
  await vm.runInContext(`${source.slice(start, end)}; applyCandidate("mod:test", "${kind}")`, ctx);
  return { calls, ctx };
}

test("unchanged and deferred applies keep thumbnails and the live portrait or lobby", async () => {
  for (const kind of ["spr", "lobby"]) for (const deferred of [false, true]) {
    const { calls, ctx } = await apply({ files: [], unchanged: true, deferred }, kind);
    assert.deepEqual(calls, ["roster", "cards"]);
    assert.equal(ctx.lobbyStale, false); assert.ok(ctx.mainPlayer);
  }
});

test("changed game files still invalidate thumbnails and refresh the shown preview", async () => {
  for (const kind of ["spr", "lobby"]) {
    const { calls, ctx } = await apply({ files: ["changed.bundle"], unchanged: false }, kind);
    assert.deepEqual(calls, ["forget", "roster", "cards", "left"]);
    if (kind === "lobby") assert.equal(ctx.lobbyStale, true);
    else assert.equal(ctx.mainPlayer, null);
  }
});
