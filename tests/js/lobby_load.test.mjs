// Exercise the lobby's loading orchestration with the real cancellation helpers and stand-ins for drawing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { latestLoad, loadPlayer } from "../../src/ba_modding_toolkit/web/js/spine-load.js";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8");
const loading = source.slice(source.indexOf("const lobbyLoads ="), source.indexOf("// the input trace"))
  .replaceAll("export function", "function");
const tick = () => new Promise(setImmediate);
const noop = () => {};
const layers = async (core, mod) => ({ info: null, layers: [{ name: "main", spine: `${core}:${mod || "live"}` }] });

function harness(layersOf = layers) {
  const created = [], calls = [];
  const host = { innerHTML: "", classList: { remove: noop }, querySelector: () => ({}) };
  const env = {
    latestLoad, layersOf, STAGE: { w: 1920, h: 1080 }, EXT_W: 480, EXT_H: 270,
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
  return { ...h, host, created, calls };
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
