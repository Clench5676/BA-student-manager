// Exercise the lobby's loading orchestration with the real cancellation helpers and stand-ins for drawing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { latestLoad, loadPlayer } from "../../src/ba_modding_toolkit/web/js/spine-load.js";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8");
const loading = source.slice(source.indexOf("const lobbyLoads ="), source.indexOf("// the input trace"))
  .replaceAll("export function", "function").replaceAll("export async function", "async function");
const tick = () => new Promise(setImmediate);
const noop = () => {};
const layers = async (core, mod) => ({ info: null, layers: [{ name: "main", spine: `${core}:${mod || "live"}` }] });

function harness(layersOf = layers, resolveSources = null) {
  const created = [], calls = [];
  const revisions = new Map();
  const host = { innerHTML: "", classList: { remove: noop }, querySelector: () => ({}) };
  const env = {
    latestLoad, layersOf, STAGE: { w: 1920, h: 1080 }, EXT_W: 480, EXT_H: 270,
    sourcesOf: resolveSources || (async (core, mod) => ({ artBase: `${core}:${mod || "live"}:${revisions.get(mod || core) || "a"}`,
      base: `${core}:layout` })),
    makePlayer(_host, layer, _fx, _share, signal) {
      return loadPlayer((config) => {
        const p = { config, name: layer.spine, disposed: false, parent: { remove: noop },
          dispose() { assert.equal(this.disposed, false); this.disposed = true; calls.push(`dispose ${this.name}`); } };
        created.push(p);
        calls.push(`create ${p.name}`);
        return p;
      }, {}, { signal });
    },
    setView: noop, game: () => ({}), viewOf: () => ({}), feather: noop, lightUp: noop, openEdge: noop,
    measure: () => ({ main: "main", sparse: false }), measuresClips: () => false,
    Stage: { install: noop, hostOf: () => null }, Linear: { setClear: noop, detach: noop },
    Materials: { detach: noop }, Touch: { setup: noop, detach: noop }, Idle: { start: noop, stop: noop },
    toWorld: noop, zoomAt: noop, panBy: noop, playClip: noop, clearClip: noop, next: noop,
    viewTarget: noop, setViewTarget: noop, endTalk: noop, Sfx: { clear: noop }, stop: noop,
    setTimeout: noop,
  };
  const h = new Function("env", `let { ${Object.keys(env).join(", ")} } = env;
    let current = null, players = [], token = 0, talkIndex = -1, mode = "left", wantTouch = false;
    let extendTimer, chain, subtitleTimer;
    ${loading}
    return { show, hide, current: () => current };`)(env);
  return { ...h, host, created, calls, revisions };
}

test("configured lobby source changes cancel old players, including a switch back before the next load starts", async () => {
  const h = harness();
  try {
    const first = h.show("hero_home", h.host, "hero", { mod: "a" });
    await tick();
    const old = h.created[0];
    const skipped = h.show("hero_home", h.host, "hero", { mod: "b" });
    const latest = h.show("hero_home", h.host, "hero", { mod: "a" });
    await tick();
    assert.deepEqual(h.calls, ["create hero_home:a", "dispose hero_home:a", "create hero_home:a"]);
    old.config.success(old);
    h.created[1].config.success(h.created[1]);
    assert.deepEqual(await Promise.all([first, skipped, latest]), [null, null, { main: "main", sparse: false }]);
    assert.equal(await h.show("hero_home", h.host, "hero", { mod: "a" }), h.current().meta);
    assert.equal(h.created.length, 2, "the live source is reused");

    for (const mod of ["b", null]) {
      const shown = h.show("hero_home", h.host, "hero", { mod });
      await tick();
      const p = h.created.at(-1);
      assert.equal(h.created.at(-2).disposed, true, "the prior GPU owner is freed first");
      assert.equal(p.name, `hero_home:${mod || "live"}`);
      assert.equal(h.current().mod, mod);
      p.config.success(p);
      assert.ok(await shown);
    }
  } finally { h.hide(h.host); }
  assert.ok(h.created.every((p) => p.disposed));
});

test("late configured lobby metadata cannot resurrect a hidden view", async () => {
  let finish;
  const h = harness(() => new Promise((resolve) => { finish = resolve; }));
  const shown = h.show("hero_home", h.host, "hero", { mod: "a" });
  await tick();
  h.hide(h.host);
  assert.equal(await shown, null);
  finish(await layers("hero_home", "a"));
  await tick();
  assert.equal(h.current(), null);
  assert.equal(h.created.length, 0);
});

