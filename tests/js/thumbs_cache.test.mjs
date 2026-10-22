import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spineBase, spinePrefix, spineAssetBase } from "../../src/ba_modding_toolkit/web/js/api.js";
import { thumb, forget, prioritise, thumbnailScope, hasThumbnailInk, withThumbnailFallback } from "../../src/ba_modding_toolkit/web/js/thumbs.js";
import { setSpineConsent } from "../../src/ba_modding_toolkit/web/js/spine-runtime.js";

setSpineConsent(true);

const revisions = new Map();
const loaded = [], requests = [], posed = [];
const players = new Set();
let blobs = 0, animations = ["Idle_01"];
const el = () => ({
  style: {}, appendChild() {}, remove() {},
  querySelector: () => ({ width: 2, height: 1, toBlob: (done) => done({}) }),
  getContext: () => ({ drawImage() {} }), toBlob: (done) => done({}),
});
globalThis.document = { body: el(), createElement: el };
globalThis.requestAnimationFrame = (done) => queueMicrotask(() => { for (const p of players) p.config.draw?.(p); done(); });
globalThis.URL.createObjectURL = () => `blob:thumb-${++blobs}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.fetch = async (url, options) => {
  requests.push([url, options]);
  const revision = revisions.get(url);
  return { ok: !!revision, status: revision ? 200 : 404, json: async () => ({ revision }) };
};
globalThis.spine = {
  Vector2: class {}, Physics: { update: 0 },
  SpinePlayer: class {
    constructor(_el, config) {
      assert.equal(config.premultipliedAlpha, false, "thumbnail PMA matches 0.2.0");
      assert.equal(config.viewport.width, 1, "capture framing replaces the initial viewport without animation sampling");
      loaded.push(config);
      this.config = config; players.add(this);
      this.context = { gl: { drawingBufferWidth: 2, drawingBufferHeight: 1, RGBA: 1, UNSIGNED_BYTE: 1,
        readPixels: (_x, _y, _w, _h, _f, _t, pixels) => pixels.set([0, 0, 0, 0, 200, 100, 50, 255]) } };
      this.skeleton = {
        data: { findAnimation: (name) => (animations.includes(name) ? {} : null), animations: animations.map((name) => ({ name })) },
        slots: [], updateWorldTransform() {}, setToSetupPose() { posed.push(["setup"]); },
        getBounds: (offset, size) => { Object.assign(offset, { x: 0, y: 0 }); Object.assign(size, { x: 800, y: 1600 }); },
      };
      this.animationState = {
        setAnimation: (track, name) => { posed.push(["set", track, name]); return { animation: {} }; },
        setEmptyAnimation: (track) => { posed.push(["empty", track]); return { animation: {} }; },
        clearTrack: (track) => posed.push(["clear", track]), clearTracks: () => posed.push(["clearAll"]), apply() {},
      };
      const draw = () => {}, sr = { draw, premultipliedAlpha: false }, batcher = { draw };
      this.sceneRenderer = { skeletonRenderer: sr, batcher };
      this.assetManager = { get: () => ({ pages: [{ texture: {}, pma: true }] }) };
      queueMicrotask(() => {
        config.success(this);
        assert.equal(sr.draw, draw, "atlas PMA never patches thumbnail drawing");
        assert.equal(batcher.draw, draw);
      });
    }
    setViewport() {}
    stopRendering() { this.stopRequestAnimationFrame = true; }
    drawFrame(loop) { assert.equal(loop, false); this.config.draw?.(this); }
    dispose() { players.delete(this); }
  },
};
const set = (base, value) => revisions.set(base.replace(/skeleton$/, "manifest.json"), value.repeat(64));
// Successful requests may still have a companion capture and player cleanup behind them.
afterEach(async () => { await new Promise(setImmediate); });

test("a failed portrait capture reuses an existing still of the same source revision only", async () => {
  const base = spineBase("official-spr", "pajamas_cached"), Player = spine.SpinePlayer;
  set(base, "a");
  const still = await thumb(base, "bust");
  await new Promise(setImmediate);
  spine.SpinePlayer = class extends Player {
    constructor(el, config) { super(el, config); this.context.gl.readPixels = () => {}; }
  };
  try {
    assert.equal(await thumb(base, "portrait"), still);
    const twin = spineBase("official-spr", "pajamas_other"); set(twin, "a");
    assert.equal(await thumb(twin, "portrait"), null, "a similarly named variant is a different source");
    set(base, "b");
    assert.equal(await thumb(base, "portrait"), null, "never show art from an older revision");
  } finally { spine.SpinePlayer = Player; }
});

test("portrait fallback preserves the real picture, queue priority and cancellation", async () => {
  const controller = new AbortController();
  let resolve, bumps = 0, fallbacks = 0;
  const picture = Object.assign(new Promise((done) => { resolve = done; }), { thumbnail: true,
    signal: controller.signal, bump: () => bumps++ });
  const pending = withThumbnailFallback(picture, () => { fallbacks++; return "collection.png"; });
  assert.equal(pending.thumbnail, true); assert.equal(pending.signal, controller.signal);
  pending.bump(); assert.equal(bumps, 1);
  controller.abort(); resolve(null);
  assert.equal(await pending, null); assert.equal(fallbacks, 0);
  assert.equal(await withThumbnailFallback(Promise.resolve("blob:art"), () => assert.fail("prefer the captured art")), "blob:art");
  assert.equal(await withThumbnailFallback(Promise.resolve(null), () => "collection.png"), "collection.png");
  assert.equal(await withThumbnailFallback(Promise.reject(new Error("capture failed")), () => "collection.png"), "collection.png");
});

test("off-screen captures render while lifecycle hooks and the RAF clock are inactive", async () => {
  const Player = spine.SpinePlayer, raf = requestAnimationFrame;
  const base = spineBase("official-spr", "inactive_spr");
  let draws = 0;
  document.hasFocus = () => false;
  globalThis.requestAnimationFrame = () => assert.fail("a thumbnail must not wait for RAF");
  spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      super(el, { ...config, success: (player) => {
        assert.equal(player.stopRequestAnimationFrame, true, "the real lifecycle suspended this player before readiness");
        config.success(player);
      } });
      this.context.gl.readPixels = (_x, _y, _w, _h, _f, _t, pixels) => {
        if (draws) pixels.set([80, 80, 80, 0, 80, 80, 80, 255]);
      };
    }
    drawFrame(loop) { draws++; super.drawFrame(loop); }
  };
  try {
    set(base, "a");
    assert.ok(await thumb(base, "face"));
    assert.equal(draws, 1);
  } finally { delete document.hasFocus; globalThis.requestAnimationFrame = raf; spine.SpinePlayer = Player; }
});

test("alpha boundaries count as ink in flat-colour art; blank frames do not", () => {
  for (const pixels of [[90, 90, 90, 0, 90, 90, 90, 255], [90, 90, 90, 255, 90, 90, 90, 0]]) {
    assert.equal(hasThumbnailInk(new Uint8Array(pixels)), true);
  }
  assert.equal(hasThumbnailInk(new Uint8Array([10, 20, 30, 0, 40, 50, 60, 0])), false);
  assert.equal(hasThumbnailInk(new Uint8Array([240, 240, 240, 255, 240, 240, 240, 255])), false);
});

test("a blank inactive capture is rejected quickly and the next skeleton still renders", async () => {
  const Player = spine.SpinePlayer, raf = requestAnimationFrame;
  const blank = spineBase("spr", "inactive_blank_spr"), healthy = spineBase("spr", "inactive_healthy_spr");
  let reads = 0;
  document.hidden = true;
  globalThis.requestAnimationFrame = () => assert.fail("blank captures cannot wait for RAF");
  spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      super(el, config);
      if (config.skeleton.includes("/inactive_blank_spr/")) this.context.gl.readPixels = () => { reads++; };
    }
  };
  try {
    set(blank, "a"); set(healthy, "b");
    const failed = thumb(blank, "face"), next = thumb(healthy, "face");
    assert.equal(await failed, null); assert.equal(reads, 6); assert.ok(await next);
  } finally { delete document.hidden; globalThis.requestAnimationFrame = raf; spine.SpinePlayer = Player; }
});

test("thumbnail cache follows file revisions, source, install, frame and expression", async () => {
  const official = spineBase("official-spr", "ibuki_spr");
  const mod = spineBase("mod", "ibuki");
  const live = spineBase("spr", "ibuki_spr");
  const other = spineBase("official-spr", "ibuki_spr", "other-install");
  for (const base of [official, mod, live, other]) set(base, "a");
  const before = await thumb(live, "card");
  assert.equal(await thumb(live, "card"), before);
  set(live, "b");
  const after = await thumb(live, "card");
  assert.notEqual(after, before, "applying changed the live content without an explicit forget");
  assert.equal(await thumb(live, "card"), after);
  set(live, "a");
  assert.equal(await thumb(live, "card"), before, "restored content has its own cached picture");
  const original = await thumb(official, "card");
  assert.notEqual(original, before, "official and live sources have separate keys");
  assert.notEqual(await thumb(mod, "card"), original);
  assert.notEqual(await thumb(other, "card"), original);
  assert.notEqual(await thumb(official, "bust"), original);
  assert.notEqual(await thumb(official, "face", "00"), await thumb(official, "face", "01"));
  const count = loaded.length;
  set(mod, "c");
  await thumb(mod, "card");
  assert.equal(loaded.length, count + 1, "updating a mod does not reuse its old thumbnail");
  for (const config of loaded) {
    assert.match(config.skeleton, /\/[a-f0-9]{64}\/skeleton\.skel$/);
    assert.equal(config.atlas, config.skeleton.replace(/\.skel$/, ".atlas"));
  }
  assert.ok(requests.every(([, options]) => options.cache === "no-store"));
});

test("an unavailable official source leaves the plain placeholder, including after an earlier success", async () => {
  const base = spineBase("official-spr", "missing_spr");
  assert.equal(await thumb(base), null);
  set(base, "d");
  assert.ok(await thumb(base));
  revisions.delete(base.replace(/skeleton$/, "manifest.json"));
  const count = loaded.length;
  assert.equal(await thumb(base), null);
  assert.equal(loaded.length, count, "an old cached picture is never substituted for missing data");
});

test("resolved bases keep the revision beside every atlas page and can be forgotten by core", async () => {
  const base = spineBase("official-lobby", "ibuki_home");
  set(base, "e");
  const resolved = await spineAssetBase(base);
  assert.equal(await spineAssetBase(resolved), resolved);
  assert.equal(new URL("page.png", `http://localhost${resolved}.atlas`).pathname,
    `/asset/spine/official-lobby/ibuki_home/${"e".repeat(64)}/page.png`);
  const picture = await thumb(resolved);
  forget("/asset/spine/official-lobby/IBUKI_HOME");
  assert.notEqual(await thumb(resolved), picture);
});

