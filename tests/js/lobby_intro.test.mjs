// Tests for web/js/lobby-intro.js (the memorial lobby's intro timeline), the particle player's hooks it uses
// (particles.js Effects.restart / stop, overrides, spriteGeometry) and lobby-dof.js's blur spacing. Run by
// tests/test_intro.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

const I = await import("../../src/ba_modding_toolkit/web/js/lobby-intro.js");
const P = await import("../../src/ba_modding_toolkit/web/js/particles.js");
const Dof = await import("../../src/ba_modding_toolkit/web/js/lobby-dof.js");

const near = (a, b, eps = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} != ${b}`);

// Shiroko's flash sprite alpha as the game stores it (a streamed curve: the first key is the value before the clip)
const GLOW = { s: [[-1e9, 0, 0, 0, 1], [0, 0.25, -0.75, 0, 1], [2, 0, 0, 0, 0]] };

test("curves: streamed cubic segments, dense frames, constants", () => {
  near(I.evaluate(GLOW, -1), 1);
  near(I.evaluate(GLOW, 0), 1);
  near(I.evaluate(GLOW, 0.5), 0.84375);
  near(I.evaluate(GLOW, 1.4333), 0.25 * 1.4333 ** 3 - 0.75 * 1.4333 ** 2 + 1);
  near(I.evaluate(GLOW, 2), 0);
  near(I.evaluate(GLOW, 50), 0); // held after its last key
  const dense = { d: [1, 10, [0, 1, 3]] };
  near(I.evaluate(dense, 0), 0);
  near(I.evaluate(dense, 1.05), 0.5);
  near(I.evaluate(dense, 1.15), 2);
  near(I.evaluate(dense, 9), 3);
  assert.equal(I.evaluate({ k: 4.5 }, 3), 4.5);
});

test("a GameObject's activity: rest, its curve, activation and control clips", () => {
  const n = { own: false, curve: null, control: [], activation: null };
  assert.equal(I.activeAt(n, 1), false);
  n.curve = { s: [[-1e9, 0, 0, 0, 0], [2.8333, 0, 0, 0, 1], [4.1667, 0, 0, 0, 0]] }; // Shiroko's depth of field
  assert.deepEqual([1, 3, 5].map((t) => I.activeAt(n, t)), [false, true, false]);
  // a control clip switches its GameObject on for the clip and off once it has ended
  const c = { own: true, curve: null, control: [{ t: 2, d: 1 }], activation: null };
  assert.deepEqual([1, 2.5, 3.5].map((t) => I.activeAt(c, t)), [true, true, false]);
  // an activation track: on during a clip, off outside
  const a = { own: true, curve: null, control: [], activation: [[1, 1]] };
  assert.deepEqual([0.5, 1.5, 2.5].map((t) => I.activeAt(a, t)), [false, true, false]);
});

test("moved transforms: local matrices and the chain around them", () => {
  // Hoshino's background: position and scale animated, rotation at rest
  const n = { trs: [0, -962, 0, 0, 0, 0, 1, 100, 100, 100],
    position: [{ k: 10 }, { k: -2428 }, null], scale: [{ k: 228.85 }, { k: 228.85 }, { k: 228.85 }] };
  const L = I.localAt(n, 1);
  near(L[0], 228.85); near(L[5], 228.85); near(L[3], 10); near(L[7], -2428);
  // Euler angles in degrees (z then x then y, as Quaternion.Euler)
  const e = I.localAt({ trs: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1], euler: [null, null, { k: 90 }] }, 0);
  near(e[0], 0, 1e-9); near(e[1], -1, 1e-9); near(e[4], 1, 1e-9);
  // M0 L M1: the parent's matrix, the animated node, what lies below it
  const W = I.compose({ m: [[1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0], [2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0]], nodes: [0] },
    () => [1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1, 0]);
  assert.deepEqual(W, [2, 0, 0, 6, 0, 2, 0, 3, 0, 0, 2, 0]);
});

const volumes = () => [
  { weight: 1, priority: 0, global: true, enabled: true, active: true, layer: true, components: [
    { name: "ChromaticAberration", active: true, params: { intensity: 0.2 } },
    { name: "DepthOfField", active: false, params: { mode: 1, gaussianEnd: 7000 } }] },
  { weight: 0, priority: 0, global: true, enabled: true, active: true, layer: true, components: [
    { name: "ColorAdjustments", active: true, params: { postExposure: 6 } }] },
  { weight: 0, priority: 0, global: true, enabled: true, active: false, layer: true, components: [
    { name: "DepthOfField", active: true, params: { mode: 1, gaussianStart: 0, gaussianEnd: 0, gaussianMaxRadius: 1.5 } }] },
];

test("the volumes blend as URP's VolumeManager does (lobby.py post_processing)", () => {
  const v = volumes();
  assert.deepEqual(I.blend(v), { chromaticAberration: 0.2 });
  v[1].weight = 0.3; // the flash: post exposure lerped from 0 by the weight
  const post = I.blend(v);
  near(post.colorAdjustments.postExposure, 1.8);
  assert.deepEqual(post.colorAdjustments.colorFilter, [1, 1, 1]);
  // the depth of field volume switched on: Gaussian at once (a mode does not lerp), its radius lerped from 1
  v[2].active = true;
  v[2].weight = 0.5;
  const dof = I.blend(v).dof;
  near(dof.radius, 1.25);
  near(dof.start, 5); near(dof.end, 15);
  // nothing that does not take part: weight 0, disabled, another layer, not global
  for (const change of [{ weight: 0 }, { enabled: false }, { layer: false }, { global: false }]) {
    const w = volumes();
    Object.assign(w[0], change);
    assert.deepEqual(I.blend(w), {}, JSON.stringify(change));
  }
  // by priority: the higher one last
  const p = volumes();
  p[1].weight = 1;
  p.push({ weight: 1, priority: 1, global: true, enabled: true, active: true, layer: true,
    components: [{ name: "ColorAdjustments", active: true, params: { postExposure: 2 } }] });
  near(I.blend(p).colorAdjustments.postExposure, 2);
});

// a stand-in for spine's AnimationState: the calls a clip start makes
function state(current = { animation: { name: "Idle_01" } }) {
  const calls = [], tracks = [current];
  const entry = (name, loop) => ({ animation: { name }, loop, trackTime: 0, timeScale: 1, mixDuration: 0.2, alpha: 1, holdPrevious: false });
  return {
    calls, tracks, data: { defaultMix: 0.2 },
    getCurrent: (t) => tracks[t] || null,
    setEmptyAnimation: (t, mix) => { calls.push(["empty", t, mix]); tracks[t] = { animation: { name: "<empty>" } }; return tracks[t]; },
    setAnimationWith: (t, a, loop) => { calls.push(["set", t, a.name, loop]); return (tracks[t] = entry(a.name, loop)); },
    addAnimationWith: (t, a, loop, delay) => { calls.push(["add", t, a.name, loop, delay]); return (tracks[t] = entry(a.name, loop)); },
  };
}
const data = { findAnimation: (n) => (["Start_Idle_01", "Idle_01"].includes(n) ? { name: n } : null) };

test("a Spine clip starts as spine-unity's mixer starts it", () => {
  // the skeleton's default mix without a custom duration, from where the clip is
  let st = state();
  let e = I.startClip(st, data, 0, { t: 0, d: 6, anim: "Start_Idle_01", loop: false, mix: null, speed: 1 }, 0.05, 1 / 60);
  assert.deepEqual(st.calls, [["set", 0, "Start_Idle_01", false]]);
  near(e.trackTime, 0.05 - 1 / 60); // the AnimationState adds the frame right after
  assert.equal(e.mixDuration, 0.2);
  // a custom mix (the timeline clip's blend, else its own)
  st = state();
  e = I.startClip(st, data, 0, { t: 6.1667, d: 3, anim: "Idle_01", loop: true, mix: 0, speed: 1 }, 6.1667, 0);
  assert.equal(e.mixDuration, 0);
  assert.equal(e.loop, true);
  // an empty track fades in from the setup pose: an empty animation first
  st = state(null);
  I.startClip(st, data, 0, { t: 0, d: 1, anim: "Idle_01", loop: true, mix: 0.1, speed: 1 }, 0, 0);
  assert.deepEqual(st.calls, [["empty", 0, 0], ["add", 0, "Idle_01", true, 0]]);
  // no animation: the track empties; an unknown one changes nothing
  st = state();
  assert.equal(I.startClip(st, data, 2, { t: 0, d: 1, anim: null, mix: null }, 0, 0), null);
  assert.deepEqual(st.calls, [["empty", 2, 0.2]]);
  st = state();
  assert.equal(I.startClip(st, data, 0, { t: 0, d: 1, anim: "Nope", mix: null }, 0, 0), null);
  assert.deepEqual(st.calls, []);
  assert.deepEqual(I.playingAt([{ t: 0, d: 2 }, { t: 2, d: 1 }], 2).map((c) => c.t), [2]);
});

// a fake player: a layer, an AnimationState, a parent element
function player(name, layer = {}) {
  const st = state();
  const cls = new Set();
  return { bamtLayer: { name, x: 0, y: -962, scale: 1, ...layer }, animationState: st, skeleton: { data },
    parent: { style: {}, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) } } };
}

// an intro with a flash sprite, a control clip playing a particle system, a moved scene skeleton and two sounds
function intro(wrap = "none") {
  return {
    duration: 4, wrap, idle: 3,
    nodes: [{ path: "FX", own: false }, { path: "Scene", own: true, trs: [0, -962, 0, 0, 0, 0, 1, 100, 100, 100] }],
    spine: [{ skeleton: "A_home", track: 0, clips: [
      { t: 0, d: 3, in: 0, speed: 1, anim: "Start_Idle_01", loop: false, mix: null, endMix: 0.1, end: true },
      { t: 3, d: 1, in: 0, speed: 1, anim: "Idle_01", loop: true, mix: 0, endMix: 0.1, end: false }] }],
    props: [
      { on: "sprite", i: 0, attr: "color", k: 3, c: { s: [[-1e9, 0, 0, 0, 1], [0, 0, 0, -1, 1], [1, 0, 0, 0, 0]] } },
      { on: "node", i: 1, attr: "position", k: 0, c: { s: [[-1e9, 0, 0, 0, 500], [0, 0, 0, -500, 500], [1, 0, 0, 0, 0]] } },
      { on: "system", i: 0, attr: "speed", k: 0, c: { k: 2 } },
    ],
    control: [{ node: 0, t: 1, d: 2, in: 0.5, particles: true }],
    activation: [], sounds: [{ t: 0.5, id: "s1" }, { t: 2, id: "s2" }], icons: [[0, false], [2.5, true]],
  };
}
function env(over = {}) {
  let stamp = 0;
  const calls = [], played = [], cleared = [];
  const sys = { def: { name: "fx", gate: [0], base: true, rest: 0, playOnAwake: 1, main: { color: { col: [1, 1, 1, 1] } } },
    particles: [], playing: false };
  const effects = { systems: [sys], restart: (s, pre) => calls.push(["restart", s.def.name, +pre.toFixed(4)]),
    stop: (s) => calls.push(["stop", s.def.name]) };
  const sprite = { def: { color: [1, 1, 1, 0], static: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], rest: 1 }, visible: true, color: [1, 1, 1, 0] };
  const listeners = {};
  const host = { addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: (k) => { delete listeners[k]; } };
  const a = player("A_home"), scene = player("Scene", { moves: { m: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]], nodes: [1], of: "static" } });
  scene.bamtLayer.scale = 1;
  return { calls, played, cleared, sys, sprite, listeners, a, scene, effects,
    env: { layers: [{ name: "Scene", player: scene, introOnly: false }, { name: "A_home", player: a, introOnly: false }],
      fx: { effects, sprites: [sprite] }, post: { chromaticAberration: 0.1 }, host,
      sfx: (id, set) => { played.push(id); set.add({ pause: () => cleared.push(id) }); },
      clear: () => {}, screen: () => {}, visible: () => true, now: () => stamp, ...over },
    tick: (ctl, dt) => { stamp += 1; ctl.frame(a, dt); ctl.frame(scene, dt); } };
}

test("the intro plays: clock, sprite, control clip, moved skeleton, sounds, Spine clips, then puts back (wrap None)", () => {
  const t = env(), ctl = I.create(intro(), t.env);
  t.tick(ctl, 0); // the first frame on screen: time 0
  let s = ctl.state();
  assert.equal(s.started, true);
  assert.equal(s.t, 0);
  assert.deepEqual(s.sprites[0].color, [1, 1, 1, 1]);
  assert.equal(t.scene.bamtLayer.x, 500); // moved by its transform (scale from rest: 100 x 0.01)
  near(t.scene.bamtLayer.scale, 1);
  assert.deepEqual(t.a.animationState.calls, [["set", 0, "Start_Idle_01", false]]);
  assert.equal(t.sys.speed, 2);
  for (let i = 0; i < 6; i++) t.tick(ctl, 0.1); // 0.6 s
  assert.deepEqual(t.played, ["s1"]);
  near(ctl.state().sprites[0].color[3], 0.4, 1e-4);
  // the control clip: the system starts at the clip's start, its clip-in seconds in, and stops at its end
  for (let i = 0; i < 5; i++) t.tick(ctl, 0.1); // 1.1 s
  assert.deepEqual(t.calls, [["restart", "fx", 0.6]]);
  for (let i = 0; i < 20; i++) t.tick(ctl, 0.1); // 3.1 s
  assert.deepEqual(t.calls, [["restart", "fx", 0.6], ["stop", "fx"]]);
  assert.deepEqual(t.played, ["s1", "s2"]);
  assert.deepEqual(t.a.animationState.calls.map((c) => c[2]), ["Start_Idle_01", "Idle_01"]);
  for (let i = 0; i < 10; i++) t.tick(ctl, 0.1); // past its end: put back
  s = ctl.state();
  assert.equal(s.finished, true);
  assert.equal(t.scene.bamtLayer.x, 0);
  assert.equal(t.sys.speed, undefined);
  assert.deepEqual(t.sprite.color, [1, 1, 1, 0]);
  assert.equal(t.a.animationState.tracks[0].animation.name, "Idle_01"); // the idle keeps playing after it
  return ctl.done();
});

test("a tap skips the intro to its end; Hold keeps its last frame", () => {
  const t = env(), ctl = I.create(intro("hold"), t.env);
  t.tick(ctl, 0);
  t.tick(ctl, 0.6);
  assert.deepEqual(t.played, ["s1"]);
  let stopped = false;
  t.listeners.pointerdown({ stopImmediatePropagation: () => { stopped = true; }, preventDefault: () => {} });
  assert.equal(stopped, true);
  const s = ctl.state();
  assert.equal(s.finished, true);
  assert.equal(s.skipped, true);
  assert.deepEqual(t.cleared, ["s1"]); // its sounds stop, the ones still to come never play
  assert.deepEqual(t.played, ["s1"]);
  // held: the last frame's values stay (the scene where its curve ends, the sprite at 0)
  assert.equal(t.scene.bamtLayer.x, 0);
  assert.deepEqual(t.sprite.color, [1, 1, 1, 0]);
  assert.equal(t.sys.speed, 2);
  // the clip playing at the end started (the idle), at its time in the clip
  assert.equal(t.a.animationState.tracks[0].animation.name, "Idle_01");
  assert.equal(t.listeners.pointerdown, undefined);
});

test("the intro waits until the lobby is on screen, and the setting off goes straight to its end", () => {
  let on = false;
  const t = env({ visible: () => on }), ctl = I.create(intro(), t.env);
  t.tick(ctl, 0.5);
  t.tick(ctl, 0.5);
  assert.equal(ctl.state().started, false);
  on = true;
  t.tick(ctl, 0.5);
  assert.equal(ctl.state().t, 0);
  t.tick(ctl, 0.5);
  assert.equal(ctl.state().t, 0.5);
  const off = env(), skipped = I.create(intro(), off.env);
  skipped.skip();
  assert.equal(skipped.state().finished, true);
  assert.deepEqual(off.played, []);
  assert.equal(off.scene.bamtLayer.x, 0);
});

test("particle systems: off at rest, restarted with a pre-simulation, stopped with their sub-emitters", () => {
  const sys = (over) => ({ main: { duration: 1, loop: 1, prewarm: 0, delay: 0, speedScale: 1, space: 0, scaling: 0, life: 10,
    speed: 0, size: [1], rotation: [0], flipRotation: 0, color: { col: [1, 1, 1, 1] }, gravity: 0, max: 1000 },
  emission: { rate: 10, dist: 0, bursts: [] }, shape: null, modules: {}, renderer: { mode: 0, streams: { uv: [0, 2] } },
  playOnAwake: 1, material: "m", rel: P.IDENTITY, static: P.IDENTITY, ls: [1, 1, 1], z: 0, ...over });
  const fx = new P.Effects({ systems: [sys({ rest: 0, subs: [{ type: 0, system: 1, inherit: 0, p: 1 }] }), sys({ isSub: 1 })] },
    { random: () => 0.5, seed: 1 });
  const [a, b] = fx.systems;
  assert.equal(a.playing, false);
  fx.update(0.5);
  assert.equal(a.particles.length, 0);
  fx.restart(a, 0.5);
  assert.equal(a.playing, true);
  assert.equal(a.particles.length, 5); // 10 a second for half a second
  a.speed = 2; // the intro's simulation speed
  fx.update(0.1);
  assert.equal(a.particles.length, 7);
  a.startColor = { col: [1, 0, 0, 1] };
  fx.update(0.1);
  assert.deepEqual(a.particles.at(-1).color, [1, 0, 0, 1]);
  b.particles.push({});
  fx.stop(a);
  assert.equal(a.playing, false);
  assert.deepEqual([a.particles.length, b.particles.length], [0, 0]);
  // its place: an intro's own static matrix
  a.static = [1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, 0];
  fx.place();
  assert.equal(a.W[3], 7);
});

test("a sprite's quad: its rect around the pivot through its matrix, its UVs and colour", () => {
  const def = { quad: [-0.5, -0.5, 0.5, 0.5], uv: [0, 0, 1, 0.88], flip: [0, 0] };
  const { data, count } = P.spriteGeometry(def, [100, 0, 0, 10, 0, 50, 0, 0, 0, 0, 1, 0], [1, 1, 1, 0.5]);
  assert.equal(count, 6);
  const v = (i) => data.slice(i * P.STRIDE, (i + 1) * P.STRIDE);
  assert.deepEqual([...v(0).slice(0, 4)], [-40, -25, 0, 0]);
  assert.deepEqual([...v(2).slice(0, 4)].map((x) => +x.toFixed(4)), [60, 25, 1, 0.88]);
  // white decodes to white; alpha as it is, 8-bit like the vertex stream's Color32
  assert.deepEqual([...v(0).slice(14, 18)].map((x) => +x.toFixed(4)), [1, 1, 1, +(128 / 255).toFixed(4)]);
  const flipped = P.spriteGeometry({ ...def, flip: [1, 0] }, P.IDENTITY, [1, 1, 1, 1]).data;
  assert.equal(flipped[2], 1); // u of the left corner
});

test("the depth of field's taps scale with the game screen (1.333 x radius at 1080p)", () => {
  near(Dof.tapPixels(1.5, 1920), 1.33333333 * 1.5 * (1920 / 1080));
  near(Dof.tapPixels(1, 1080), 1.33333333);
});
