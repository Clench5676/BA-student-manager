// Exercise the lobby's loading orchestration with the real cancellation helpers and stand-ins for drawing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { latestLoad, loadPlayer } from "../../src/ba_modding_toolkit/web/js/spine-load.js";
import { withTimeout } from "../../src/ba_modding_toolkit/web/js/async.js";
import { atStep } from "../../src/ba_modding_toolkit/web/js/preview-error.js";
import { validRect } from "../../src/ba_modding_toolkit/web/js/lobby-health.js";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8");
const loading = source.slice(source.indexOf("const lobbyLoads ="), source.indexOf("// the input trace"))
  .replaceAll("export function", "function").replaceAll("export async function", "async function");
const tick = () => new Promise(setImmediate);
const noop = () => {};
const meta = { main: "main", sparse: false, left: { x: 0, y: 0, w: 1920, h: 1080 }, full: { x: 0, y: 0, w: 1920, h: 1080 } };
const layers = async (core, mod) => ({ info: null, layers: [{ name: "main", spine: `${core}:${mod || "live"}` }] });

function harness(layersOf = layers, resolveSources = null, { allowed = true, confirm = true } = {}) {
  const created = [], calls = [];
  const revisions = new Map();
  const failures = [];
  const host = { innerHTML: "", classList: { remove: noop }, querySelector: () => ({}), appendChild(el) { this.message = el; } };
  const prompts = [];
  const env = {
    skinPrimary: (button, caption) => { button.textContent = caption; },
    latestLoad, layersOf, withTimeout, atStep, validRect, ensureSpine: async () => allowed,
    consent: async () => ({ async spine(host, opts) { prompts.push({ host, opts }); allowed = confirm; return confirm; } }),
    rectOf: (v) => ({ x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h }),
    spineBase: (kind, core) => `/asset/spine/${kind}/${core}/skeleton`,
    previewError: (...args) => failures.push(args), T: () => "Preview unavailable",
    document: { getElementById: (id) => id, createElement: () => ({ setAttribute: noop,
      children: [], appendChild(el) { this.children.push(el); },
      addEventListener(type, fn) { this[type] = fn; } }) },
    STAGE: { w: 1920, h: 1080 }, EXT_W: 480, EXT_H: 270,
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
    measure: () => structuredClone(meta), measuresClips: () => false,
    Stage: { install: noop, hostOf: () => null }, Linear: { setClear: noop, detach: noop },
    Materials: { detach: noop }, Touch: { setup: noop, detach: noop }, Idle: { start: noop, stop: noop },
    toWorld: noop, zoomAt: noop, panBy: noop, playClip: noop, clearClip: noop, next: noop,
    viewTarget: noop, setViewTarget: noop, endTalk: noop, Sfx: { clear: noop }, stop: noop,
    setTimeout: noop, reveal: () => calls.push("reveal"),
  };
  const h = new Function("env", `let { ${Object.keys(env).join(", ")} } = env;
    let current = null, players = [], token = 0, talkIndex = -1, mode = "left", wantTouch = false;
    let extendTimer, chain, subtitleTimer;
    ${loading}
    return { show, hide, recoverView, current: () => current };`)(env);
  return { ...h, host, created, calls, revisions, failures, prompts };
}

test("a lobby without confirmation fetches no source and offers confirmation before retrying", async () => {
  let sources = 0;
  const h = harness(layers, async () => { sources++; return { artBase: "art/", base: "layout/" }; }, { allowed: false });
  try {
    assert.equal(await h.show("hero_home", h.host, "hero"), null);
    assert.equal(sources, 0);
    assert.equal(h.created.length, 0);
    assert.equal(h.host.message.className, "lobby-unavailable");
    assert.equal(h.host.message.children[0].type, "button");
    const retry = h.host.message.children[0].click();
    await tick();
    assert.equal(sources, 1);
    assert.equal(h.created.length, 1);
    assert.deepEqual(h.prompts, [{ host: "consent", opts: { over: true } }]);
    h.created[0].config.success(h.created[0]);
    await retry;
  } finally { h.hide(h.host); }
});

test("declining the lobby confirmation keeps the status and never creates a player", async () => {
  const h = harness(layers, null, { allowed: false, confirm: false });
  await h.show("np0032_npc", h.host, "special:np0032_npc", { framing: "character" });
  await h.host.message.children[0].click();
  assert.equal(h.created.length, 0);
  assert.equal(h.prompts.length, 1);
  h.hide(h.host);
});

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
    assert.deepEqual(await Promise.all([first, skipped, latest]), [null, null, meta]);
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