test("a still starts from cleared tracks, so the skeleton's first animation (a lobby's intro) never mixes in", async () => {
  const base = spineBase("official-lobby", "pose_home");
  set(base, "1");
  animations = ["Start_Idle_01", "Idle_01", "Talk_01_A"];
  posed.length = 0;
  await thumb(base, "card", null, true);
  const cleared = posed.findIndex((e) => e[0] === "clearAll"), idle = posed.findIndex((e) => e[0] === "set" && e[2] === "Idle_01");
  assert.ok(cleared >= 0 && idle > cleared, "tracks cleared before the idle is set");
  assert.deepEqual(posed.filter((e) => e[0] === "set").map((e) => e[2]), ["Idle_01", "Idle_01"], "card and its bust: the idle both times");
  assert.ok(posed.findIndex((e) => e[0] === "setup") < idle, "setup pose first");
  // a lobby without Idle_01 rests in its first other animation, never an intro; one with intros only in the setup pose
  animations = ["Start_Idle_01", "Dummy", "Loop_01"];
  const other = spineBase("official-lobby", "pose2_home");
  set(other, "2");
  posed.length = 0;
  await thumb(other, "card", null, true);
  assert.equal(posed.find((e) => e[0] === "set")[2], "Loop_01");
  animations = ["Start_Idle_01"];
  const intro = spineBase("official-lobby", "pose3_home");
  set(intro, "3");
  posed.length = 0;
  await thumb(intro, "card", null, true);
  assert.ok(!posed.some((e) => e[0] === "set") && posed.some((e) => e[0] === "empty"));
  animations = ["Idle_01"];
});