test("a changed manifest revision reloads the same lobby source and frees its old player first", async () => {
  for (const mod of [null, "configured"]) {
    const h = harness();
    try {
      const first = h.show("hero_home", h.host, "hero", { mod });
      await tick();
      h.created[0].config.success(h.created[0]);
      await first;
      h.revisions.set(mod || "hero_home", "b");
      const next = h.show("hero_home", h.host, "hero", { mod });
      await tick();
      assert.equal(h.created.length, 2);
      assert.equal(h.created[0].disposed, true);
      assert.ok(h.current().artBase.endsWith(":b"));
      h.created[1].config.success(h.created[1]);
      assert.ok(await next);
    } finally { h.hide(h.host); }
  }
});

test("late manifests cannot revive a hidden lobby or overtake a newer source", async () => {
  const pending = new Map();
  const h = harness(layers, (_core, mod) => new Promise((resolve) => pending.set(mod, resolve)));
  const bases = (name) => ({ artBase: `${name}/`, base: "layout/" });
  try {
    const hidden = h.show("hero_home", h.host, "hero", { mod: "hidden" });
    await tick();
    h.hide(h.host);
    assert.equal(await hidden, null);
    pending.get("hidden")(bases("hidden"));
    await tick();
    assert.equal(h.created.length, 0);

    const old = h.show("hero_home", h.host, "hero", { mod: "old" });
    await tick();
    const next = h.show("hero_home", h.host, "hero", { mod: "next" });
    assert.equal(await old, null);
    await tick();
    pending.get("next")(bases("next"));
    await tick();
    pending.get("old")(bases("old"));
    await tick();
    assert.equal(h.current().mod, "next");
    assert.equal(h.created.length, 1);
    h.created[0].config.success(h.created[0]);
    assert.ok(await next);

    const waiting = h.show("hero_home", h.host, "hero", { mod: "waiting" });
    assert.equal(h.current(), null, "changing source clears the disposed view before waiting for its manifest");
    assert.equal(h.created[0].disposed, true);
    await tick();
    h.hide(h.host);
    assert.equal(await waiting, null, "hiding ends the manifest wait without a response");
    pending.get("waiting")(bases("waiting"));
    await tick();
    assert.equal(h.current(), null);
  } finally { h.hide(h.host); }
});

test("a configured lobby with no skeletons or a failed player rejects and allows a later source", async () => {
  const h = harness((core, mod) => mod === "empty" ? { info: null, layers: [] } : layers(core, mod));
  try {
    await assert.rejects(h.show("hero_home", h.host, "hero", { mod: "empty" }), /No lobby skeletons found/);
    const failed = h.show("hero_home", h.host, "hero", { mod: "broken" });
    await tick();
    h.created[0].config.error(h.created[0], "broken bundle");
    await assert.rejects(failed, /broken bundle/);
    assert.equal(h.current(), null);
    assert.equal(h.created[0].disposed, true);
    const recovered = h.show("hero_home", h.host, "hero");
    await tick();
    h.created[1].config.success(h.created[1]);
    assert.ok(await recovered);
  } finally { h.hide(h.host); }
});

test("zoom limits are cached by both the configured art revision and the live layout revision", () => {
  const start = source.indexOf("function measureClips()");
  const code = source.slice(start, source.indexOf("// the layers' setup-pose bounds", start));
  const measured = [];
  const env = {
    game: () => ({}), outerOf: (rect) => rect, union: () => ({}), rectOf: () => ({}), reclamp: noop,
    performance, SLICE_MS: 8, setTimeout: (fn) => fn(),
    measureSafe: function* (loaded) { measured.push(loaded[0]); return { whole: {} }; },
  };
  const measure = new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
    const safeRects = new Map(); let current;
    ${code}
    return (artBase, base) => {
      current = { artBase, base, loaded: [artBase], meta: { full: {} } };
      measureClips();
      return current.meta;
    };`)(env);
  assert.ok(measure("mod-a/first/", "layout/first/").safe);
  assert.ok(measure("mod-b/first/", "layout/first/").safe);
  assert.ok(measure("mod-b/second/", "layout/first/").safe);
  assert.ok(measure("mod-b/second/", "layout/second/").safe);
  assert.equal(measured.length, 4, "changing either source measures its own limits");
  assert.ok(measure("mod-a/first/", "layout/first/").safe);
  assert.equal(measured.length, 4, "revisiting the same two sources reuses their limits");
});
