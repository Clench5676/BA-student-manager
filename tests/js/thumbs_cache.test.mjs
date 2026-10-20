import assert from "node:assert/strict";
import { test } from "node:test";
import { spineBase, spineAssetBase } from "../../src/ba_modding_toolkit/web/js/api.js";
import { thumb, forget } from "../../src/ba_modding_toolkit/web/js/thumbs.js";

const revisions = new Map();
const loaded = [], requests = [], posed = [];
let blobs = 0, animations = ["Idle_01"];
const el = () => ({
  style: {}, appendChild() {}, remove() {},
  querySelector: () => ({ toBlob: (done) => done({}) }),
});
globalThis.document = { body: el(), createElement: el };
globalThis.requestAnimationFrame = (done) => queueMicrotask(done);
globalThis.URL.createObjectURL = () => `blob:thumb-${++blobs}`;
globalThis.URL.revokeObjectURL = () => {};
globalThis.fetch = async (url, options) => {
  requests.push([url, options]);
  const revision = revisions.get(url);
  return { ok: !!revision, json: async () => ({ revision }) };
};
globalThis.spine = {
  Vector2: class {}, Physics: { update: 0 },
  SpinePlayer: class {
    constructor(_el, config) {
      loaded.push(config);
      this.config = config;
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
      queueMicrotask(() => config.success(this));
    }
    setViewport() {}
    dispose() {}
  },
};
const set = (base, value) => revisions.set(base.replace(/skeleton$/, "manifest.json"), value.repeat(64));

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