test("the card and the big picture of one skeleton share a load", async () => {
  const base = spineBase("official-spr", "pair_spr");
  set(base, "4");
  const count = loaded.length;
  const card = await thumb(base, "card");
  const bust = await thumb(base, "bust");
  assert.ok(card && bust && card !== bust);
  assert.equal(loaded.length, count + 1, "one skeleton load for both frames");
  // the other way round, and an expression frame is no companion
  const second = spineBase("official-spr", "pair2_spr");
  set(second, "5");
  await thumb(second, "bust");
  assert.equal(loaded.length, count + 2);
  await thumb(second, "card");
  assert.equal(loaded.length, count + 2);
  await thumb(second, "face", "00");
  assert.equal(loaded.length, count + 3);
});

test("a card asked to go first is rendered before the ones queued earlier", async () => {
  const order = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const real = globalThis.spine.SpinePlayer;
  // the first load waits, so the rest are in the queue when the bump comes
  globalThis.spine.SpinePlayer = class extends real {
    constructor(el, config) {
      order.push(config.skeleton.match(/official-spr\/(\w+)\//)[1]);
      super(el, { ...config, success: (player) => (order.length === 1 ? gate : Promise.resolve()).then(() => config.success(player)) });
    }
  };
  try {
    const bases = ["a1", "a2", "a3", "a4"].map((core) => spineBase("official-spr", `${core}_spr`));
    bases.forEach((base, i) => set(base, String(6 + i)));
    const pics = bases.map((base) => thumb(base, "card"));
    await new Promise((resolve) => setTimeout(resolve, 0)); // the manifests answered, the queue filled
    pics[3].bump();
    open();
    await Promise.all(pics);
    assert.deepEqual(order, ["a1_spr", "a4_spr", "a2_spr", "a3_spr"]);
    // asked to go first before the files were resolved: it goes first once they are
    const later = ["b1", "b2", "b3"].map((core) => spineBase("official-spr", `${core}_spr`));
    later.forEach((base, i) => set(base, a(i)));
    order.length = 0;
    let open2;
    const gate2 = new Promise((resolve) => { open2 = resolve; });
    globalThis.spine.SpinePlayer = class extends real {
      constructor(el, config) {
        order.push(config.skeleton.match(/official-spr\/(\w+)\//)[1]);
        super(el, { ...config, success: (player) => (order.length === 1 ? gate2 : Promise.resolve()).then(() => config.success(player)) });
      }
    };
    const set2 = later.map((base) => thumb(base, "card"));
    set2[2].bump();
    await new Promise((resolve) => setTimeout(resolve, 0));
    open2();
    await Promise.all(set2);
    assert.ok(order.indexOf("b3_spr") <= 1, order.join());
  } finally {
    globalThis.spine.SpinePlayer = real;
  }
});
const a = (i) => "abcdef"[i];

test("overlapping manifest requests for one directory share one answer", async () => {
  const base = spineBase("official-spr", "dedupe_spr");
  set(base, "8");
  const before = requests.length;
  const [x, y] = await Promise.all([spineAssetBase(base), spineAssetBase(base)]);
  assert.equal(x, y);
  assert.equal(requests.length, before + 1);
  await spineAssetBase(base);
  assert.equal(requests.length, before + 2, "a later request asks again: the files may have changed");
});

test("forget invalidates delayed manifests by core without old completions deleting their replacements", async () => {
  const base = spineBase("spr", "Delayed_spr");
  const install = spineBase("spr", "Delayed_spr", "other-install");
  const other = spineBase("spr", "unrelated_spr");
  const fetch = globalThis.fetch, waiting = [];
  globalThis.fetch = (url) => new Promise((resolve) => waiting.push({ url, resolve }));
  const answer = (i, revision) => waiting[i].resolve({ ok: true, json: async () => ({ revision: revision.repeat(64) }) });
  try {
    const before = spineAssetBase(base), installBefore = spineAssetBase(install), unrelated = spineAssetBase(other);
    forget(spinePrefix("spr", "DELAYED_SPR"));
    const after = spineAssetBase(base), installAfter = spineAssetBase(install);
    assert.equal(waiting.length, 5, "both installs get fresh requests after the change");
    assert.equal(spineAssetBase(other), unrelated, "an unrelated core still shares its pending request");
    answer(0, "a");
    await before;
    assert.equal(spineAssetBase(base), after, "the old response cannot remove the new pending request");
    answer(1, "a");
    await installBefore;
    assert.equal(spineAssetBase(install), installAfter);
    answer(2, "c");
    answer(3, "b");
    answer(4, "b");
    const [current, installed] = await Promise.all([after, installAfter, unrelated]);
    assert.equal(current, base.replace("/skeleton", `/${"b".repeat(64)}/skeleton`));
    assert.equal(installed, install.replace("/skeleton", `/${"b".repeat(64)}/skeleton`));
    const pending = spineAssetBase(base);
    forget();
    const fresh = spineAssetBase(base);
    assert.notEqual(fresh, pending, "forget without a prefix invalidates every pending manifest");
    answer(5, "b");
    answer(6, "c");
    await Promise.all([pending, fresh]);
  } finally {
    for (const { resolve } of waiting) resolve({ ok: false });
    forget();
    globalThis.fetch = fetch;
  }
});

test("a thumbnail with a delayed old manifest recovers after a switch without a redraw", async () => {
  const base = spineBase("spr", "switch_spr"), manifest = base.replace(/skeleton$/, "manifest.json");
  set(base, "a");
  const fetch = globalThis.fetch, Player = globalThis.spine.SpinePlayer;
  const count = loaded.length, start = requests.length, disposed = [];
  let release, asked, delay = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const asking = new Promise((resolve) => { asked = resolve; });
  globalThis.fetch = async (url, options) => {
    const res = await fetch(url, options);
    if (url !== manifest || !delay) return res;
    delay = false;
    return { ...res, json: async () => { asked(); await gate; return res.json(); } };
  };
  globalThis.spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      const stale = !config.skeleton.includes(`/${revisions.get(manifest)}/`);
      super(el, stale ? { ...config, success: (player) => config.error(player, `Couldn't load binary ${config.skeleton}: status 404`) } : config);
    }
    dispose() { disposed.push(this.config.skeleton); super.dispose(); }
  };
  try {
    const before = thumb(base, "card");
    await asking;
    set(base, "b");
    forget(spinePrefix("spr", "SWITCH_SPR"));
    const after = thumb(base, "card");
    assert.equal(requests.length, start + 2, "the thumbnail after the switch does not join the delayed manifest");
    release();
    const [oldPicture, newPicture] = await Promise.all([before, after]);
    assert.ok(newPicture);
    assert.equal(oldPicture, newPicture, "the old load also recovers with the current revision");
    assert.equal(loaded.length, count + 2, "one rejected old player and one shared current player");
    assert.equal(requests.length, start + 3, "the rejected load asks for a fresh manifest once");
    assert.ok(disposed.some((skeleton) => skeleton.includes(`/${"a".repeat(64)}/`)), "the rejected player is disposed");
    assert.equal(await thumb(base, "card"), newPicture, "the recovered picture is cached under its current revision");
  } finally {
    release();
    globalThis.fetch = fetch;
    globalThis.spine.SpinePlayer = Player;
  }
});

test("revision rejection retries once even if the files keep switching", async () => {
  const base = spineBase("spr", "retry_spr");
  set(base, "a");
  const Player = globalThis.spine.SpinePlayer, count = loaded.length, start = requests.length;
  let failures = 0;
  globalThis.spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      set(base, ++failures === 1 ? "b" : "c");
      super(el, { ...config, success: (player) => config.error(player, `Couldn't load texture atlas ${config.atlas}: status 404`) });
    }
  };
  try {
    assert.equal(await thumb(base, "face", "01"), null);
    assert.equal(loaded.length, count + 2, "the second rejection ends this thumbnail request");
    assert.equal(requests.length, start + 2, "there is only one manifest refresh");
  } finally {
    globalThis.spine.SpinePlayer = Player;
  }
  assert.ok(await thumb(base, "face", "01"), "a later redraw can recover after both rejected attempts");
});

