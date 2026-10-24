import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasAsset } from "../../src/ba_modding_toolkit/web/js/switch-sources.js";
import { visit } from "../../src/ba_modding_toolkit/web/js/roster-order.js";

// Run the event coalescing and refresh with a detail page already on screen.
const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("let heldChange,"), source.indexOf("// A completed toggle"));
function harness() {
  const refreshed = [], forgotten = [], timers = [];
  let invalidated = 0;
  const env = {
    ctx: { invalidateRoster: () => invalidated++ },
    BatchImport: { invalidate() {} },
    Detail: { filesChanged: (change) => refreshed.push(change) },
    $: (id) => ({ hidden: id === "screen-hall" }),
    forget: (base) => forgotten.push(base), spinePrefix: (kind, core) => `${kind}/${core}`,
    clearTimeout() {}, setTimeout: (fn) => { timers.push(fn); return timers.length; },
    routeToken: 1,
  };
  const api = new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
    ${code}
    return { libraryChanged, applyChange };`)(env);
  return { ...api, refreshed, forgotten, invalidated: () => invalidated };
}

test("a library-only add refreshes the open detail page with no game thumbnail eviction", async () => {
  const h = harness();
  h.libraryChanged({ cores: [], kinds: [], mods: true });
  await h.applyChange();
  assert.deepEqual(h.refreshed, [null]);
  assert.equal(h.invalidated(), 1);
  assert.deepEqual(h.forgotten, []);
});

test("coalescing an add with a switch still refreshes the mod list and evicts the changed core", async () => {
  for (const addFirst of [true, false]) {
    const h = harness();
    const add = { cores: [], kinds: [], mods: true }, apply = { cores: ["dress_spr"], kinds: ["spr"] };
    for (const change of addFirst ? [add, apply] : [apply, add]) h.libraryChanged(change);
    await h.applyChange();
    assert.deepEqual(h.refreshed, [null]);
    assert.deepEqual(h.forgotten, ["spr/dress_spr", "official-spr/dress_spr"]);
  }
});

test("an empty file change without a mod-list change still needs no refresh", async () => {
  const h = harness();
  h.libraryChanged({ cores: [], kinds: [] });
  await h.applyChange();
  assert.equal(h.invalidated(), 0);
  assert.deepEqual(h.refreshed, []);
});

test("a special scene's category decides cache eviction even when its core ends in spr", async () => {
  const h = harness();
  h.libraryChanged({ cores: ["scene_spr"], kinds: ["lobby"] });
  await h.applyChange();
  assert.deepEqual(h.forgotten, ["lobby/scene_spr", "official-lobby/scene_spr"]);
  assert.deepEqual(h.refreshed, [{ cores: ["scene_spr"] }]);
});

test("a visit records the selected background alongside a portrait in its family", () => {
  const fam = { variants: [{ key: "arona", spr: "arona_spr" },
    { key: "special:arona_workpage", spr: null, lobby: "arona_workpage" }] };
  const rosterData = { families: [fam] };
  const code = source.slice(source.indexOf("function visited("), source.indexOf("function showScreen("));
  const visited = new Function("rosterData", "hasAsset", "visit", `${code}; return visited;`)(rosterData, hasAsset, visit);
  visited(fam, "special:arona_workpage");
  assert.equal(fam.variants[1].recent, 0);
  assert.equal(fam.variants[0].recent, undefined);
});