test("a repeated show while the same source loads replaces the aborted work instead of caching its null result", async () => {
  const h = harness();
  try {
    const first = h.show("shun_home", h.host, "shun"); await tick();
    const next = h.show("shun_home", h.host, "shun"); await tick();
    assert.equal(await first, null);
    assert.equal(h.created[0].disposed, true);
    h.created[1].config.success(h.created[1]);
    assert.deepEqual(await next, meta);
    assert.equal(h.failures.length, 0, "a superseded owner does not flash an error over its replacement");
  } finally { h.hide(h.host); }
});

test("a stale revision during a player load retries the whole composition once", async () => {
  const h = harness();
  try {
    const shown = h.show("shun_home", h.host, "shun"); await tick();
    h.revisions.set("shun_home", "b");
    h.created[0].config.error(h.created[0], "404 stale atlas page"); await tick();
    assert.equal(h.created[0].disposed, true);
    assert.ok(h.current().artBase.endsWith(":b"));
    h.created[1].config.success(h.created[1]);
    assert.deepEqual(await shown, meta);
    assert.equal(h.failures.length, 0);
  } finally { h.hide(h.host); }
});

test("one failed layer cannot be silently omitted from an otherwise ready lobby", async () => {
  const h = harness(async () => ({ info: null, layers: [{ name: "bg", spine: "/rev/bg" }, { name: "home", spine: "/rev/home" }] }));
  try {
    const failed = assert.rejects(h.show("shun_home", h.host, "shun"), /missing page/); await tick();
    h.created[0].config.success(h.created[0]);
    h.created[1].config.error(h.created[1], "missing page");
    await failed;
    assert.equal(h.host.message.textContent, "Preview unavailable");
    assert.equal(h.failures[0][0].url, "/rev/home.skel");
    assert.ok(h.created.every((p) => p.disposed));
  } finally { h.hide(h.host); }
});

test("the complete lobby deadline reports failure, disposes players, and permits a later retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  try {
    const failed = assert.rejects(h.show("shun_home", h.host, "shun"), /timed out/); await tick();
    const old = h.created[0];
    t.mock.timers.tick(15000); await failed;
    assert.equal(h.host.message.textContent, "Preview unavailable");
    assert.equal(old.disposed, true);
    old.config.success(old);
    assert.equal(h.current(), null);
    const next = h.show("shun_home", h.host, "shun"); await tick();
    h.created.at(-1).config.success(h.created.at(-1));
    assert.deepEqual(await next, meta);
  } finally { h.hide(h.host); t.mock.timers.reset(); }
});

test("a manifest that answers after the total deadline cannot start a discarded lobby", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const h = harness(layers, () => new Promise((resolve) => { finish = resolve; }));
  try {
    const failed = assert.rejects(h.show("shun_home", h.host, "shun"), /timed out/); await tick();
    t.mock.timers.tick(15000); await failed;
    finish({ artBase: "/late/", base: "/late/" }); await tick();
    assert.equal(h.created.length, 0);
    assert.equal(h.current(), null);
    assert.equal(h.host.message.textContent, "Preview unavailable");
  } finally { h.hide(h.host); t.mock.timers.reset(); }
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

for (const framing of [null, "character", "scene"]) test(`context recovery rebuilds the complete lobby with framing ${framing}`, async () => {
  const h = harness(async () => ({ info: null, layers: [
    { name: "bg", spine: "/art/revision/bg" }, { name: "hero", spine: "/art/revision/hero" },
  ] }));
  try {
    const showing = h.show("np0032_npc", h.host, "special:np0032_npc", { mod: "configured", framing });
    await tick(); h.created.forEach((p) => p.config.success(p)); await showing;
    const old = h.current(); old.revealed = true;
    h.recoverView(old); h.recoverView(old); await tick();
    assert.equal(h.created.length, 4, "root and guests rebuild only once");
    assert.ok(h.created.slice(0, 2).every((p) => p.disposed));
    assert.equal(h.current().framing, framing); assert.equal(h.current().mod, "configured");
    assert.equal(h.current().artBase, old.artBase); assert.equal(h.current().base, old.base);
    assert.ok(h.calls.indexOf("dispose /art/revision/hero") < h.calls.indexOf("dispose /art/revision/bg"));
    h.created.slice(2).forEach((p) => p.config.success(p)); await tick();
    assert.deepEqual(h.calls.filter((c) => c === "reveal"), ["reveal"]);
    assert.equal(h.failures.length, 0);
    h.hide(h.host); h.recoverView(old); await tick(); assert.equal(h.created.length, 4);
  } finally { h.hide(h.host); }
});