test("a stalled manifest expires and a later load can ask afresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = globalThis.fetch, base = spineBase("spr", "stalled_spr");
  try {
    globalThis.fetch = () => new Promise(() => {});
    const failed = assert.rejects(spineAssetBase(base), /Spine manifest .*: timed out/);
    t.mock.timers.tick(15000); await failed;
    globalThis.fetch = fetch;
    set(base, "a");
    assert.equal(await spineAssetBase(base), base.replace("/skeleton", `/${"a".repeat(64)}/skeleton`));
  } finally { globalThis.fetch = fetch; t.mock.timers.reset(); }
});

test("a stalled companion capture releases the thumbnail queue for another core", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const create = document.createElement, base = spineBase("spr", "companion_spr"), next = spineBase("spr", "after_companion_spr");
  let encodes = 0;
  try {
    document.createElement = () => ({ ...el(), toBlob(done) {
      if (++encodes !== 2) done({});
    } });
    set(base, "a"); set(next, "b");
    assert.ok(await thumb(base, "card"));
    await new Promise(setImmediate);
    assert.equal(encodes, 2, "the shared bust capture has started and never calls back");
    const later = thumb(next, "face", "00");
    await new Promise(setImmediate);
    t.mock.timers.tick(3000);
    assert.ok(await later, "the next core renders after the stalled capture's deadline");
    await new Promise(setImmediate);
  } finally { document.createElement = create; t.mock.timers.reset(); }
});

