// Tests for web/js/particles.js (the lobby particle simulation and its geometry) and web/js/particles-gl.js (drawing
// into a player's context and freeing it again, against a recording stand-in for WebGL2). Run by
// tests/test_particles_player.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

const P = await import("../../src/ba_modding_toolkit/web/js/particles.js");
const { Effects, value, colorAt, shapePoint, geometry, vertexColor, slotOf, drawOrder, STRIDE, WORLD, IDENTITY } = P;

const near = (a, b, eps = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} != ${b}`);
// a seeded 0..1 source, so every run emits the same particles
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
// a system as particles.py exports it, with neutral defaults
function sys(over = {}) {
  const base = {
    main: { duration: 1, loop: 1, prewarm: 0, delay: 0, speedScale: 1, space: 0, scaling: 0, life: 10, speed: 0, size: [1],
      rotation: [0], flipRotation: 0, color: { col: [1, 1, 1, 1] }, gravity: 0, max: 1000 },
    emission: { rate: 0, dist: 0, bursts: [] }, shape: null, modules: {},
    renderer: { mode: 0, align: 0, sort: 0, minSize: 0, maxSize: 0.5, lengthScale: 2, velocityScale: 0, pivot: [0, 0, 0],
      flip: [0, 0, 0], streams: { uv: [0, 2] } },
    playOnAwake: 1, material: "m", queue: 3000, order: 0, layer: 0, name: "s", path: "s", anchor: null,
    rel: IDENTITY, static: IDENTITY, ls: [1, 1, 1], z: 0,
  };
  const out = { ...base, ...over };
  for (const k of ["main", "emission", "renderer"]) out[k] = { ...base[k], ...(over[k] || {}) };
  return out;
}
const effects = (systems, opts = {}) => new Effects({ systems }, { seed: 7, random: lcg(3), ...opts });
const run = (fx, seconds, dt = 0.1) => { for (let t = 0; t < seconds - 1e-9; t += dt) fx.update(dt); };

test("MinMaxCurves and gradients", () => {
  assert.equal(value(2.5, 0.3, 0.9), 2.5);
  assert.equal(value({ r: [1, 3] }, 0, 0.5), 2);
  // an AnimationCurve with flat tangents eases between its keys, times its multiplier
  near(value({ c: [[0, 0, 0, 0], [1, 2, 0, 0]], k: 1 }, 0.5, 0), 1);
  near(value({ c: [[0, 1, 0, 0]], c0: [[0, 0, 0, 0]], k: 2 }, 0.5, 0.25), 0.5);
  assert.deepEqual(colorAt({ col: [1, 0.5, 0, 1] }, 0.3, 0.2), [1, 0.5, 0, 1]);
  assert.deepEqual(colorAt({ r: [[0, 0, 0, 0], [1, 1, 1, 1]] }, 0, 0.25), [0.25, 0.25, 0.25, 0.25]);
  const g = { c: [[0, 1, 0, 0], [1, 0, 0, 1]], a: [[0, 0], [1, 1]], fixed: 0 };
  assert.deepEqual(colorAt({ g }, 0.5, 0), [0.5, 0, 0.5, 0.5]);
  // fixed mode: the first key at or after t
  assert.deepEqual(colorAt({ g: { ...g, fixed: 1 } }, 0.5, 0), [0, 0, 1, 1]);
  // a random colour of the gradient
  assert.deepEqual(colorAt({ g, pick: 1 }, 0.9, 0), [1, 0, 0, 0]);
});

test("stepped curves: a segment with an infinite tangent (null) holds its left key's value", () => {
  // misaki_home's wate_flow1 (velocity over lifetime y): every key past the first has Constant tangents
  const keys = [[0, 0, 0, 0], [0.21129, -0.61894, null, null], [0.41147, -0.11064, null, null], [0.631, -0.86394, null, null],
    [1, -1, 0, 0]];
  const c = { c: keys, k: 1 };
  assert.equal(value(c, 0.1, 0), 0, "held up to the next key (its in-slope is infinite)");
  assert.equal(value(c, 0.21129, 0), -0.61894, "a key's own time starts its segment");
  assert.equal(value(c, 0.3, 0), -0.61894);
  assert.equal(value(c, 0.5, 0), -0.11064);
  assert.equal(value(c, 0.9, 0), -0.86394, "the left out-slope alone steps the last segment");
  assert.equal(value(c, 1, 0), -1);
  // random between two stepped curves, times the multiplier
  near(value({ c: keys, c0: [[0, 1, 0, 0], [1, 1, 0, 0]], k: 2 }, 0.3, 0.5), 2 * (1 + (-0.61894 - 1) * 0.5));
  // finite tangents still ease: a straight ramp with slope 1
  near(value({ c: [[0, 0, 1, 1], [1, 1, 1, null]], k: 1 }, 0.5, 0), 0.5);
  near(value({ c: [[0, 0, 1, 1], [1, 1, 1, 1]], k: 1 }, 0.25, 0), 0.25);
  assert.equal(P.curve([[0, 0, 0, 0], [1, 1, null, 0]], 0.75), 0);
});

test("a loop's burst at 0 fires every loop at 60 fps and right after a prewarm", () => {
  const one = { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] };
  // ch0209's Flare_par: 120 frames of 1/60 s add up to a hair under its 2 s loop
  const flare = effects([sys({ main: { duration: 2, life: 100 }, emission: one })]);
  run(flare, 7, 1 / 60);
  assert.equal(flare.count(), 4, "the loops at 0, 2, 4 and 6 s");
  // izuna's water_Flare_00 (twice the speed) and tsurugi's Smoke_00: a prewarmed 5 s loop of one 5 s particle. The
  // prewarm's 150 steps of 1/30 s end a hair under 5 s; the next loop's particle is there from the first frame on
  for (const speedScale of [1, 2]) {
    const smoke = effects([sys({ main: { duration: 5, life: 5, prewarm: 1, speedScale }, emission: one })]);
    const counts = [];
    for (let f = 0; f < 60 * 12; f++) { smoke.update(1 / 60); if (f % 30 === 15) counts.push(smoke.count()); }
    assert.deepEqual([...new Set(counts)], [1], `speed ${speedScale}: every half second`);
  }
  // hibiki's boke_L: a 7 s loop of three 8 s particles shows six at each loop's start, the prewarm's among them
  const boke = effects([sys({ main: { duration: 7, life: 8, prewarm: 1 }, emission: { bursts: [{ ...one.bursts[0], n: 3 }] } })]);
  boke.update(1 / 60);
  assert.equal(boke.count(), 6);
  // each burst once: frames of 1/16 s end exactly on the bursts (0, 0.5, 1 ... 3 s), which fire in the frame they end
  const exact = effects([sys({ main: { duration: 1, life: 100 }, emission: { bursts: [{ t: 0, n: 1, cycles: 2, interval: 0.5, p: 1 }] } })]);
  run(exact, 3, 1 / 16);
  assert.equal(exact.count(), 7);
  exact.update(1 / 16);
  assert.equal(exact.count(), 7, "not again in the next frame");
});

test("a prewarm simulates exactly one duration", () => {
  // ch0294's F_star_3: a 0.05 s loop, shorter than the prewarm's 1/30 s step
  const star = effects([sys({ main: { duration: 0.05, prewarm: 1, life: 100 }, emission: { bursts: [{ t: 0.04, n: 1, cycles: 1, interval: 0.01, p: 1 }] } })]);
  star.update(0);
  near(star.systems[0].clock.time, 0.05, 1e-12, "after the prewarm");
  star.update(1 / 30);
  assert.equal(star.count(), 1, "the next loop's burst (0.09 s) is still ahead at 0.083 s");
  // 2.01 s: sixty steps of 1/30 s and one of 0.01 s
  const odd = effects([sys({ main: { duration: 2.01, prewarm: 1 }, emission: { rate: 10 } })]);
  odd.update(0);
  near(odd.systems[0].clock.time, 2.01, 1e-9, "after the prewarm");
});

test("rate over time and bursts with cycles, looping or not", () => {
  const rate = effects([sys({ emission: { rate: 10 } })]);
  run(rate, 1);
  // ten a second (the last one may wait for the next frame)
  assert.ok(rate.count() >= 9 && rate.count() <= 10, `rate ${rate.count()}`);
  const loop = effects([sys({ emission: { bursts: [{ t: 0.25, n: 3, cycles: 2, interval: 0.5, p: 1 }] } })]);
  run(loop, 1);
  assert.equal(loop.count(), 6);
  run(loop, 1);
  assert.equal(loop.count(), 12);
  const once = effects([sys({ main: { loop: 0 }, emission: { bursts: [{ t: 0, n: 5, cycles: 1, interval: 0.01, p: 1 }] } })]);
  once.update(0.016);
  assert.equal(once.count(), 5, "a burst at 0 fires on the first frame");
  run(once, 2);
  assert.equal(once.count(), 5);
  assert.equal(once.systems[0].done, true);
});

test("prewarm, start delay, max particles and lifetime", () => {
  const warm = effects([sys({ main: { prewarm: 1 }, emission: { rate: 10 } })]);
  warm.update(0);
  assert.ok(warm.count() >= 9 && warm.count() <= 10, `prewarmed ${warm.count()}`);
  const late = effects([sys({ main: { delay: 0.5 }, emission: { rate: 10 } })]);
  run(late, 0.5);
  assert.equal(late.count(), 0);
  run(late, 0.5);
  assert.ok(late.count() >= 4 && late.count() <= 5, `after the delay ${late.count()}`);
  const capped = effects([sys({ main: { max: 3 }, emission: { rate: 100 } })]);
  run(capped, 1);
  assert.equal(capped.count(), 3);
  const short = effects([sys({ main: { life: 0.5 }, emission: { rate: 10 } })]);
  run(short, 3);
  assert.ok(short.count() >= 4 && short.count() <= 6, `alive ${short.count()}`);
  // a system that does not play on awake (or a sub-emitter) emits nothing by itself
  const idle = effects([sys({ playOnAwake: 0, emission: { rate: 10 } }), sys({ isSub: 1, emission: { rate: 10 } })]);
  run(idle, 1);
  assert.equal(idle.count(), 0);
});

test("ring buffer: particles held at their end or looping their lifetime until max particles replaces them", () => {
  const one = { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] };
  // pause until replaced (ch0334's boosters: one particle a second, never looping): held at the end of its life
  const held = effects([sys({ main: { loop: 0, life: 1, speed: 1, ring: 1, ringRange: [0, 1] }, emission: one,
    shape: { type: 4, angle: 0, radius: 0, thickness: 1, arc: 360, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], randomDir: 0, spherical: 0, randomPos: 0 } })]);
  run(held, 3);
  const h = held.systems[0].particles;
  assert.equal(h.length, 1);
  near(h[0].age, 1, 1e-9, "held at its lifetime");
  const at = h[0].pos.slice();
  run(held, 1);
  assert.deepEqual(h[0].pos, at, "a held particle does not move");
  near(held.current(held.systems[0], h[0]).size[0], 1, 1e-9);
  // loop until replaced (ch0188's sea meshes): the age runs through the loop range again and again
  const looped = effects([sys({ main: { loop: 0, life: 2, ring: 2, ringRange: [0.25, 0.75] }, emission: one })]);
  run(looped, 1.6);
  const l = looped.systems[0].particles;
  assert.equal(l.length, 1);
  near(l[0].age, 0.6, 1e-6, "1.6 s: at 1.5 s it went back to 0.5 s");
  run(looped, 10);
  assert.equal(l.length, 1);
  assert.ok(l[0].age >= 0.5 - 1e-9 && l[0].age < 1.5, `in the loop range ${l[0].age}`);
  // with max particles reached, a new particle takes the oldest one's place; without a ring buffer it is not emitted
  const full = effects([sys({ main: { max: 2, life: 100, ring: 1, ringRange: [0, 1] }, emission: { rate: 10 } })]);
  run(full, 1);
  const kept = full.systems[0].particles;
  assert.equal(kept.length, 2);
  assert.ok(kept.every((p) => p.age < 0.5), "the newest two");
  const plain = effects([sys({ main: { max: 2, life: 100 }, emission: { rate: 10 } })]);
  run(plain, 1);
  assert.ok(plain.systems[0].particles.every((p) => p.age > 0.5), "the first two");
  // without a ring buffer a particle dies at the end of its life
  const mortal = effects([sys({ main: { loop: 0, life: 1 }, emission: one })]);
  run(mortal, 1.5);
  assert.equal(mortal.count(), 0);
});

test("a particle that dies is replaced in the same frame; one emitted within a frame moves for the rest of it", () => {
  // hibiki_home's River_surface and BackGround_*: one particle at most, 60 a second, living 1 and 5 s. Emitted before
  // the old one was gone, the new one waited a frame and the bottom-left corner blinked dark once a second
  const frames = {
    "60 Hz": () => 1 / 60,
    "75 Hz": () => 1 / 75,
    // spine-player's frame times are Date.now() differences, whole milliseconds
    "60 Hz in whole ms": ((ms = [16, 17, 17], i = 0) => () => ms[i++ % 3] / 1000)(),
    "120 Hz in whole ms": ((ms = [8, 8, 9], i = 0) => () => ms[i++ % 3] / 1000)(),
    "144 Hz in whole ms": ((i = 0) => () => (Math.floor((++i * 1000) / 144) - Math.floor(((i - 1) * 1000) / 144)) / 1000)(),
  };
  for (const [label, next] of Object.entries(frames)) {
    const fx = effects([1, 5].map((life) => sys({ main: { prewarm: 1, life, max: 1 }, emission: { rate: 60 } })));
    let empty = 0;
    for (let t = 0; t < 12;) {
      const dt = next();
      t += dt;
      fx.update(dt);
      empty += fx.systems.filter((s) => !s.particles.length).length;
    }
    assert.equal(empty, 0, `${label}: frames without a particle`);
  }
  // 25 a second over a 0.1 s frame: emitted at 0.04 and 0.08 s, so 0.06 and 0.02 s old at its end and moved as far
  const fx = effects([sys({ main: { speed: 1 }, emission: { rate: 25 } })]);
  fx.update(0.1);
  const ps = fx.systems[0].particles;
  assert.equal(ps.length, 2);
  ps.forEach((p, i) => { near(p.age, [0.06, 0.02][i], 1e-9, "age"); near(p.pos[2], [0.06, 0.02][i], 1e-9, "distance"); });
});

test("shapes emit inside their volume, on their surface or edge, along their direction", () => {
  const r = lcg(9);
  for (let i = 0; i < 200; i++) {
    const box = shapePoint({ type: 5, radius: 1, thickness: 1, arc: 360 }, r);
    assert.ok(box.p.every((v) => Math.abs(v) <= 0.5) && box.d[2] === 1);
    const circle = shapePoint({ type: 10, radius: 2, thickness: 1, arc: 360 }, r);
    assert.ok(Math.hypot(circle.p[0], circle.p[1]) <= 2 + 1e-9 && circle.p[2] === 0);
    const ring = shapePoint({ type: 11, radius: 2, thickness: 1, arc: 360 }, r);
    near(Math.hypot(ring.p[0], ring.p[1]), 2, 1e-9, "circle edge");
    const sphere = shapePoint({ type: 0, radius: 3, thickness: 0, arc: 360 }, r);
    near(Math.hypot(...sphere.p), 3, 1e-9, "sphere surface");
    const cone = shapePoint({ type: 4, radius: 1, thickness: 1, angle: 25, arc: 360 }, r);
    assert.ok(cone.p[2] === 0 && cone.d[2] > Math.cos((26 * Math.PI) / 180));
    const edge = shapePoint({ type: 12, radius: 4, thickness: 1, arc: 360 }, r);
    assert.ok(Math.abs(edge.p[0]) <= 4 && edge.p[1] === 0 && edge.d[1] === 1);
  }
  // shape position, rotation and scale place the points
  const fx = effects([sys({ emission: { rate: 50 }, shape: { type: 5, radius: 1, thickness: 1, arc: 360, arcMode: 0, pos: [10, 0, 0],
    rot: [0, 0, 0], scale: [2, 4, 0], randomDir: 0, spherical: 0, randomPos: 0 } })]);
  fx.update(0.1);
  for (const p of fx.systems[0].particles) assert.ok(Math.abs(p.pos[0] - 10) <= 1 && Math.abs(p.pos[1]) <= 2 && p.pos[2] === 0);
});

test("a system under a bone follows it in local space, stays behind in world space", () => {
  const anchor = { skeleton: "Home", bone: "FX", go: [100, 0, 0, 0, 0, 100, 0, -962, 0, 0, 100, 0], ds: 0.01 };
  let bone = { a: 1, b: 0, c: 0, d: 1, worldX: 200, worldY: 300 };
  const defs = [sys({ anchor, emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] } }),
    sys({ anchor, main: { space: 1 }, emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] } })];
  const fx = effects(defs, { bone: (skeleton, name) => (skeleton === "Home" && name === "FX" ? bone : null) });
  fx.update(0.016);
  const at = (s) => { const g = geometry(fx, fx.systems[s]); return [(g.data[0] + g.data[2 * STRIDE]) / 2, (g.data[1] + g.data[2 * STRIDE + 1]) / 2]; };
  // skeleton units x 0.01 to Unity units, x 100 on the skeleton GameObject, which sits 962 units down
  assert.deepEqual(fx.systems[0].W.slice(0, 12).filter((_, i) => i % 4 === 3), [200, -662, 0]);
  assert.deepEqual(at(0).map(Math.round), [200, -662]);
  bone = { ...bone, worldX: 250 };
  fx.update(0.016);
  assert.deepEqual(at(0).map(Math.round), [250, -662]);
  assert.deepEqual(at(1).map(Math.round), [200, -662]);
});

test("velocity over lifetime: linear, orbital, radial and the speed modifier; limit velocity; gravity", () => {
  const one = { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] };
  const linear = effects([sys({ emission: one, modules: { velocity: { x: 0, y: 10, z: 0, orbitalX: 0, orbitalY: 0, orbitalZ: 0,
    orbitalOffsetX: 0, orbitalOffsetY: 0, orbitalOffsetZ: 0, radial: 0, speed: 0.5, world: 0 } } })]);
  run(linear, 1);
  near(linear.systems[0].particles[0].pos[1], 5, 1e-6, "linear y");
  // a quarter turn a second around z, from (1, 0): exactly (0, 1) after one second whatever the steps
  const orbit = effects([sys({ emission: one, shape: { type: 5, radius: 1, thickness: 1, arc: 360, pos: [1, 0, 0], rot: [0, 0, 0],
    scale: [0, 0, 0], randomDir: 0, spherical: 0, randomPos: 0 },
  modules: { velocity: { x: 0, y: 0, z: 0, orbitalX: 0, orbitalY: 0, orbitalZ: Math.PI / 2, orbitalOffsetX: 0, orbitalOffsetY: 0,
    orbitalOffsetZ: 0, radial: 0, speed: 1, world: 0 } } })]);
  orbit.update(0.001);
  run(orbit, 1);
  const p = orbit.systems[0].particles[0].pos;
  near(Math.hypot(p[0], p[1]), 1, 1e-9, "orbit radius");
  near(Math.atan2(p[1], p[0]), (Math.PI / 2) * 1.001, 1e-6, "orbit angle");
  // limit velocity with full dampening: never faster than the limit
  const limited = effects([sys({ emission: one, main: { speed: 100 }, shape: { type: 5, radius: 1, thickness: 1, arc: 360, pos: [0, 0, 0],
    rot: [0, 0, 0], scale: [0, 0, 0], randomDir: 0, spherical: 0, randomPos: 0 },
  modules: { limit: { speed: 2, dampen: 1, drag: 0, sep: 0, world: 0 } } })]);
  run(limited, 1);
  near(limited.systems[0].particles[0].pos[2], 2, 1e-6, "limited distance");
  // gravity pulls in Unity world units (the UI root's 2-unit-high view)
  const falling = effects([sys({ emission: one, main: { gravity: 1, space: 1 } })]);
  run(falling, 1);
  near(falling.systems[0].particles[0].vel[1], -9.81 * WORLD, 1e-6, "gravity");
});

test("colour, size and rotation over lifetime; texture sheet frames", () => {
  const one = { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] };
  const fx = effects([sys({ emission: one, main: { life: 2, color: { col: [1, 0.5, 0.5, 1] } }, modules: {
    color: { g: { c: [[0, 1, 1, 1], [1, 1, 1, 1]], a: [[0, 1], [1, 0]], fixed: 0 } },
    size: { x: { c: [[0, 0, 1, 1], [1, 1, 1, 1]], k: 2 }, sep: 0 },
    rotation: { z: Math.PI, sep: 0 },
    sheet: { x: 2, y: 2, type: 0, rowMode: 1, row: 0, frame: 0.25, start: 0.25, cycles: 1, time: 0, fps: 30 },
  } })]);
  run(fx, 1);
  const s = fx.systems[0], cur = fx.current(s, s.particles[0]);
  near(cur.color[3], 0.5, 1e-6, "alpha over lifetime");
  near(cur.color[1], 0.5, 1e-6, "start colour kept");
  near(cur.size[0], 1, 1e-6, "size over lifetime");
  near(cur.rot[2], Math.PI, 1e-6, "rotation over lifetime");
  // a quarter of the sheet over time plus a quarter to start: the third tile, the bottom left one of a 2 x 2 sheet
  assert.equal(cur.frame, 2);
  const g = geometry(fx, s);
  const uvs = [0, 1, 2, 4].map((v) => [g.data[v * STRIDE + 2], g.data[v * STRIDE + 3]]);
  assert.deepEqual(uvs, [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]);
  // a random start frame over the whole sheet reaches every tile
  const many = effects([sys({ emission: { rate: 400 }, modules: {
    sheet: { x: 2, y: 2, type: 0, rowMode: 1, row: 0, frame: 0, start: { r: [0, 0.9999] }, cycles: 1, time: 0, fps: 30 } } })]);
  run(many, 0.5);
  const tiles = new Set(many.systems[0].particles.map((p) => many.current(many.systems[0], p).frame));
  assert.deepEqual([...tiles].sort(), [0, 1, 2, 3]);
});

test("sub-emitters spawn at their parent while it lives and burst where it dies", () => {
  const parent = sys({ main: { life: 0.5, speed: 100 }, emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] },
    shape: { type: 5, radius: 1, thickness: 1, arc: 360, pos: [0, 0, 0], rot: [0, 0, 0], scale: [0, 0, 0], randomDir: 0, spherical: 0, randomPos: 0 },
    subs: [{ type: 0, system: 1, inherit: 0, p: 1 }, { type: 2, system: 2, inherit: 0, p: 1 }] });
  const trail = sys({ isSub: 1, emission: { rate: 20 } });
  const pop = sys({ isSub: 1, main: { life: 5 }, emission: { bursts: [{ t: 0, n: 4, cycles: 1, interval: 0.01, p: 1 }] } });
  const fx = effects([parent, trail, pop]);
  run(fx, 0.4);
  const [, t] = fx.systems;
  assert.ok(t.particles.length >= 6, `trail ${t.particles.length}`);
  // each spawned where the parent was: along +z as it flew
  assert.ok(t.particles.every((p) => p.pos[2] > 0 && p.pos[2] <= 40 + 1e-6));
  assert.equal(fx.systems[2].particles.length, 0);
  run(fx, 0.3);
  assert.equal(fx.systems[0].particles.length, 0);
  assert.equal(fx.systems[2].particles.length, 4);
  for (const p of fx.systems[2].particles) assert.ok(p.pos[2] >= 40 && p.pos[2] <= 50, `death burst at ${p.pos[2]}`);
});

test("geometry: billboard size, the view's max size, stretch and meshes; vertex colours", () => {
  const one = { bursts: [{ t: 0, n: 1, cycles: 1, interval: 0.01, p: 1 }] };
  const scaled = [100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0];
  const quad = (over) => {
    const fx = effects([sys({ emission: one, static: scaled, ...over })]);
    fx.update(0.016);
    const g = geometry(fx, fx.systems[0]);
    const xs = [], ys = [];
    for (let v = 0; v < g.count; v++) { xs.push(g.data[v * STRIDE]); ys.push(g.data[v * STRIDE + 1]); }
    // a copy: geometry() fills one buffer again on every call
    return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), g: { data: g.data.slice(), count: g.count } };
  };
  const plain = quad({ main: { size: [2] } });
  assert.equal(plain.g.count, 6);
  near(plain.w, 200, 1e-6, "width"); near(plain.h, 200, 1e-6, "height");
  // no bigger than half the game view's height
  const big = quad({ main: { size: [20] } });
  near(big.h, 0.5 * 1665, 1e-6, "max size");
  // stretched along the velocity: size x length scale long
  const stretched = quad({ main: { size: [1], speed: 1 }, renderer: { mode: 1, lengthScale: 3 },
    shape: { type: 12, radius: 0, thickness: 1, arc: 360, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], randomDir: 0, spherical: 0, randomPos: 0 } });
  near(stretched.h, 300, 1e-3, "stretched length"); near(stretched.w, 100, 1e-3, "stretched width");
  const fx = effects([sys({ emission: one, static: scaled, renderer: { mode: 4, mesh: "tri" } })]);
  fx.update(0.016);
  const g = geometry(fx, fx.systems[0], { meshes: { tri: { v: [0, 0, 0, 1, 0, 0, 0, 1, 0], i: [0, 1, 2], uv: [0, 0, 1, 0, 0, 1] } } });
  assert.equal(g.count, 3);
  assert.deepEqual([g.data[STRIDE], g.data[STRIDE + 1], g.data[2 * STRIDE], g.data[2 * STRIDE + 1]].map(Math.round), [100, 0, 0, 100]);
  // a billboard's normal faces the camera; a mesh's turns with the particle (a quarter turn about y here)
  assert.deepEqual([...plain.g.data.slice(18, 21)], [0, 0, -1]);
  const turned = effects([sys({ emission: one, static: scaled, main: { rotation: [0, Math.PI / 2, 0] }, renderer: { mode: 4, mesh: "tri" } })]);
  turned.update(0.016);
  const tg = geometry(turned, turned.systems[0], { meshes: { tri: { v: [0, 0, 0, 1, 0, 0, 0, 1, 0], i: [0, 1, 2], n: [0, 0, -1, 0, 0, -1, 0, 0, -1] } } });
  assert.deepEqual([...tg.data.slice(18, 21)].map((v) => Math.round(v * 1e6) / 1e6 + 0), [-1, 0, 0]);
  // a mesh particle's colour times the mesh's vertex colours (ch0188's sea meshes fade out at their ends by them)
  const tinted = effects([sys({ emission: one, static: scaled, main: { color: { col: [1, 0.5, 1, 0.8] } }, renderer: { mode: 4, mesh: "tri" } })]);
  tinted.update(0.016);
  const cg = geometry(tinted, tinted.systems[0], { linear: false, meshes: { tri: { v: [0, 0, 0, 1, 0, 0, 0, 1, 0], i: [0, 1, 2],
    c: [1, 1, 1, 1, 1, 1, 1, 0, 0.5, 1, 1, 0.5] } } });
  const colours = [0, 1, 2].map((v) => [...cg.data.slice(v * STRIDE + 14, v * STRIDE + 18)].map((x) => Math.round(x * 255)));
  assert.deepEqual(colours, [[255, 128, 255, 204], [255, 128, 255, 0], [128, 128, 255, 102]]);
  // the vertex colour: clamped to 8 bits (Color32), then decoded from sRGB in linear light; alpha as it is
  assert.deepEqual(vertexColor([2, 0.5, -1, 0.25], false), [1, 128 / 255, 0, 64 / 255]);
  near(vertexColor([1, 0.5, 0, 1], true)[1], 0.2158605, 1e-6, "linear");
});

test("a mesh renderer's meshes: one per particle, uniformly at random or by their weights", () => {
  // ch0095's rain streaks (four meshes) and lobbyayane_multi's confetti (two triangles): a mesh per particle
  const tri = { v: [0, 0, 0, 1, 0, 0, 0, 1, 0], i: [0, 1, 2] }, quad = { v: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], i: [0, 1, 2, 2, 3, 0] };
  const meshes = { tri, quad };
  const many = { bursts: [{ t: 0, n: 400, cycles: 1, interval: 0.01, p: 1 }] };
  const drawn = (renderer) => {
    const fx = effects([sys({ emission: many, renderer: { mode: 4, mesh: "tri", ...renderer } })]);
    fx.update(0.016);
    const s = fx.systems[0], picks = s.particles.map((pt) => P.meshIndex(s.def.renderer, pt.seed));
    // the geometry draws each particle's own mesh
    const g = geometry(fx, s, { meshes });
    assert.equal(g.count, picks.reduce((n, k) => n + [3, 6][k], 0));
    return picks.filter((k) => k === 1).length / picks.length;
  };
  assert.equal(drawn({}), 0, "one mesh");
  const uniform = drawn({ meshes: ["tri", "quad"] });
  assert.ok(uniform > 0.4 && uniform < 0.6, `uniform ${uniform}`);
  const weighted = drawn({ meshes: ["tri", "quad"], weights: [1, 3] });
  assert.ok(weighted > 0.65 && weighted < 0.85, `weighted ${weighted}`);
  assert.equal(drawn({ meshes: ["tri", "quad"], weights: [0, 1] }), 1);
  // a particle keeps its mesh from frame to frame; four meshes are all drawn
  const four = { meshes: ["a", "b", "c", "d"] }, seeds = Array.from({ length: 4000 }, (_, k) => k * 7919);
  const share = [0, 1, 2, 3].map((m) => seeds.filter((sd) => P.meshIndex(four, sd) === m).length / seeds.length);
  assert.ok(share.every((x) => x > 0.2 && x < 0.3), `shares ${share}`);
  assert.equal(P.meshIndex(four, 12345), P.meshIndex(four, 12345));
  // a listed mesh that is missing draws nothing
  const fx = effects([sys({ emission: many, renderer: { mode: 4, mesh: "tri", meshes: ["tri", "gone"] } })]);
  fx.update(0.016);
  assert.equal(geometry(fx, fx.systems[0], { meshes }).count, 0);
});

test("sort modes draw the oldest or the youngest particles on top", () => {
  const fx = effects([sys({ emission: { rate: 10 }, renderer: { sort: 2 } })]);
  run(fx, 1);
  const s = fx.systems[0];
  const n = s.particles.length;
  s.particles.forEach((p, i) => { p.color = [i / n, 0, 0, 1]; });
  const firstRed = () => geometry(fx, s, { linear: false }).data[14]; // the first vertex's red
  // oldest in front: the youngest (emitted last) is drawn first
  near(firstRed(), Math.round(((n - 1) / n) * 255) / 255, 1e-6, "youngest first");
  s.def.renderer.sort = 3;
  near(firstRed(), 0, 1e-6, "oldest first");
});

test("draw order against the skeletons: sorting order, render queue, then back to front", () => {
  const layers = [{ order: -1, queue: 2900, z: 0 }, { order: 0, queue: 2900, z: 0 }];
  assert.deepEqual(slotOf({ order: 0, queue: 3100, z: 0 }, layers), { layer: 1, part: 0 });
  assert.deepEqual(slotOf({ order: -2, queue: 3100, z: 0 }, layers), { layer: 0, part: -1 });
  assert.deepEqual(slotOf({ order: -1, queue: 3000, z: 0 }, layers), { layer: 0, part: 0 });
  assert.deepEqual(slotOf({ order: 0, queue: 2800, z: 0 }, layers), { layer: 0, part: 0 });
  const systems = [{ def: { order: 1, queue: 3000, z: 0 }, index: 0 }, { def: { order: 0, queue: 3100, z: 5 }, index: 1 },
    { def: { order: 0, queue: 3100, z: 10 }, index: 2 }, { def: { order: 0, queue: 3000, z: 0 }, index: 3 }];
  assert.deepEqual(drawOrder(systems).map((s) => s.index), [3, 2, 1, 0]);
});

test("a skeleton whose atlas pages sit in several render queues draws in parts, the effects between them by queue", () => {
  // hibiki_home: the background page at 2900, Hibiki's at 3050; the river surface and most bokeh at 3000 (order 0),
  // a few bokeh at order 1
  const hibiki = { order: 0, queue: 2900, pages: { Hibiki_home: 3050, Hibiki_home2: 2900 }, z: 0 };
  assert.deepEqual(P.queuesOf(hibiki), [2900, 3050]);
  assert.deepEqual(P.queuesOf({ order: 0, queue: 2950, z: 0 }), [2950], "a layer without pages: its own queue");
  assert.deepEqual(P.queuesOf({ pages: {} }), [3000]);
  assert.deepEqual(slotOf({ order: 0, queue: 3000, z: 0 }, [hibiki]), { layer: 0, part: 0 }, "over the river, under her");
  assert.deepEqual(slotOf({ order: 1, queue: 3000, z: 0 }, [hibiki]), { layer: 0, part: 1 }, "over everything");
  assert.deepEqual(slotOf({ order: 0, queue: 2800, z: 0 }, [hibiki]), { layer: 0, part: -1 });
  assert.deepEqual(slotOf({ order: 0, queue: 3050, z: 0 }, [hibiki]), { layer: 0, part: 1 }, "a tie draws after");
  // ch0356_home: the scenery at 2900, Kisaki at 3100, the mist in front of her at 3200
  const kisaki = { order: 0, queue: 2900, pages: { CH0356_home: 3100, CH0356_home_2: 3200, CH0356_home_3: 2900, CH0356_home_4: 2900 }, z: 0 };
  assert.deepEqual(P.queuesOf(kisaki), [2900, 3100, 3200]);
  assert.deepEqual(slotOf({ order: 0, queue: 2950, z: 0 }, [kisaki]), { layer: 0, part: 0 });
  assert.deepEqual(slotOf({ order: 0, queue: 3100, z: 0 }, [kisaki]), { layer: 0, part: 1 });
  // across layers: the last part of any layer that sorts before the system
  const bg = { order: -1, queue: 2900, pages: { bg: 2900, sky: 2800 }, z: 0 };
  assert.deepEqual(slotOf({ order: -1, queue: 2850, z: 0 }, [bg, hibiki]), { layer: 0, part: 0 });
  assert.deepEqual(slotOf({ order: 0, queue: 2950, z: 0 }, [bg, hibiki]), { layer: 1, part: 0 });
});

test("the sorting fudge pushes a system back (above 0) or forward (below 0) among the same queue", () => {
  // hibiki_home's systems at queue 3000: the glows and the river surface (fudge 50 and 80) behind the bokeh (-10)
  const systems = [{ def: { order: 0, queue: 3000, z: 0, fudge: -10 }, index: 0 }, { def: { order: 0, queue: 3000, z: 0, fudge: 50 }, index: 1 },
    { def: { order: 0, queue: 3000, z: 0 }, index: 2 }, { def: { order: 0, queue: 3000, z: 0, fudge: 80 }, index: 3 }];
  assert.deepEqual(drawOrder(systems).map((s) => s.index), [3, 1, 2, 0]);
  // in world units: a fudge of 1 outweighs a z of WORLD / 2 lobby units nearer
  const pushed = { def: { order: 0, queue: 3000, z: -WORLD / 2, fudge: 1 }, index: 0 }, flat = { def: { order: 0, queue: 3000, z: 0 }, index: 1 };
  assert.deepEqual(drawOrder([flat, pushed]).map((s) => s.index), [0, 1]);
  // and against a part of the same queue: behind it with a fudge above 0, after it otherwise
  const layer = { order: 0, queue: 2900, pages: { a: 2900, b: 3000 }, z: 0 };
  assert.deepEqual(slotOf({ order: 0, queue: 3000, z: 0, fudge: 50 }, [layer]), { layer: 0, part: 0 });
  assert.deepEqual(slotOf({ order: 0, queue: 3000, z: 0, fudge: -5 }, [layer]), { layer: 0, part: 1 });
});

test("a system on a later sorting layer draws over every skeleton on Default, whatever its order and queue", () => {
  // aru_home's dust (layer value 2, queue 3000) over Aru's pages (3000) and her scene skeleton
  const aru = { sortingLayer: 0, order: 0, queue: 3000, pages: { a: 3000, b: 3100 }, z: 0 };
  const scene = { order: 1, queue: 3200, z: 0 };
  assert.deepEqual(slotOf({ sortingLayer: 2, order: -5, queue: 2000, z: 0 }, [aru, scene]), { layer: 1, part: 0 });
  assert.deepEqual(slotOf({ order: -5, queue: 2000, z: 0 }, [aru, scene]), { layer: 0, part: -1 }, "on Default: below");
  const systems = [{ def: { sortingLayer: 2, order: -1, queue: 2900, z: 0 }, index: 0 }, { def: { order: 3, queue: 3100, z: 0 }, index: 1 }];
  assert.deepEqual(drawOrder(systems).map((s) => s.index), [1, 0]);
});

test("Apply Active Color Space off: the vertex colours reach the shader as stored, not decoded from sRGB", () => {
  const fx = effects([sys({ emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 1, p: 1 }] }, main: { color: { col: [0.5, 0.25, 1, 0.5] } } }),
    sys({ emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 1, p: 1 }] }, main: { color: { col: [0.5, 0.25, 1, 0.5] } },
      renderer: { colorSpace: 0 } })]);
  fx.update(0.016);
  const colour = (s) => Array.from(geometry(fx, s, { linear: true }).data.subarray(14, 18));
  const [on, off] = fx.systems.map(colour);
  near(on[0], vertexColor([0.5], true)[0], 1e-6, "converted");
  assert.ok(on[0] < 0.25 && on[3] === off[3]);
  assert.deepEqual(off.map((c) => +c.toFixed(4)), vertexColor([0.5, 0.25, 1, 0.5], false).map((c) => +c.toFixed(4)));
  // outside linear light nothing is decoded either way
  near(Array.from(geometry(fx, fx.systems[0], { linear: false }).data.subarray(14, 15))[0], 128 / 255, 1e-6);
});

test("SpineEventToggleObjects: a system below a toggled GameObject plays from its start while it is on", () => {
  const burst = { bursts: [{ t: 0, n: 2, cycles: 1, interval: 1, p: 1 }] };
  const fish = sys({ name: "bubble", emission: burst, toggle: [[0, 1]], subs: [{ type: 0, system: 2, inherit: 0, p: 1 }] });
  const always = sys({ name: "loop", emission: burst });
  const trail = sys({ name: "trail", isSub: 1, emission: { rate: 10, bursts: [] }, toggle: [[0, 1]] });
  const fx = new Effects({ systems: [fish, always, trail], toggles: [{ skeleton: "CH0217_home", on: [0, 0] }] },
    { seed: 7, random: lcg(3) });
  const [s, loop, sub] = fx.systems;
  run(fx, 0.5);
  assert.equal(s.live, false);
  assert.equal(s.particles.length, 0, "inactive in the prefab: nothing until its event");
  assert.equal(loop.particles.length, 2);
  // other events, another skeleton's, an index outside the list: nothing changes
  assert.equal(fx.spineEvent("CH0217_home", "Talk", 1), false);
  assert.equal(fx.spineEvent("Other_home", "EnableObject", 1), false);
  assert.equal(fx.spineEvent("CH0217_home", "EnableObject", 7), false);
  assert.equal(fx.spineEvent("CH0217_home", "EnableObject", 0), false, "an object no system hangs below");
  assert.equal(fx.spineEvent("CH0217_home", "EnableObject", 1), true);
  fx.update(0.016);
  assert.equal(s.particles.length, 2, "its burst at 0 fires on the first step");
  assert.equal(sub.instances.length, 2, "and its birth sub-emitter runs");
  run(fx, 0.5);
  const kept = s.particles.slice();
  assert.equal(fx.spineEvent("CH0217_home", "EnableObject", 1), false, "already active: SetActive does nothing");
  assert.equal(s.particles[0], kept[0]);
  assert.equal(fx.spineEvent("CH0217_home", "DisableObject", 1), true);
  assert.equal(s.particles.length + sub.particles.length + sub.instances.length, 0, "gone at once");
  assert.ok(kept.every((pt) => pt.dead));
  run(fx, 0.5);
  assert.equal(s.particles.length, 0);
  assert.equal(loop.particles.length, 4, "the others play on (a burst a loop)");
  // switched on again: from the start, prewarmed where it prewarms
  s.def.main.prewarm = 1;
  s.def.emission = { rate: 4, bursts: [] };
  fx.spineEvent("CH0217_home", "EnableObject", 1);
  assert.equal(s.particles.length, 4, "one duration of 4 a second, simulated at once");
});

test("arc and edge modes: loop and ping-pong over the system's time, burst spread evenly, snapped to the spread", () => {
  assert.equal(P.along(0, 0, 1, 0.3, 1, null), null, "random: the shape draws");
  near(P.along(1, 0, 1, 0.3, 1, null), 0.3);
  near(P.along(1, 0, 2, 0.3, 1, null), 0.6, 1e-9, "at the mode's speed");
  near(P.along(2, 0, 1, 0.75, 1, null), 0.5, 1e-9, "ping-pong on its way back");
  assert.deepEqual([0, 1, 2, 3].map((i) => P.along(3, 0, 1, 0, 1, { i, n: 4 })), [0, 0.25, 0.5, 0.75]);
  near(P.along(3, 0.12, 1, 0, 1, { i: 1, n: 5 }), 0.24, 1e-9, "0.2 snapped to the nearest multiple of 0.12");
  // CH0069's halo: one burst of 5 on a cone's rim, burst spread round the full arc; Hibiki's bokeh: bursts on an
  // edge spread by the radius's mode
  const halo = sys({ emission: { bursts: [{ t: 0, n: 4, cycles: 1, interval: 1, p: 1 }] },
    shape: { type: 4, radius: 2, thickness: 0, angle: 0, arc: 360, arcMode: 3, arcSpread: 0, arcSpeed: 1, pos: [0, 0, 0],
      rot: [0, 0, 0], scale: [1, 1, 1], randomDir: 0, spherical: 0, randomPos: 0 } });
  const edge = sys({ emission: { bursts: [{ t: 0, n: 2, cycles: 1, interval: 1, p: 1 }] },
    shape: { type: 12, radius: 3, thickness: 1, arc: 360, arcMode: 0, radiusMode: 3, radiusSpread: 0, radiusSpeed: 1,
      pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], randomDir: 0, spherical: 0, randomPos: 0 } });
  const fx = effects([halo, edge]);
  fx.update(0.016);
  const angles = fx.systems[0].particles.map((pt) => Math.round((Math.atan2(pt.pos[1], pt.pos[0]) * 180) / Math.PI));
  assert.deepEqual(angles, [0, 90, 180, -90]);
  assert.deepEqual(fx.systems[1].particles.map((pt) => +pt.pos[0].toFixed(6)), [-3, 0], "from one end, evenly");
  assert.equal(shapePoint({ type: 12, radius: 4, arc: 360 }, () => 0.5, 0.9, 0.25).p[0], -2, "an edge takes the edge position");
});

test("rate over distance: particles per world unit the system's origin moves", () => {
  let x = 0;
  const bone = () => ({ a: 1, b: 0, c: 0, d: 1, worldX: x, worldY: 0 });
  const anchor = { skeleton: "Car_home", bone: "car", go: IDENTITY, ds: 1 };
  const fx = effects([sys({ anchor, emission: { rate: 0, dist: 8, bursts: [] } })], { bone });
  fx.update(0.016);
  assert.equal(fx.systems[0].particles.length, 0, "standing still: none");
  x = WORLD / 2;
  fx.update(0.016);
  assert.equal(fx.systems[0].particles.length, 4, "half a world unit at 8 a unit");
  x = WORLD / 2 + WORLD / 8; // an eighth of a unit more: one more particle
  fx.update(0.016);
  assert.equal(fx.systems[0].particles.length, 5);
});

test("colour by speed: the gradient at the particle's travel speed within its range", () => {
  const fade = { g: { c: [[0, 1, 1, 1], [1, 1, 1, 1]], a: [[0, 1], [1, 0]], fixed: 0 } };
  const fx = effects([sys({ main: { speed: 1 }, shape: null, emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 1, p: 1 }] },
    modules: { colorBySpeed: { color: fade, range: [0, 4] }, velocity: { x: 0, y: 0, z: 2, speed: 0.5 } } })]);
  run(fx, 0.2);
  const s = fx.systems[0], pt = s.particles[0];
  near(pt.speed, 1.5, 1e-9, "(1 + 2) x the speed modifier 0.5");
  near(fx.current(s, pt).color[3], 1 - 1.5 / 4, 1e-9);
});

test("sort by distance or depth: the farthest particles first", () => {
  const fx = effects([sys({ emission: { rate: 10 }, renderer: { sort: 4 } })]);
  run(fx, 1);
  const s = fx.systems[0];
  s.particles.forEach((p, i) => { p.pos[2] = i % 3; p.color = [p.pos[2] / 2, 0, 0, 1]; });
  const reds = [];
  const g = geometry(fx, s, { linear: false });
  for (let v = 0; v < g.count; v += 6) reds.push(g.data[v * STRIDE + 14]);
  assert.ok(reds.every((r, i) => i === 0 || r <= reds[i - 1]), "z 2, then 1, then 0");
  assert.equal(reds[0], 1);
});

test("trails: points every min vertex distance, living their share of the particle's life, a ribbon behind it", () => {
  const white = { col: [1, 1, 1, 1] };
  const trail = { ratio: 1, life: 0.5, minDist: 1, texMode: 0, world: 0, die: 1, sizeWidth: 1, sizeLife: 0, inherit: 1,
    color: { col: [1, 0.5, 1, 1] }, width: { c: [[0, 1, 0, 0], [1, 0, 0, 0]], k: 0.5 }, colorTrail: { g: { c: [[0, 1, 1, 1], [1, 1, 1, 1]], a: [[0, 1], [1, 0]], fixed: 0 } } };
  const def = sys({ main: { loop: 0, speed: 10, life: 2, color: white, size: [2] }, shape: null, modules: { trail },
    emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 1, p: 1 }] }, trailMaterial: "dirt", trailQueue: 2950 });
  const fx = effects([def]);
  const s = fx.systems[0];
  fx.update(0.016);
  const pt = s.particles[0];
  assert.equal(pt.trail.length, 1, "its first point where it is born");
  run(fx, 0.5, 0.05);
  // 10 units a second along +z: a point every unit, kept for half its 2 s life
  assert.ok(pt.trail.length >= 5 && pt.trail.length <= 6, `${pt.trail.length} points`);
  run(fx, 1, 0.05);
  const ages = pt.trail.map((v) => pt.age - v.t);
  assert.ok(Math.max(...ages) <= 1 + 1e-9 && pt.trail.length >= 9, "older than 1 s: gone");
  // seen from the camera along z the ribbon has no length: turn the system so it runs along x
  s.def.static = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0];
  fx.place();
  const g = P.trailGeometry(fx, s, { linear: false });
  // two triangles a segment, from the particle through its points (one it has just left at its place counts once)
  const head = pt.trail[pt.trail.length - 1].p, fresh = Math.hypot(...head.map((v, i) => v - pt.pos[i])) < 1e-9;
  assert.equal(g.count, 6 * (pt.trail.length - (fresh ? 1 : 0)));
  const at = (v, k) => g.data[v * STRIDE + k];
  // at the particle: u 0, the full width (0.5 x its size 2), the trail colour times the particle's
  near(at(0, 2), 0, 1e-9, "u");
  near(Math.abs(at(0, 1) - at(1, 1)), 1, 1e-6, "width");
  assert.deepEqual([at(0, 14), at(0, 15), at(0, 16), at(0, 17)].map((c) => +c.toFixed(3)), [1, 0.502, 1, 1]);
  // at the end: u 1, no width, faded out
  const last = g.count - 2;
  near(at(last, 2), 1, 1e-9);
  near(at(last, 17), 0, 1e-9);
  // without the module, or without particles, nothing
  assert.equal(P.trailGeometry(fx, effects([sys()]).systems[0]).count, 0);
});

test("a particle that stays put until its trail's points have all gone starts the trail again where it is", () => {
  const trail = { ratio: 1, life: 0.1, minDist: 1, texMode: 0, world: 0, die: 1, sizeWidth: 1, sizeLife: 0, inherit: 1,
    color: { col: [1, 1, 1, 1] }, width: { k: 1 }, colorTrail: { col: [1, 1, 1, 1] } };
  const def = sys({ main: { loop: 0, speed: 0, life: 4, color: { col: [1, 1, 1, 1] }, size: [1] }, shape: null, modules: { trail },
    emission: { bursts: [{ t: 0, n: 1, cycles: 1, interval: 1, p: 1 }] }, trailMaterial: "dirt", trailQueue: 2950 });
  const fx = effects([def]);
  const s = fx.systems[0];
  fx.update(0.016);
  const pt = s.particles[0];
  // standing still for longer than the trail's 0.4 s: its first point goes, a new one is left where it stands
  run(fx, 1, 0.05);
  assert.ok(pt.trail.length <= 1 && pt.trail.every((v) => v.p.every((c, i) => Math.abs(c - pt.pos[i]) < 1e-9)));
  assert.equal(P.trailGeometry(fx, s, { linear: false }).count, 0, "no ribbon without a length");
  // moving again (10 units a second): a point every unit from there
  pt.vel = [0, 0, 10];
  run(fx, 0.3, 0.05);
  assert.ok(pt.trail.length >= 3, `${pt.trail.length} points`);
});

// --- particles-gl.js: drawing into a player's context and freeing it -------------------------------------------------

class FakeGL {}
globalThis.WebGL2RenderingContext = FakeGL;
function fakeGL() {
  const calls = [], live = new Set();
  let n = 0;
  const target = Object.assign(new FakeGL(), { calls, live, drawingBufferWidth: 64, drawingBufferHeight: 32 });
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return (...args) => {
        calls.push([name, ...args]);
        if (name.startsWith("create")) { const o = { kind: name.slice(6), id: ++n }; live.add(o); return o; }
        if (name.startsWith("delete")) { live.delete(args[0]); return undefined; }
        if (name === "getShaderParameter" || name === "getProgramParameter") return args[1] === "ACTIVE_UNIFORMS" ? 0 : true;
        if (name === "checkFramebufferStatus") return "FRAMEBUFFER_COMPLETE";
        if (name === "isContextLost") return false;
        return null;
      };
    },
  });
}
class Texture { update() {} getImage() { return {}; } }
class Batcher { setBlendMode() {} }
globalThis.spine = { BlendMode: { Normal: 0, Additive: 1 },
  PolygonBatcher: { blendModesGL: [{ srcRgb: 1, srcRgbPma: 1, dstRgb: 2, srcAlpha: 1 }, { srcRgb: 1, srcRgbPma: 1, dstRgb: 1, srcAlpha: 1 }] } };
globalThis.performance ??= { now: () => Date.now() };
const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");
const GL = await import("../../src/ba_modding_toolkit/web/js/particles-gl.js");

function player(gl, layer) {
  const page = Object.assign(new Texture(), { texture: {}, useMipMaps: false });
  return {
    bamtLayer: layer,
    context: { gl, addRestorable() {}, removeRestorable() {} },
    skeleton: { data: { skins: [{ getAttachments: () => [{ attachment: { region: { texture: page } } }] }] } },
    sceneRenderer: { batcher: new Batcher(), camera: { update() {}, projectionView: { values: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } } },
  };
}

test("the effects draw in their layer's context with the game's blend and free everything on detach", async () => {
  const gl = fakeGL(), p = player(gl, { name: "Home", x: 0, y: -962, scale: 1, order: 0, queue: 2900, z: 0 });
  Linear.attach(p);
  const linearObjects = new Set(gl.live);
  const tex = { id: "cab-a_1", name: "glow", w: 4, h: 4, filter: 1, mips: 1, wrap: [1, 0], srgb: 1 };
  const fx = {
    systems: [sys({ material: "add", queue: 3100, emission: { rate: 50 } }), sys({ material: "blend", queue: 2800, emission: { rate: 50 } })],
    materials: {
      add: { program: "additive", src: 1, dst: 1, queue: 3100, tex: { _Texture: { ...tex, st: [1, 1, 0, 0] } }, floats: {}, colors: { _Color: [2, 2, 2, 1] } },
      blend: { program: "alphaBlend", src: 5, dst: 10, queue: 2800, tex: { _Texture: { default: "white", st: [1, 1, 0, 0] } }, floats: { _Multiply: 1 }, colors: {} },
    },
    textures: { "cab-a_1": tex }, meshes: {},
  };
  const loads = [];
  const effects = GL.create(fx, { base: "/asset/spine/lobby/x/", bone: () => null, load: async (url) => { loads.push(url); return { width: 4, height: 4 }; } });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(loads, ["/asset/spine/lobby/x/fx_cab-a_1.png"]);
  effects.layers([p]);
  Linear.begin(p);
  const from = gl.calls.length;
  effects.below(p, 0.1);
  effects.above(p);
  const ours = gl.calls.slice(from);
  Linear.end(p);
  assert.equal(ours.filter(([name]) => name === "drawArrays").length, 2);
  // the alpha-blended system (queue 2800) under the skeleton, the additive one (3100) over it: colour adds, coverage not
  const blends = ours.filter(([name]) => name === "blendFuncSeparate").map((c) => c.slice(1));
  assert.deepEqual(blends, [["SRC_ALPHA", "ONE_MINUS_SRC_ALPHA", "ONE", "ONE_MINUS_SRC_ALPHA"], ["ONE", "ONE", "ZERO", "ONE"]]);
  // the texture as the game samples it: sRGB, mipmapped, clamped in u and repeated in v
  assert.ok(gl.calls.some(([name, , , format]) => name === "texImage2D" && format === "SRGB8_ALPHA8"));
  assert.ok(gl.calls.some(([name]) => name === "generateMipmap"));
  assert.ok(gl.calls.some((c) => c[0] === "texParameteri" && c[2] === "TEXTURE_WRAP_S" && c[3] === "CLAMP_TO_EDGE"));
  const stats = effects.stats();
  assert.equal(stats.contexts, 1);
  assert.ok(stats.particles > 0 && stats.frames === 1);

  effects.detach(p);
  assert.deepEqual([...gl.live].filter((o) => !linearObjects.has(o)), [], "particle objects left");
  effects.dispose();
  assert.equal(effects.stats().particles, 0);
  const before = gl.calls.length;
  effects.below(p, 0.1);
  effects.above(p);
  assert.equal(gl.calls.length, before, "nothing is drawn after dispose");
  Linear.detach(p);
  assert.equal(gl.live.size, 0);
});

test("after a lost context is restored the effects make their GL objects again", async () => {
  const gl = fakeGL(), p = player(gl, { name: "Home", x: 0, y: -962, scale: 1, order: 0, queue: 2900, z: 0 });
  // spine's context: its restorables are called once the canvas gets its context back
  const restorables = [];
  p.context.addRestorable = (r) => restorables.push(r);
  p.context.removeRestorable = (r) => { const i = restorables.indexOf(r); if (i >= 0) restorables.splice(i, 1); };
  Linear.attach(p);
  const tex = { id: "cab-a_1", name: "glow", w: 4, h: 4, filter: 1, mips: 0, wrap: [0, 0], srgb: 1 };
  const fx = {
    systems: [sys({ material: "add", queue: 3100, emission: { rate: 50 } })],
    materials: { add: { program: "additive", src: 1, dst: 1, queue: 3100, tex: { _Texture: { ...tex, st: [1, 1, 0, 0] } }, floats: {}, colors: {} } },
    textures: { "cab-a_1": tex }, meshes: {},
  };
  const effects = GL.create(fx, { base: "/x/", bone: () => null, load: async () => ({ width: 4, height: 4 }) });
  await new Promise((r) => setTimeout(r, 0));
  effects.layers([p]);
  // the particles' calls of one frame, and the objects they bind
  const frame = () => {
    Linear.begin(p);
    const from = gl.calls.length;
    effects.below(p, 0.1);
    effects.above(p);
    const ours = gl.calls.slice(from);
    Linear.end(p);
    return ours;
  };
  const bound = (calls) => calls.filter(([name]) => ["bindVertexArray", "bindBuffer", "bindTexture", "useProgram"].includes(name))
    .map((c) => c[c.length - 1]).filter(Boolean);
  const first = frame();
  assert.equal(first.filter(([name]) => name === "drawArrays").length, 1);
  assert.equal(restorables.length, 2, "linear.js's and the effects'");
  // the context is lost (every object with it), then restored: spine calls the restorables
  gl.live.clear();
  for (const r of [...restorables]) r.restore();
  const second = frame();
  assert.equal(second.filter(([name]) => name === "drawArrays").length, 1);
  const objects = bound(second);
  assert.ok(objects.length >= 4 && objects.every((o) => gl.live.has(o)), "only objects of the restored context are bound");
  assert.ok(["VertexArray", "Buffer", "Texture", "Program"].every((kind) => objects.some((o) => o.kind === kind)));
  assert.equal(effects.stats().contexts, 1);
  // detach takes the restorable back and frees the new objects
  const linearObjects = new Set(gl.live);
  for (const o of objects) linearObjects.delete(o);
  effects.detach(p);
  assert.equal(restorables.length, 1);
  assert.deepEqual([...gl.live].filter((o) => !linearObjects.has(o)), [], "particle objects left");
  effects.dispose();
  Linear.detach(p);
  assert.equal(restorables.length, 0);
  assert.equal(gl.live.size, 0);
});

// a stand-in that also compiles: the uniforms a program declares (from the sources attached to it) are its active
// uniforms, so a draw's uniform calls can be read back by name
function compilingGL() {
  const gl = fakeGL(), sources = new Map(), attached = new Map();
  const uniforms = (prog) => [...new Set((attached.get(prog) || [])
    .flatMap((s) => [...(sources.get(s) || "").matchAll(/uniform \w+ (\w+);/g)].map((m) => m[1])))];
  return new Proxy(gl, {
    get(t, name) {
      if (name === "shaderSource") return (s, src) => { sources.set(s, src); };
      if (name === "attachShader") return (p, s) => { attached.set(p, [...(attached.get(p) || []), s]); };
      if (name === "getProgramParameter") return (p, what) => (what === "ACTIVE_UNIFORMS" ? uniforms(p).length : true);
      if (name === "getActiveUniform") return (p, i) => ({ name: uniforms(p)[i] });
      if (name === "getUniformLocation") return (p, n) => ({ uniform: n });
      return t[name];
    },
  });
}

test("the ported *_1a programs: their vertex stage routes the custom data, the draw passes selectors as stored", () => {
  // only the *_1a programs have a vertex stage of their own (TEXCOORD3.. as the game's vertex programs output them)
  assert.ok(!/v_t3/.test(GL.vertexSource("distort")) && !/v_t3/.test(GL.fragmentSource("distort")));
  for (const [kind, outs] of [["distort1a", 3], ["doubleDistort", 4]]) {
    const vs = GL.vertexSource(kind), fs = GL.fragmentSource(kind);
    for (let i = 3; i < 3 + outs; i++) assert.ok(vs.includes(`out vec4 v_t${i};`) && fs.includes(`in vec4 v_t${i};`), `${kind} v_t${i}`);
    assert.ok(!vs.includes(`v_t${3 + outs};`), `${kind} has ${outs} outputs`);
    // every selector the vertex program reads is a uniform of the vertex stage
    for (const name of vs.match(/_CustomData_\w+/g)) assert.ok(vs.includes(`uniform vec4 ${name};`), name);
  }
  assert.ok(GL.vertexSource("doubleDistort").includes("_CustomData_DistortOffsetR_CD2XYXY"));
  const gl = compilingGL(), p = player(gl, { name: "Home", x: 0, y: -962, scale: 1, order: 0, queue: 2900, z: 0 });
  Linear.attach(p);
  const colors = { _Color: [2, 1, 1, 1], _RTilingxyOffsetzw: [2, 7, 0, 0], _GTilingxyOffsetzw: [3, 11, 0, 0],
    _CustomData_DistortOffsetR_CD2XYXY: [0, 0, 1, 0], _CustomData_DistortPowerG_CD2XYXY: [0, 1, 0, 0] };
  for (const v of GL.PROGRAMS.doubleDistort.vectors) colors[v] ??= [0, 0, 0, 0];
  const white = { default: "white", st: [1, 1, 0, 0] };
  const fx = {
    systems: [sys({ material: "splash", queue: 3100, emission: { rate: 50 } })],
    materials: { splash: { program: "doubleDistort", src: 1, dst: 10, queue: 3100,
      tex: { _Tex_Main: { ...white, st: [0.6, 3, 0.03, -0.73] }, _Tex_Mask: white, _Tex_DistortRG: white },
      floats: { _Tex_Main_Distort: 3, _Tex_Mask_Distort: 0, _RGBRGBA: 1, _Multiply: 1.5, _RDistort_Power_Y: -0.12 }, colors,
      vectors: GL.PROGRAMS.doubleDistort.vectors } },
    textures: {}, meshes: {},
  };
  const effects = GL.create(fx, { base: "/x/", bone: () => null, load: async () => ({}) });
  effects.layers([p]);
  Linear.begin(p);
  const from = gl.calls.length;
  effects.below(p, 0.1);
  effects.above(p);
  const draws = gl.calls.slice(from).filter(([name]) => name === "drawArrays").length;
  Linear.end(p);
  const set = (name) => gl.calls.filter((c) => c[1]?.uniform === name).map((c) => c.slice(2));
  // Vector properties as stored, the HDR colour decoded, floats as they are, the textures' tiling
  assert.deepEqual(set("_CustomData_DistortOffsetR_CD2XYXY"), [[0, 0, 1, 0]]);
  assert.deepEqual(set("_RTilingxyOffsetzw"), [[2, 7, 0, 0]]);
  near(set("_Color")[0][0], Math.pow(2, 2.2), 1e-6, "HDR colour");
  assert.deepEqual(set("_Tex_Main_Distort"), [[3]]);
  assert.deepEqual(set("_RDistort_Power_Y"), [[-0.12]]);
  assert.deepEqual(set("_GDistort_Power_X"), [[0]], "a float the material lacks reads 0");
  assert.deepEqual(set("_Tex_Main_ST"), [[0.6, 3, 0.03, -0.73]]);
  assert.equal(draws, 1);
  effects.detach(p);
  effects.dispose();
  Linear.detach(p);
});

test("the effects between two parts of a skeleton draw only there", async () => {
  const gl = fakeGL(), p = player(gl, { name: "Hibiki_home", x: 0, y: -962, scale: 1, order: 0, queue: 2900,
    pages: { Hibiki_home: 3050, Hibiki_home2: 2900 }, z: 0 });
  Linear.attach(p);
  const white = { _Texture: { default: "white", st: [1, 1, 0, 0] } };
  const fx = {
    systems: [sys({ material: "river", queue: 3000, emission: { rate: 50 } }), sys({ material: "bokeh", queue: 3000, order: 1, emission: { rate: 50 } })],
    materials: { river: { program: "additive", src: 1, dst: 1, queue: 3000, tex: white, floats: {}, colors: {} },
      bokeh: { program: "additive", src: 1, dst: 1, queue: 3000, tex: white, floats: {}, colors: {} } },
    textures: {}, meshes: {},
  };
  const effects = GL.create(fx, { base: "/x/", bone: () => null, load: async () => ({}) });
  effects.layers([p]);
  assert.equal(effects.drawsAfter(p, 0), true, "the river surface after the background page");
  assert.equal(effects.drawsAfter(p, 1), true, "the order 1 bokeh after the whole skeleton");
  assert.equal(effects.drawsAfter(p, 2), false);
  Linear.begin(p);
  const draws = (fn) => { const from = gl.calls.length; fn(); return gl.calls.slice(from).filter(([name]) => name === "drawArrays").length; };
  assert.equal(draws(() => effects.below(p, 0.1)), 0);
  assert.equal(draws(() => effects.between(p, 0)), 1);
  assert.equal(draws(() => effects.above(p)), 1);
  Linear.end(p);
  effects.detach(p);
  effects.dispose();
  assert.equal(effects.drawsAfter(p, 0), false, "nothing after the dispose");
  Linear.detach(p);
});

test("a system's trails draw with their own material where its queue sorts them", async () => {
  // CH0172: oil drops at 3100 over the character (3000), their dirt trails at 2950 between the background and her
  const gl = fakeGL(), p = player(gl, { name: "CH0172_home", x: 0, y: -962, scale: 1, order: 0, queue: 2900,
    pages: { CH0172_home: 3000, CH0172_home_2: 2900 }, z: 0 });
  Linear.attach(p);
  const white = { _Texture: { default: "white", st: [1, 1, 0, 0] } };
  const trail = { ratio: 1, life: 1, minDist: 0.1, texMode: 0, world: 0, die: 1, sizeWidth: 1, sizeLife: 0, inherit: 1,
    color: { col: [1, 1, 1, 1] }, width: 0.5, colorTrail: { col: [1, 1, 1, 1] } };
  const fx = {
    // flying along x (their +z turned to the screen's x)
    systems: [sys({ material: "drop", queue: 3100, trailMaterial: "dirt", trailQueue: 2950, main: { speed: 100 }, modules: { trail },
      emission: { rate: 50 }, static: [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0] })],
    materials: { drop: { program: "additive", src: 1, dst: 1, queue: 3100, tex: white, floats: {}, colors: {} },
      dirt: { program: "alphaBlend", src: 5, dst: 10, queue: 2950, tex: white, floats: { _Multiply: 1 }, colors: {} } },
    textures: {}, meshes: {},
  };
  const effects = GL.create(fx, { base: "/x/", bone: () => null, load: async () => ({}) });
  effects.layers([p]);
  assert.equal(effects.drawsAfter(p, 0), true, "the trails after the background page");
  Linear.begin(p);
  const calls = (fn) => { const from = gl.calls.length; fn(); return gl.calls.slice(from); };
  effects.below(p, 0.1);
  const mid = calls(() => effects.between(p, 0)), top = calls(() => effects.above(p));
  const blends = (list) => list.filter(([name]) => name === "blendFuncSeparate").map((c) => c.slice(1, 3));
  assert.equal(mid.filter(([name]) => name === "drawArrays").length, 1);
  assert.deepEqual(blends(mid), [["SRC_ALPHA", "ONE_MINUS_SRC_ALPHA"]], "the trail material's blend");
  assert.deepEqual(blends(top), [["ONE", "ONE"]], "the drops' own, over her");
  Linear.end(p);
  effects.detach(p);
  effects.dispose();
  Linear.detach(p);
});

// --- skeleton-parts.js: a skeleton drawn one render queue at a time ---------------------------------------------------

const Parts = await import("../../src/ba_modding_toolkit/web/js/skeleton-parts.js");

test("a skeleton draws one part per queue of its pages, each with its own slots, the effects in between", () => {
  const layer = { order: 0, queue: 2900, pages: { Kisaki: 3100, Kisaki_2: 3200, Kisaki_3: 2900, Kisaki_4: 2900 }, z: 0 };
  const parts = Parts.partsOf(layer);
  assert.equal(parts.count, 3);
  assert.deepEqual(["Kisaki_4", "Kisaki_3", "Kisaki", "Kisaki_2", "Other"].map(parts.of), [0, 0, 1, 2, 0]);
  assert.equal(Parts.partsOf({ order: 0, queue: 3000, z: 0 }).count, 1);
  const on = (page) => ({ region: { page: { name: `${page}.png` } } });
  assert.equal(Parts.pageOf(on("Kisaki_2")), "Kisaki_2");
  assert.equal(Parts.pageOf({}), null);
  // the draw order mixes the pages: the front mist (Kisaki_2) sits under her in it, a clipping slot covers both
  const clip = { clipping: true };
  const slots = [["sky", on("Kisaki_4")], ["mist", on("Kisaki_2")], ["clip", clip], ["body", on("Kisaki")], ["river", on("Kisaki_3")],
    ["empty", null]].map(([name, attachment]) => ({ name, attachment }));
  const skeleton = { drawOrder: slots };
  const log = [];
  Parts.drawInParts(skeleton, parts, (k) => log.push([k, slots.filter((s) => s.attachment).map((s) => s.name)]), (k) => log.push(["between", k]));
  assert.deepEqual(log, [
    [0, ["sky", "clip", "river"]], ["between", 0],
    [1, ["clip", "body"]], ["between", 1],
    [2, ["mist", "clip"]],
  ]);
  assert.deepEqual(slots.map((s) => s.attachment && Parts.pageOf(s.attachment)), ["Kisaki_4", "Kisaki_2", null, "Kisaki", "Kisaki_3", null]);
  assert.equal(slots[2].attachment, clip, "every attachment is given back");
  // one part: a single draw, nothing emptied
  const one = [];
  Parts.drawInParts(skeleton, Parts.partsOf({ queue: 3000 }), (k) => one.push([k, slots.filter((s) => s.attachment).length]), () => one.push("between"));
  assert.deepEqual(one, [[0, 5]]);
  // a draw that throws still gives the attachments back
  assert.throws(() => Parts.drawInParts(skeleton, parts, () => { throw new Error("lost context"); }));
  assert.deepEqual(slots.map((s) => !!s.attachment), [true, true, true, true, true, false]);
});
