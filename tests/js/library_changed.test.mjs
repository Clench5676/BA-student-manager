import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Run the event coalescing and refresh with a detail page already on screen.
const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("let heldChange,"), source.indexOf("// A completed toggle"));
function harness() {
  const refreshed = [], forgotten = [], timers = [];
  let invalidated = 0;
  const env = {
    ctx: { invalidateRoster: () => invalidated++ },
    Detail: { filesChanged: (change) => refreshed.push(change) },
    $: () => ({ hidden: false }),
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
    assert.deepEqual(h.forgotten, ["spr/dress_spr"]);
  }
});

test("an empty file change without a mod-list change still needs no refresh", async () => {
  const h = harness();
  h.libraryChanged({ cores: [], kinds: [] });
  await h.applyChange();
  assert.equal(h.invalidated(), 0);
  assert.deepEqual(h.refreshed, []);
});