test("a bust requested during its companion capture joins that render without replacing its consumers", async () => {
  const create = document.createElement, base = spineBase("spr", "late_companion_spr"), scope = thumbnailScope();
  let encodes = 0, release;
  const count = loaded.length;
  try {
    document.createElement = () => ({ ...el(), toBlob(done) {
      if (++encodes === 2) release = () => done({}); else done({});
    } });
    set(base, "b");
    assert.ok(await scope.thumb(base, "card"));
    await new Promise(setImmediate);
    assert.ok(release, "the speculative bust is still encoding");
    const bust = scope.thumb(base, "bust"); await new Promise(setImmediate);
    release();
    assert.ok(await bust);
    assert.equal(loaded.length, count + 1);
    assert.equal(encodes, 2);
  } finally { release?.(); scope.cancel(); await new Promise(setImmediate); document.createElement = create; }
});

test("a detail scope reuses manifest answers across redraws and revalidates after invalidation or navigation", async () => {
  const base = spineBase("official-spr", "scoped_spr"), start = requests.length;
  const scope = thumbnailScope();
  try {
    set(base, "a");
    const first = await scope.thumb(base, "face", "00");
    assert.ok(await scope.thumb(base, "face", "01"));
    assert.equal(await scope.thumb(base, "face", "00"), first);
    assert.equal(requests.length, start + 1, "one check for the screen's source, including subsequent redraws");
    set(base, "b"); forget(spinePrefix("official-spr", "SCOPED_SPR"));
    assert.notEqual(await scope.thumb(base, "face", "00"), first);
    assert.equal(requests.length, start + 2);
  } finally { scope.cancel(); }
  const next = thumbnailScope();
  try {
    assert.ok(await next.thumb(base, "face", "00"));
    assert.equal(requests.length, start + 3, "a new page checks even a cached picture's revision");
  } finally { next.cancel(); }
});

test("faces rejected at the same revision share one fresh manifest and one replacement player", async () => {
  const base = spineBase("spr", "refresh_faces_spr"), scope = thumbnailScope(), Player = spine.SpinePlayer;
  const start = requests.length, count = loaded.length;
  spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      const stale = config.skeleton.includes(`/${"a".repeat(64)}/`);
      if (stale) set(base, "b");
      super(el, stale ? { ...config, success: (p) => config.error(p, "Couldn't load binary: status 404") } : config);
    }
  };
  try {
    set(base, "a");
    const faces = await Promise.all(["00", "01", "02", "03"].map((expr) => scope.thumb(base, "face", expr)));
    assert.ok(faces.every(Boolean));
    assert.equal(requests.length, start + 2, "one initial manifest and one shared refresh");
    assert.equal(loaded.length, count + 2, "one rejected revision and one replacement player");
  } finally { scope.cancel(); await new Promise(setImmediate); spine.SpinePlayer = Player; }
});

test("prioritising before manifests answer puts the visible source before an older queue", async () => {
  const Player = spine.SpinePlayer, order = [], base = spineBase("spr", "visible_spr");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      order.push(config.skeleton);
      super(el, { ...config, success: (p) => (order.length === 1 ? gate : Promise.resolve()).then(() => config.success(p)) });
    }
  };
  try {
    const blocker = spineBase("spr", "blocker_spr"), older = spineBase("spr", "older_spr");
    for (const b of [base, blocker, older]) set(b, "c");
    const first = thumb(blocker, "face", "00"); await new Promise(setImmediate);
    const old = thumb(older, "face", "00");
    prioritise(base);
    const visible = thumb(base, "face", "00");
    await new Promise(setImmediate); release();
    await Promise.all([first, old, visible]);
    assert.ok(order[1].includes("/visible_spr/"));
  } finally { release(); spine.SpinePlayer = Player; prioritise(null); }
});

test("a stalled skeleton fails all its faces once and releases the next core", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Player = spine.SpinePlayer, base = spineBase("official-spr", "stuck_spr"), next = spineBase("spr", "healthy_spr");
  const scope = thumbnailScope(), disposed = [];
  spine.SpinePlayer = class extends Player {
    constructor(el, config) { super(el, config.skeleton.includes("/stuck_spr/") ? { ...config, success() {} } : config); }
    dispose() { disposed.push(this.config.skeleton); super.dispose(); }
  };
  try {
    document.hidden = true;
    set(base, "d"); set(next, "e");
    const faces = Array.from({ length: 8 }, (_, i) => scope.thumb(base, "face", `0${i}`));
    const later = scope.thumb(next, "face", "00");
    await new Promise(setImmediate);
    t.mock.timers.tick(7999); await new Promise(setImmediate);
    assert.equal(disposed.length, 0);
    t.mock.timers.tick(1); await new Promise(setImmediate);
    assert.deepEqual(await Promise.all(faces), Array(8).fill(null));
    assert.ok(await later, "one total deadline, rather than a deadline per queued face");
    assert.ok(disposed.some((url) => url.includes("/stuck_spr/")));
  } finally { delete document.hidden; scope.cancel(); await new Promise(setImmediate); spine.SpinePlayer = Player; t.mock.timers.reset(); }
});

test("a stuck encoder fails the remaining expressions together and lets another skeleton render", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const create = document.createElement, scope = thumbnailScope();
  const base = spineBase("spr", "stuck_encoder_spr"), next = spineBase("spr", "after_encoder_spr");
  let encodes = 0, late;
  const before = blobs;
  try {
    document.createElement = () => ({ ...el(), toBlob(done) {
      if (++encodes === 1) late = done; else done({});
    } });
    set(base, "e"); set(next, "f");
    const faces = ["00", "01", "02"].map((expr) => scope.thumb(base, "face", expr));
    const healthy = scope.thumb(next, "face", "00");
    await new Promise(setImmediate);
    t.mock.timers.tick(3000); await new Promise(setImmediate);
    assert.deepEqual(await Promise.all(faces), [null, null, null]);
    assert.ok(await healthy);
    assert.equal(encodes, 2, "one failed encode, then the healthy skeleton's picture");
    assert.equal(blobs, before + 1);
    late({}); await new Promise(setImmediate);
    assert.equal(blobs, before + 1, "a cancelled encode's late callback cannot leak a blob URL");
  } finally { scope.cancel(); await new Promise(setImmediate); document.createElement = create; t.mock.timers.reset(); }
});

test("cancelling scopes removes queued work and disposes a shared render only after its last consumer leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const Player = spine.SpinePlayer, base = spineBase("spr", "shared_cancel_spr"), next = spineBase("spr", "queued_cancel_spr");
  const first = thumbnailScope(), second = thumbnailScope(), players = [];
  let release;
  spine.SpinePlayer = class extends Player {
    constructor(el, config) {
      super(el, { ...config, success: (p) => { release = () => config.success(p); } });
      players.push(this);
    }
    dispose() { this.disposed = true; super.dispose(); }
  };
  try {
    set(base, "f"); set(next, "a");
    const a = first.thumb(base, "face", "00"), b = second.thumb(base, "face", "00"), queued = first.thumb(next, "card");
    await new Promise(setImmediate);
    first.cancel();
    assert.equal(await a, null); assert.equal(await queued, null);
    assert.equal(players[0].disposed, undefined, "the second scope still needs this player");
    second.cancel();
    assert.equal(await b, null);
    assert.equal(players[0].disposed, true);
    release(); await new Promise(setImmediate);
    t.mock.timers.tick(60000); await new Promise(setImmediate);
    assert.equal(players.length, 1, "neither the cancelled queue nor the late success restarts work");
  } finally { first.cancel(); second.cancel(); await new Promise(setImmediate); spine.SpinePlayer = Player; t.mock.timers.reset(); }
});

test("a cancelled player's cleanup cannot fail a new page's request for the same revision", async () => {
  const Player = spine.SpinePlayer, first = thumbnailScope(), next = thumbnailScope();
  const resolved = spineBase("spr", "reenter_spr").replace("/skeleton", `/${"c".repeat(64)}/skeleton`);
  let count = 0;
  spine.SpinePlayer = class extends Player {
    constructor(el, config) { super(el, ++count === 1 ? { ...config, success() {} } : config); }
  };
  try {
    const old = first.thumb(resolved, "face", "00"); await new Promise(setImmediate);
    first.cancel();
    const fresh = next.thumb(resolved, "face", "00");
    assert.equal(await old, null);
    assert.ok(await fresh, "cleanup belongs to the cancelled attempt, even before its await resumes");
    assert.equal(count, 2);
  } finally { first.cancel(); next.cancel(); await new Promise(setImmediate); spine.SpinePlayer = Player; }
});

test("cancelling a scope aborts a stalled manifest without leaving its deadline alive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fetch = globalThis.fetch, scope = thumbnailScope();
  let signal;
  try {
    globalThis.fetch = (_url, options) => { signal = options.signal; return new Promise(() => {}); };
    const pending = scope.thumb(spineBase("spr", "cancel_manifest_spr"));
    scope.cancel();
    assert.equal(signal.aborted, true);
    assert.equal(await pending, null);
    t.mock.timers.tick(60000);
  } finally { scope.cancel(); await new Promise(setImmediate); globalThis.fetch = fetch; t.mock.timers.reset(); }
});

test("backgrounds participate in still cache identity and propagate to companion captures", async () => {
  const create = document.createElement, Image = globalThis.Image, draws = [];
  const base = spineBase("spr", "background_spr"), loadedBefore = loaded.length;
  document.createElement = (tag) => tag === "canvas" ? {
    getContext: () => ({ measureText: (text) => ({ width: text.length * 10 }), drawImage: (image) => draws.push(image.src || "portrait") }),
    toBlob: (done) => done({}),
  } : { ...el(), querySelector: () => ({ width: 384, height: 352, toBlob: (done) => done({}) }) };
  globalThis.Image = class {
    naturalWidth = 1600; naturalHeight = 900;
    set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); }
    get src() { return this.url; }
  };
  const scope = thumbnailScope();
  try {
    set(base, "a");
    const first = await scope.thumb(base, "card", null, false, null, "/bg/practice");
    await new Promise(setImmediate);
    assert.ok(first); assert.ok(draws.includes("/bg/practice"));
    const before = draws.length;
    assert.equal(await scope.thumb(base, "card", null, false, null, "/bg/practice"), first);
    assert.equal(draws.length, before, "the same background and source reuse the composed still");
    const bust = await scope.thumb(base, "bust", null, false, null, "/bg/practice");
    assert.ok(bust); assert.equal(loaded.length, loadedBefore + 1, "the companion shares the background and player");
    const other = await scope.thumb(base, "card", null, false, null, "/bg/classroom");
    assert.ok(other && other !== first); assert.ok(draws.includes("/bg/classroom"));
    const transparent = await scope.thumb(base, "card");
    assert.ok(transparent && transparent !== first && transparent !== other);
  } finally { scope.cancel(); await new Promise(setImmediate); document.createElement = create; globalThis.Image = Image; }
});

test("portrait captures retry cleared frames and never cache a pale uniform square", async () => {
  const Player = spine.SpinePlayer, base = spineBase("mod", "ch0294_spr_capture");
  let reads = 0, mode = "late";
  spine.SpinePlayer = class extends Player {
    constructor(...args) {
      super(...args);
      this.context.gl.readPixels = (_x, _y, _w, _h, _f, _t, pixels) => {
        reads++;
        if (mode === "solid") pixels.fill(240);
        else if (mode === "ready" || reads >= 3) pixels.set([0, 0, 0, 0, 200, 100, 50, 255]);
      };
    }
  };
  try {
    set(base, "a");
    const before = blobs;
    assert.ok(await thumb(base, "face"));
    assert.equal(reads, 3, "the first two transparent draws are rejected");
    assert.equal(blobs, before + 1, "only the verified draw is encoded");
    set(base, "b"); mode = "solid"; reads = 0;
    assert.equal(await thumb(base, "face"), null);
    assert.equal(reads, 6, "a persistently blank frame leaves the slot empty");
    mode = "ready";
    assert.ok(await thumb(base, "face"), "a later attempt can recover; blank output was never cached");
  } finally { spine.SpinePlayer = Player; }
});

test("the encoded thumbnail retains its validated portrait while the background load clears the live canvas", async () => {
  const create = document.createElement, Image = globalThis.Image;
  const base = spineBase("mod", "validated_background_race_spr"), encoded = [];
  const portrait = { width: 2, height: 1, ink: true };
  let backgroundStarted = false, finishBackground;
  document.createElement = (tag) => tag === "canvas" ? {
    ink: false,
    getContext() { return { drawImage: (image) => { if ("ink" in image) this.ink = image.ink; } }; },
    toBlob(done) { encoded.push(this.ink); done({}); },
  } : { ...el(), querySelector: () => portrait };
  globalThis.Image = class {
    naturalWidth = 100; naturalHeight = 100;
    set src(value) {
      this.url = value; backgroundStarted = true;
      finishBackground = () => this.onload?.();
    }
    get src() { return this.url; }
  };
  try {
    set(base, "a");
    const work = thumb(base, "face", null, false, null, "/bg/validated-race");
    await new Promise(setImmediate);
    assert.equal(backgroundStarted, true);
    portrait.ink = false; // The renderer clears after validation, while the background remains pending.
    finishBackground();
    assert.ok(await work);
    assert.deepEqual(encoded, [true], "encode the frozen validated draw, never the later blank live canvas");
  } finally { await new Promise(setImmediate); document.createElement = create; globalThis.Image = Image; }
});
