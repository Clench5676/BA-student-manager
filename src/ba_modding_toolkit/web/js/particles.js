// The memorial lobbies' Unity ParticleSystem effects (dust, glints, petals, Michiru's sparkler), simulated from their
// prefab data (lobby.json "fx", read by gameassets/particles.py). Pure data and simulation, no DOM and no GL:
// particles-gl.js draws what geometry() builds, in the lobby's layer stack.
//
// Space: lobby units are NGUI units around the prefab root (x right, y up, z away from the camera); the game's
// orthographic camera drops z. A system's matrix W maps its own space to lobby units: under a SkeletonUtilityBone
// (Follow) it is the skeleton GameObject times the bone's world transform times the transforms below the bone, else
// the prefab pose. Unity world units are WORLD lobby units (the UI root: the 1665-unit high view is 2 world units
// high); the Local scaling mode, world-space forces and gravity are in world units.
//
// Simulated, by Unity's modules: main (duration, looping, prewarm, start delay, lifetime, speed, size and rotation in
// 1D or 3D, colour, gravity, max particles, simulation space, scaling mode, simulation speed, ring buffer: pause or
// loop until replaced), emission (rate over time, bursts with cycles and probability), shape (sphere, hemisphere,
// cone and cone volume, box with its shell and edges, circle, edge, rectangle, donut: arc, radius thickness,
// position, rotation, scale, random and spherical direction), velocity over lifetime (linear, orbital with offset,
// radial, speed modifier), limit velocity (dampen), force over lifetime, colour, size and rotation over lifetime,
// texture sheet animation (grid: whole sheet or one row), custom data (vectors, colours) and sub-emitters (birth,
// death); mesh particles take their mesh's vertex colours. Not simulated: noise, collision, triggers, lights,
// trails, inherit velocity, rate over distance, limit velocity's drag, the by-speed modules and external forces (none
// is used by more than one lobby); a system keeps drawing without them.

import { curve, toLinear } from "./touch-fx.js";

export const WORLD = 1665 / 2;      // lobby units per Unity world unit
export const VIEW_H = 1665;         // the game's view height in lobby units (max particle size is a fraction of it)
const GRAVITY = -9.81;              // Physics.gravity.y, world units / s^2
const PREWARM_STEP = 1 / 30;
const MAX_DT = 0.1;
const DAMPEN_FPS = 30;              // limit velocity's dampen is per frame at this rate (frame-rate independent)
const EPS = 1e-9;                   // seconds: emission times this close count as the same

// --- values ---------------------------------------------------------------------------------------------------------

// a MinMaxCurve (particles.py curve) at normalized time t with the particle's random r
export function value(c, t, r) {
  if (typeof c === "number") return c;
  if (!c) return 0;
  if (c.r) return c.r[0] + (c.r[1] - c.r[0]) * r;
  const hi = curve(c.c, t);
  if (!c.c0) return hi * c.k;
  const lo = curve(c.c0, t);
  return (lo + (hi - lo) * r) * c.k;
}

function ramp(keys, t, fixed, n) {
  const pick = (k) => k.slice(1, 1 + n);
  if (fixed) {
    // GradientMode.Fixed: the first key at or after t
    for (const k of keys) if (k[0] >= t) return pick(k);
    return pick(keys[keys.length - 1]);
  }
  if (t <= keys[0][0]) return pick(keys[0]);
  const last = keys[keys.length - 1];
  if (t >= last[0]) return pick(last);
  let i = 1;
  while (keys[i][0] < t) i++;
  const a = keys[i - 1], b = keys[i], f = (t - a[0]) / (b[0] - a[0] || 1);
  const out = [];
  for (let k = 1; k <= n; k++) out.push(a[k] + (b[k] - a[k]) * f);
  return out;
}
export const gradientAt = (g, t) => [...ramp(g.c, t, g.fixed, 3), ramp(g.a, t, g.fixed, 1)[0]];
const lerp4 = (a, b, r) => [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r, a[2] + (b[2] - a[2]) * r, a[3] + (b[3] - a[3]) * r];
// a MinMaxGradient (particles.py gradient) at normalized time t with the particle's random r: [r, g, b, a] as stored
export function colorAt(g, t, r) {
  if (!g) return [1, 1, 1, 1];
  if (g.col) return g.col;
  if (g.r) return lerp4(g.r[0], g.r[1], r);
  if (g.g0) return lerp4(gradientAt(g.g0, t), gradientAt(g.g, t), r);
  if (g.pick) return gradientAt(g.g, r);
  return gradientAt(g.g, t);
}

// a small deterministic hash: the k-th random value of a particle (Unity keeps one random seed per particle and
// derives every module's value from it)
export function rnd(seed, k) {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const R = { life: 0, speed: 1, size: 2, sizeY: 3, sizeZ: 4, rotX: 5, rotY: 6, rot: 7, color: 8, colorLife: 9,
  sizeLife: 10, rotLife: 11, velX: 12, velY: 13, velZ: 14, orbit: 15, radial: 16, speedMod: 17, limit: 18,
  forceX: 19, forceY: 20, forceZ: 21, frame: 22, start: 23, row: 24, flipU: 25, flipV: 26, flipRot: 27, custom: 28,
  burst: 38, sub: 39, shape: 40 };

// --- 3 x 4 affine matrices (row-major) ------------------------------------------------------------------------------

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function mul(a, b) {
  const o = new Array(12);
  for (let i = 0; i < 3; i++) {
    const r0 = a[i * 4], r1 = a[i * 4 + 1], r2 = a[i * 4 + 2];
    for (let j = 0; j < 4; j++) o[i * 4 + j] = r0 * b[j] + r1 * b[4 + j] + r2 * b[8 + j] + (j === 3 ? a[i * 4 + 3] : 0);
  }
  return o;
}
export const apply = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
export const applyDir = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
export function invert(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  const inv = [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, 0,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det, 0,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det, 0];
  const t = applyDir(inv, m[3], m[7], m[11]);
  inv[3] = -t[0]; inv[7] = -t[1]; inv[11] = -t[2];
  return inv;
}
const colLen = (m, j) => Math.hypot(m[j], m[4 + j], m[8 + j]);
// the rotation part of an affine matrix (columns normalized, no translation)
function rotationOf(m) {
  const out = m.slice();
  for (let j = 0; j < 3; j++) {
    const l = colLen(m, j) || 1;
    out[j] /= l; out[4 + j] /= l; out[8 + j] /= l;
  }
  out[3] = out[7] = out[11] = 0;
  return out;
}
// Quaternion.Euler(x, y, z) in degrees as a 3 x 4 matrix (Unity's order: z, then x, then y)
export function euler(x, y, z) {
  const rx = (x * Math.PI) / 180, ry = (y * Math.PI) / 180, rz = (z * Math.PI) / 180;
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const X = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0], Y = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0], Z = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0];
  return mul(Y, mul(X, Z));
}
// a system's simulation matrix for its scaling mode: Hierarchy keeps every scale, Local only the system's own (in
// world units), Shape none (world units; the shape takes the scale when emitting)
export function scaled(W, def) {
  const mode = def.main.scaling;
  if (mode === 0) return W;
  const out = rotationOf(W), ls = mode === 1 ? def.ls : [1, 1, 1];
  for (let j = 0; j < 3; j++) { out[j] *= ls[j] * WORLD; out[4 + j] *= ls[j] * WORLD; out[8 + j] *= ls[j] * WORLD; }
  out[3] = W[3]; out[7] = W[7]; out[11] = W[11];
  return out;
}

// --- shapes ---------------------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
function unitSphere(r) {
  const z = 2 * r() - 1, a = TAU * r(), s = Math.sqrt(Math.max(0, 1 - z * z));
  return [s * Math.cos(a), s * Math.sin(a), z];
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1]; };
// radius thickness: 0 emits from the surface, 1 from the whole area (2D) or volume (3D), uniformly
const shell = (r, thickness, dims) => Math.pow(1 - thickness + thickness * r, 1 / dims);

// an emission point and direction in the shape's space (Unity's ParticleSystemShapeType), before the shape's own
// position, rotation and scale; r() gives random values, arcPos (0..1) places it on the arc in loop and ping-pong modes
export function shapePoint(shape, r, arcPos = null) {
  const type = shape.type, rad = shape.radius, th = shape.thickness;
  const angle = (arcPos != null ? arcPos : r()) * ((shape.arc ?? 360) * Math.PI) / 180;
  switch (type) {
    case 0: case 1: { // sphere, sphere shell: outwards
      const d = unitSphere(r), k = rad * (type === 1 ? 1 : shell(r(), th, 3));
      return { p: [d[0] * k, d[1] * k, d[2] * k], d };
    }
    case 2: case 3: { // hemisphere towards +z, shell
      const d = unitSphere(r);
      d[2] = Math.abs(d[2]);
      const k = rad * (type === 3 ? 1 : shell(r(), th, 3));
      return { p: [d[0] * k, d[1] * k, d[2] * k], d };
    }
    case 4: case 7: case 8: case 9: { // cone from its base (shell: its rim), cone volume: along +z, opening by angle
      const f = type === 7 || type === 9 ? 1 : shell(r(), th, 2);
      const ca = Math.cos(angle), sa = Math.sin(angle), tan = Math.tan((Math.min(89.9, shape.angle) * Math.PI) / 180);
      const d = norm([ca * tan * f, sa * tan * f, 1]);
      const p = [ca * rad * f, sa * rad * f, 0];
      if (type === 8 || type === 9) {
        const along = r() * shape.length;
        return { p: [p[0] + (d[0] / d[2]) * along, p[1] + (d[1] / d[2]) * along, along], d };
      }
      return { p, d };
    }
    case 5: // box volume (the unit box, scaled by the shape's scale), along +z
      return { p: [r() - 0.5, r() - 0.5, r() - 0.5], d: [0, 0, 1] };
    case 15: case 16: { // box shell (a face), box edge (an edge) of the unit box
      const p = [r() - 0.5, r() - 0.5, r() - 0.5], a = Math.floor(r() * 3) % 3;
      p[a] = r() < 0.5 ? -0.5 : 0.5;
      if (type === 16) { const b = (a + 1 + Math.floor(r() * 2)) % 3; p[b] = r() < 0.5 ? -0.5 : 0.5; }
      return { p, d: [0, 0, 1] };
    }
    case 10: case 11: { // circle in xy (edge: its rim), outwards
      const k = rad * (type === 11 ? 1 : shell(r(), th, 2)), d = [Math.cos(angle), Math.sin(angle), 0];
      return { p: [d[0] * k, d[1] * k, 0], d };
    }
    case 12: // single-sided edge along x, emitting along +y
      return { p: [((arcPos != null ? arcPos : r()) * 2 - 1) * rad, 0, 0], d: [0, 1, 0] };
    case 17: { // donut around z: a ring of radius rad, a tube of radius donut
      const k = shape.donut * shell(r(), th, 2), b = r() * TAU, cx = Math.cos(angle), cy = Math.sin(angle);
      const off = [cx * Math.cos(b) * k, cy * Math.cos(b) * k, Math.sin(b) * k];
      return { p: [cx * rad + off[0], cy * rad + off[1], off[2]], d: norm(off) };
    }
    case 18: // rectangle in xy (the unit square, scaled), along +z
      return { p: [r() - 0.5, r() - 0.5, 0], d: [0, 0, 1] };
    default: // mesh and sprite shapes: from the origin
      return { p: [0, 0, 0], d: [0, 0, 1] };
  }
}

// --- systems --------------------------------------------------------------------------------------------------------

// A clock that emits: a system's own, or a birth sub-emitter's (one per parent particle). fresh: a burst at time 0
// still fires on the first step.
const newClock = (bursts) => ({ time: 0, acc: 0, fresh: true, bursts: bursts.map(() => 0) });

// The runtime state of one lobby's effects. fx: lobby.json "fx"; bone(skeleton, bone) -> {a, b, c, d, worldX,
// worldY} or null, read every frame; random: a 0..1 source for tests.
export class Effects {
  constructor(fx, { bone = () => null, seed = (Math.random() * 2 ** 32) >>> 0, random = Math.random } = {}) {
    this.fx = fx || { systems: [] };
    this.bone = bone;
    this.seed = seed >>> 0;
    this.random = random;
    this.time = 0;
    this.serial = 0;
    this.started = false;
    this.systems = (this.fx.systems || []).map((def, index) => ({
      def, index, particles: [], instances: [], W: def.static, M: def.static, Minv: invert(def.static),
      playing: !def.isSub && def.playOnAwake !== 0, done: false,
      delay: Math.max(0, value(def.main.delay, 0, rnd(this.seed, index))), clock: newClock(def.emission?.bursts || []),
    }));
  }

  // every system's matrices for this frame (bones move them)
  place() {
    for (const s of this.systems) {
      const a = s.def.anchor;
      let W = s.def.static;
      if (a) {
        const b = this.bone(a.skeleton, a.bone);
        if (b) W = mul(a.go, mul([b.a, b.b, 0, b.worldX * a.ds, b.c, b.d, 0, b.worldY * a.ds, 0, 0, 1, 0], s.def.rel));
      }
      s.W = W;
      s.M = scaled(W, s.def);
      s.Minv = invert(s.M);
    }
  }

  // advance every system by dt seconds; prewarmed systems first simulate one duration, exactly (a loop shorter than
  // a step, or not a whole number of them, ends on a shorter step)
  update(dt) {
    dt = Math.max(0, Math.min(MAX_DT, dt || 0));
    this.place();
    if (!this.started) {
      this.started = true;
      for (const s of this.systems) {
        const D = s.def.main.duration;
        if (!s.playing || !s.def.main.prewarm || !s.def.main.loop) continue;
        for (let t = 0; t < D - EPS; t += PREWARM_STEP) this.step(s, Math.min(PREWARM_STEP, D - t), true);
      }
    }
    this.time += dt;
    for (const s of this.systems) this.step(s, dt * (s.def.main.speedScale ?? 1), false);
  }

  step(s, dt, prewarm) {
    if (!(dt > 0)) return;
    if (s.playing && !s.done) {
      let left = dt;
      if (!prewarm && s.delay > 0) {
        const used = Math.min(s.delay, left);
        s.delay -= used;
        left -= used;
      }
      if (left > 0) this.emitSpan(s, s.clock, left, null);
      if (!s.def.main.loop && s.clock.time >= s.def.main.duration) s.done = true;
    }
    for (const inst of s.instances) this.emitSpan(s, inst.clock, dt, inst);
    s.instances = s.instances.filter((inst) => !inst.parent.dead && !(inst.clock.time >= s.def.main.duration && !s.def.main.loop));
    this.simulate(s, dt);
  }

  // emission over the next dt seconds of a clock: bursts fire when it passes their time within a loop (cycles
  // times, every interval), the rate adds up over time. A burst up to EPS past the span's end fires in it (frames of
  // 1/60 s add up to a hair under a loop's end), so the loops it visits reach that far too: else the loop that starts
  // there would never fire its burst at 0, the next span taking it as already past.
  emitSpan(s, clock, dt, inst) {
    const main = s.def.main, em = s.def.emission || { rate: 0, bursts: [] }, D = main.duration;
    const from = clock.time;
    let to = from + dt;
    if (!main.loop) to = Math.min(to, D);
    if (to <= from && !clock.fresh) return;
    em.bursts.forEach((b, i) => {
      const cycles = b.cycles > 0 ? b.cycles : Infinity;
      for (let loop = Math.floor(from / D); loop <= Math.floor((to + EPS) / D) && (main.loop || loop === 0); loop++) {
        for (let k = 0; k < cycles; k++) {
          const local = b.t + k * b.interval;
          if (local > D + EPS) break;
          const t = loop * D + local;
          if (t > to + EPS) break;
          if (t <= from + EPS && !(clock.fresh && t <= EPS)) continue;
          if (b.p < 1 && this.random() >= b.p) continue;
          const n = Math.round(value(b.n, local / D, this.random()));
          for (let j = 0; j < n; j++) this.emit(s, local / D, inst);
        }
      }
    });
    const u = (from % D) / D, rate = value(em.rate, u, this.random());
    if (rate > 0) {
      clock.acc += rate * (to - from);
      while (clock.acc >= 1) { clock.acc -= 1; this.emit(s, u, inst); }
    }
    clock.time = to;
    clock.fresh = false;
  }

  emit(s, u, inst) {
    const def = s.def, main = def.main;
    if (s.particles.length >= main.max) {
      if (!main.ring || !s.particles.length) return null;
      s.particles.shift().dead = true; // a ring buffer gives the oldest particle's place to the new one
    }
    const seed = (rnd(this.seed, ++this.serial) * 4294967296) >>> 0, r = (k) => rnd(seed, k);
    let n = R.shape;
    const next = () => rnd(seed, n++);
    const life = Math.max(1e-3, value(main.life, u, r(R.life)));
    const speed = value(main.speed, u, r(R.speed));
    const s0 = value(main.size[0], u, r(R.size));
    const size = main.size.length === 3 ? [s0, value(main.size[1], u, r(R.sizeY)), value(main.size[2], u, r(R.sizeZ))] : [s0, s0, s0];
    const flip = r(R.flipRot) < (main.flipRotation || 0) ? -1 : 1;
    const rot = main.rotation.length === 3
      ? [value(main.rotation[0], u, r(R.rotX)), value(main.rotation[1], u, r(R.rotY)), value(main.rotation[2], u, r(R.rot))]
      : [0, 0, value(main.rotation[0], u, r(R.rot))];
    if (flip < 0) for (let i = 0; i < 3; i++) rot[i] = -rot[i];
    let color = colorAt(main.color, u, r(R.color));
    // the emission point and direction in the system's space
    let p = [0, 0, 0], d = [0, 0, 1];
    const sh = def.shape;
    if (sh) {
      let arcPos = null;
      if (sh.arcMode === 1 || sh.arcMode === 2) {
        const t = (((inst ? inst.clock.time : s.clock.time) / main.duration) * (value(sh.arcSpeed, u, 0) || 1)) % 1;
        arcPos = sh.arcMode === 2 ? 1 - Math.abs(1 - 2 * t) : t;
        if (sh.arcSpread > 0) arcPos = Math.round(arcPos / sh.arcSpread) * sh.arcSpread;
      }
      const e = shapePoint(sh, next, arcPos);
      let q = e.p, dir = e.d;
      if (sh.randomPos > 0) q = q.map((v) => v + (next() * 2 - 1) * sh.randomPos);
      if (sh.spherical > 0) { const out = norm(q); dir = norm(dir.map((v, i) => v + (out[i] - v) * sh.spherical)); }
      if (sh.randomDir > 0) { const rd = unitSphere(next); dir = norm(dir.map((v, i) => v + (rd[i] - v) * sh.randomDir)); }
      const T = mul(mul([1, 0, 0, sh.pos[0], 0, 1, 0, sh.pos[1], 0, 0, 1, sh.pos[2]], euler(sh.rot[0], sh.rot[1], sh.rot[2])),
        [sh.scale[0], 0, 0, 0, 0, sh.scale[1], 0, 0, 0, 0, sh.scale[2], 0]);
      p = apply(T, q[0], q[1], q[2]);
      d = norm(applyDir(T, dir[0], dir[1], dir[2]));
      if (main.scaling === 2) { // Shape scaling: the shape takes the hierarchy's scale, the particles do not
        const w = apply(s.W, p[0], p[1], p[2]);
        p = apply(s.Minv, w[0], w[1], w[2]);
      }
    }
    let vel = [d[0] * speed, d[1] * speed, d[2] * speed];
    if (inst) {
      // at the parent particle (in this system's space), inheriting what the sub-emitter says
      const par = inst.parent, ps = inst.system, cur = par.cur || par;
      const w = ps.def.main.space === 1 ? par.pos : apply(ps.M, par.pos[0], par.pos[1], par.pos[2]);
      const at = main.space === 1 ? w : apply(s.Minv, w[0], w[1], w[2]);
      if (main.space === 1) { const o = applyDir(s.M, p[0], p[1], p[2]); p = [at[0] + o[0], at[1] + o[1], at[2] + o[2]]; }
      else p = [at[0] + p[0], at[1] + p[1], at[2] + p[2]];
      if (main.space === 1) vel = applyDir(s.M, vel[0], vel[1], vel[2]);
      const bits = inst.inherit;
      if (bits & 1) color = color.map((c, i) => c * cur.color[i]);
      if (bits & 2) for (let i = 0; i < 3; i++) size[i] *= cur.size[i];
      if (bits & 4) for (let i = 0; i < 3; i++) rot[i] += cur.rot[i];
    } else if (main.space === 1) {
      p = apply(s.M, p[0], p[1], p[2]);
      vel = applyDir(s.M, vel[0], vel[1], vel[2]);
    }
    const pt = { seed, age: 0, life, size, rot, flip, color, pos: p, vel, anim: [0, 0, 0], u, cur: null, dead: false };
    s.particles.push(pt);
    for (const e of def.subs || []) {
      const sub = this.systems[e.system];
      if (e.type === 0 && sub && rnd(seed, R.sub) < (e.p ?? 1)) {
        sub.instances.push({ parent: pt, system: s, inherit: e.inherit, clock: newClock(sub.def.emission?.bursts || []) });
      }
    }
    return pt;
  }

  // move, age and turn the particles of a system
  simulate(s, dt) {
    const def = s.def, main = def.main, mod = def.modules || {}, world = main.space === 1;
    const M = s.M, Minv = s.Minv;
    // a module's vector in the simulation space (world-space values are in Unity world units)
    const toSim = (v, inWorld) => {
      if (inWorld) return world ? [v[0] * WORLD, v[1] * WORLD, v[2] * WORLD] : applyDir(Minv, v[0] * WORLD, v[1] * WORLD, v[2] * WORLD);
      return world ? applyDir(M, v[0], v[1], v[2]) : v;
    };
    const gm = value(main.gravity, (s.clock.time % main.duration) / main.duration, 0.5);
    const g = gm ? toSim([0, GRAVITY * gm, 0], true) : null;
    // ring buffer: past its lifetime a particle holds still at its end (1) or plays the loop range again (2)
    const ring = main.ring || 0, [loopFrom, loopTo] = main.ringRange || [0, 1];
    const alive = [];
    for (const pt of s.particles) {
      if (pt.paused) { alive.push(pt); continue; }
      pt.age += dt;
      const end = ring === 2 ? loopTo * pt.life : pt.life;
      if (pt.age >= end) {
        if (ring === 1) { pt.age = pt.life; pt.paused = true; alive.push(pt); continue; }
        if (ring !== 2) { this.die(s, pt); continue; }
        const from = loopFrom * pt.life, span = end - from;
        pt.age = span > 1e-6 ? from + ((pt.age - from) % span) : from;
      }
      const t = pt.age / pt.life, r = (k) => rnd(pt.seed, k);
      if (mod.force) {
        const f = toSim([value(mod.force.x, t, r(R.forceX)), value(mod.force.y, t, r(R.forceY)), value(mod.force.z, t, r(R.forceZ))], mod.force.world);
        pt.vel[0] += f[0] * dt; pt.vel[1] += f[1] * dt; pt.vel[2] += f[2] * dt;
      }
      if (g) { pt.vel[0] += g[0] * dt; pt.vel[1] += g[1] * dt; pt.vel[2] += g[2] * dt; }
      // velocity over lifetime: linear, orbital around the system's centre (plus offset) and radial, on top of the
      // particle's own velocity for this frame
      let anim = [0, 0, 0], speedMod = 1;
      const vm = mod.velocity;
      if (vm) {
        anim = toSim([value(vm.x, t, r(R.velX)), value(vm.y, t, r(R.velY)), value(vm.z, t, r(R.velZ))], vm.world);
        const ox = value(vm.orbitalX, t, r(R.orbit)), oy = value(vm.orbitalY, t, r(R.orbit)), oz = value(vm.orbitalZ, t, r(R.orbit));
        const radial = value(vm.radial, t, r(R.radial));
        if (ox || oy || oz || radial) {
          const off = [value(vm.orbitalOffsetX, t, 0), value(vm.orbitalOffsetY, t, 0), value(vm.orbitalOffsetZ, t, 0)];
          const lp = world ? apply(Minv, pt.pos[0], pt.pos[1], pt.pos[2]) : pt.pos;
          const rel = [lp[0] - off[0], lp[1] - off[1], lp[2] - off[2]];
          let lv = [0, 0, 0];
          if (ox || oy || oz) {
            const deg = (180 / Math.PI) * dt, rp = applyDir(euler(ox * deg, oy * deg, oz * deg), rel[0], rel[1], rel[2]);
            lv = [(rp[0] - rel[0]) / dt, (rp[1] - rel[1]) / dt, (rp[2] - rel[2]) / dt];
          }
          if (radial) { const nr = norm(rel); lv = [lv[0] + nr[0] * radial, lv[1] + nr[1] * radial, lv[2] + nr[2] * radial]; }
          const sv = world ? applyDir(M, lv[0], lv[1], lv[2]) : lv;
          anim = [anim[0] + sv[0], anim[1] + sv[1], anim[2] + sv[2]];
        }
        speedMod = value(vm.speed, t, r(R.speedMod));
      }
      // limit velocity: dampen takes off part of the speed above the limit (per 1/30 s)
      const lm = mod.limit;
      if (lm) {
        const tot = [pt.vel[0] + anim[0], pt.vel[1] + anim[1], pt.vel[2] + anim[2]];
        const sp = Math.hypot(tot[0], tot[1], tot[2]);
        let lim = value(lm.speed, t, r(R.limit));
        if (world) lim *= (colLen(M, 0) + colLen(M, 1)) / 2; // the limit is in the system's units
        if (sp > lim && sp > 0) {
          const damp = 1 - Math.pow(1 - Math.min(1, Math.max(0, lm.dampen)), dt * DAMPEN_FPS);
          const k = 1 - damp * (1 - lim / sp);
          pt.vel = [tot[0] * k - anim[0], tot[1] * k - anim[1], tot[2] * k - anim[2]];
        }
      }
      pt.anim = anim;
      for (let i = 0; i < 3; i++) pt.pos[i] += (pt.vel[i] + anim[i]) * speedMod * dt;
      if (mod.rotation) { // angular velocity in radians per second
        const w = mod.rotation;
        if (w.sep) {
          pt.rot[0] += value(w.x, t, r(R.rotLife)) * pt.flip * dt;
          pt.rot[1] += value(w.y, t, r(R.rotLife)) * pt.flip * dt;
        }
        pt.rot[2] += value(w.z, t, r(R.rotLife)) * pt.flip * dt;
      }
      alive.push(pt);
    }
    s.particles = alive;
  }

  die(s, pt) {
    pt.dead = true;
    for (const e of s.def.subs || []) {
      const sub = this.systems[e.system];
      if (e.type !== 2 || !sub || rnd(pt.seed, R.sub) >= (e.p ?? 1)) continue;
      // a death sub-emitter: its bursts at the particle's last place, all at once
      const inst = { parent: pt, system: s, inherit: e.inherit, clock: newClock([]) };
      for (const b of sub.def.emission?.bursts || []) {
        const n = Math.round(value(b.n, 0, this.random())) * Math.max(1, b.cycles || 1);
        for (let j = 0; j < n; j++) this.emit(sub, 0, inst);
      }
    }
  }

  // what a live particle draws with now: size, rotation, colour (stored values), sheet frame and custom data, at its
  // normalized age
  current(s, pt) {
    const mod = s.def.modules || {}, t = pt.age / pt.life, r = (k) => rnd(pt.seed, k);
    let size = pt.size;
    if (mod.size) {
      const kx = value(mod.size.x, t, r(R.sizeLife));
      const ky = mod.size.sep ? value(mod.size.y, t, r(R.sizeLife)) : kx, kz = mod.size.sep ? value(mod.size.z ?? 1, t, r(R.sizeLife)) : kx;
      size = [size[0] * kx, size[1] * ky, size[2] * kz];
    }
    let color = pt.color;
    if (mod.color) {
      const c = colorAt(mod.color, t, r(R.colorLife));
      color = [color[0] * c[0], color[1] * c[1], color[2] * c[2], color[3] * c[3]];
    }
    let frame = 0, tiles = null;
    const sh = mod.sheet;
    if (sh) {
      // frame over time and the start frame are both stored as fractions of the sheet (the inspector shows them in
      // frames): a 2 x 2 sheet with a start frame between 0 and 0.75 starts on any of its four tiles
      const frames = sh.type === 1 ? sh.x : sh.x * sh.y;
      const tt = sh.time === 2 ? ((pt.age * sh.fps) / frames) % 1 : (t * sh.cycles) % 1;
      const at = value(sh.frame, tt, r(R.frame)) + value(sh.start, 0, r(R.start));
      frame = Math.min(frames - 1, Math.floor((((at % 1) + 1) % 1) * frames));
      if (sh.type === 1) frame += Math.min(sh.y - 1, Math.max(0, sh.rowMode === 1 ? Math.floor(r(R.row) * sh.y) : sh.row)) * sh.x;
      tiles = [sh.x, sh.y];
    }
    const custom = [[0, 0, 0, 0], [0, 0, 0, 0]];
    (mod.custom || []).forEach((c, i) => {
      if (!c) return;
      if (c.col) custom[i] = colorAt(c.col, t, r(R.custom + i));
      else c.v.forEach((v, k) => { custom[i][k] = value(v, t, r(R.custom + i * 4 + k)); });
    });
    pt.cur = { size, color, rot: pt.rot };
    return { size, color, rot: pt.rot, frame, tiles, custom };
  }

  // how many particles are alive (for checks)
  count() { return this.systems.reduce((n, s) => n + s.particles.length, 0); }

  // drop every particle (the lobby closes)
  clear() {
    for (const s of this.systems) { s.particles = []; s.instances = []; }
  }
}

// --- geometry -------------------------------------------------------------------------------------------------------

// floats per vertex: position (x, y in lobby units), TEXCOORD0..2 (uv, uv2 and custom data where the renderer's
// streams put them), colour, normal (world axes: a mesh's own turned with the particle, a billboard's to the camera)
export const STRIDE = 2 + 12 + 4 + 3;

// the particle colour as the vertex stream carries it: clamped and 8-bit like Unity's Color32, then (in linear light)
// decoded from sRGB; alpha as it is
export function vertexColor(c, linear) {
  const q = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255;
  const out = [q(c[0]), q(c[1]), q(c[2]), q(c[3])];
  if (linear) for (let i = 0; i < 3; i++) out[i] = toLinear(out[i]);
  return out;
}

// TEXCOORD0..2 of a particle from the renderer's streams (custom data; the UV slots are filled per vertex)
const TC = new Float32Array(12);
function texcoords(streams, custom) {
  const t = TC.fill(0);
  const put = (at, vals) => { if (at) for (let k = 0; k < at[1] && at[0] + k < 12; k++) t[at[0] + k] = vals[k] ?? 0; };
  put(streams.c1, custom[0]);
  put(streams.c2, custom[1]);
  return t;
}

// a billboard's normal: towards the camera, which looks along +z
const FACING = [0, 0, -1];
// quad corners [x, y, u, v] in the triangle order 0 1 2, 2 3 0
const QUAD = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1], [-0.5, -0.5, 0, 0]];

// One system's triangles for this frame: {data: Float32Array (STRIDE floats per vertex), count: vertices}, in a
// buffer the next call reuses. meshes: lobby.json fx.meshes; linear: decode the colours from sRGB. Positions are
// lobby units (z dropped: the camera is orthographic).
let scratch = new Float32Array(0);
export function geometry(fxs, s, { meshes = {}, linear = true } = {}) {
  const def = s.def, rend = def.renderer, world = def.main.space === 1;
  const mesh = rend.mode === 4 ? meshes[rend.mesh] : null;
  if (!s.particles.length || (rend.mode === 4 && !mesh)) return { data: new Float32Array(0), count: 0 };
  const M = s.M, streams = rend.streams || { uv: [0, 2] };
  const need = s.particles.length * (mesh ? mesh.i.length : 6) * STRIDE;
  if (scratch.length < need) scratch = new Float32Array(Math.max(need, scratch.length * 2, 4096));
  const data = scratch;
  let o = 0;
  const sx = colLen(M, 0), sy = colLen(M, 1), sz = colLen(M, 2), Rm = rotationOf(M);
  const maxSize = (rend.maxSize ?? 0.5) * VIEW_H;
  // drawn in order, the last on top: oldest in front (2) draws the youngest first, youngest in front (3) the oldest
  let order = s.particles;
  if (rend.sort === 2) order = order.slice().sort((a, b) => a.age - b.age);
  else if (rend.sort === 3) order = order.slice().sort((a, b) => b.age - a.age);
  for (const pt of order) {
    const cur = fxs.current(s, pt), c = vertexColor(cur.color, linear), tc = texcoords(streams, cur.custom);
    const centre = world ? pt.pos : apply(M, pt.pos[0], pt.pos[1], pt.pos[2]);
    const fu = rend.flip && rnd(pt.seed, R.flipU) < rend.flip[0], fv = rend.flip && rnd(pt.seed, R.flipV) < rend.flip[1];
    // the sheet tile's UV rectangle (frame 0 is the top-left tile; UV (0, 0) is the bottom-left corner)
    let u0 = 0, v0 = 0, du = 1, dv = 1;
    if (cur.tiles) {
      du = 1 / cur.tiles[0]; dv = 1 / cur.tiles[1];
      u0 = (cur.frame % cur.tiles[0]) * du;
      v0 = 1 - (Math.floor(cur.frame / cur.tiles[0]) + 1) * dv;
    }
    const push = (x, y, u, v, n = FACING, col = c) => {
      const uu = u0 + (fu ? 1 - u : u) * du, vv = v0 + (fv ? 1 - v : v) * dv;
      data[o++] = x; data[o++] = y;
      for (let k = 0; k < 12; k++) data[o + k] = tc[k];
      if (streams.uv) { data[o + streams.uv[0]] = uu; data[o + streams.uv[0] + 1] = vv; }
      if (streams.uv2) { data[o + streams.uv2[0]] = uu; data[o + streams.uv2[0] + 1] = vv; }
      o += 12;
      data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = col[3];
      data[o++] = n[0]; data[o++] = n[1]; data[o++] = n[2];
    };
    if (mesh) {
      // the mesh scaled by the particle's 3D size and the system's scale, turned like a billboard (z clockwise on
      // screen, then x and y), in the system's orientation with local alignment, else the camera's (world axes); the
      // particle's colour times the mesh's vertex colours where it has them (ch0188's sea meshes fade out by them)
      const deg = 180 / Math.PI, mc = mesh.c, pc = cur.color;
      const turn = mul(rend.align === 2 ? Rm : IDENTITY, euler(cur.rot[0] * deg, cur.rot[1] * deg, -cur.rot[2] * deg));
      const T = mul(turn, [cur.size[0] * sx, 0, 0, 0, 0, cur.size[1] * sy, 0, 0, 0, 0, cur.size[2] * sz, 0]);
      for (const idx of mesh.i) {
        const p = applyDir(T, mesh.v[idx * 3], mesh.v[idx * 3 + 1], mesh.v[idx * 3 + 2]);
        const n = mesh.n ? norm(applyDir(turn, mesh.n[idx * 3], mesh.n[idx * 3 + 1], mesh.n[idx * 3 + 2])) : FACING;
        const col = mc ? vertexColor([pc[0] * mc[idx * 4], pc[1] * mc[idx * 4 + 1], pc[2] * mc[idx * 4 + 2], pc[3] * mc[idx * 4 + 3]], linear) : c;
        push(centre[0] + p[0], centre[1] + p[1], mesh.uv ? mesh.uv[idx * 2] : 0, mesh.uv ? mesh.uv[idx * 2 + 1] : 0, n, col);
      }
      continue;
    }
    let w = cur.size[0] * sx, h = cur.size[1] * sy;
    const big = Math.max(Math.abs(w), Math.abs(h));
    if (big > maxSize) { w *= maxSize / big; h *= maxSize / big; } // max particle size: a fraction of the view height
    if (rend.mode === 1) {
      // stretched along its velocity on screen, the particle at the head: length = size x length scale + speed x
      // velocity scale
      const v = world ? [pt.vel[0] + pt.anim[0], pt.vel[1] + pt.anim[1]]
        : applyDir(M, pt.vel[0] + pt.anim[0], pt.vel[1] + pt.anim[1], pt.vel[2] + pt.anim[2]);
      const sp = Math.hypot(v[0], v[1]) || 1e-6, dx = v[0] / sp, dy = v[1] / sp;
      const len = w * (rend.lengthScale ?? 2) + sp * (rend.velocityScale || 0);
      for (const q of QUAD) {
        const a = (q[0] - 0.5) * len, b = q[1] * h;
        push(centre[0] + dx * a - dy * b, centre[1] + dy * a + dx * b, q[2], q[3]);
      }
      continue;
    }
    // facing the camera (or in the system's plane with local alignment), turned clockwise by the rotation
    const rz = -cur.rot[2], cz = Math.cos(rz), sn = Math.sin(rz);
    const px = (rend.pivot?.[0] || 0) * w, py = (rend.pivot?.[1] || 0) * h;
    const X = rend.align === 2 ? [Rm[0], Rm[4]] : [1, 0], Y = rend.align === 2 ? [Rm[1], Rm[5]] : [0, 1];
    const fx3 = def.main.rotation.length === 3 ? Math.cos(cur.rot[1]) : 1, fy3 = def.main.rotation.length === 3 ? Math.cos(cur.rot[0]) : 1;
    for (const q of QUAD) {
      const lx = (q[0] * w + px) * fx3, ly = (q[1] * h + py) * fy3;
      const rx = lx * cz - ly * sn, ry = lx * sn + ly * cz;
      push(centre[0] + X[0] * rx + Y[0] * ry, centre[1] + X[1] * rx + Y[1] * ry, q[2], q[3]);
    }
  }
  return { data: data.subarray(0, o), count: o / STRIDE };
}

// --- draw order -----------------------------------------------------------------------------------------------------

const sortKey = (x) => [x.order || 0, x.queue ?? 3000, -(x.z || 0)];
// Unity draws transparent renderers by sorting layer, order in layer, render queue, then back to front. layers: the
// lobby's skeleton players in their stacking order (each with order, queue and z). A system draws in the context of
// the last layer that sorts before it ("above" that skeleton), or below the first one; a tie puts it above.
export function slotOf(def, layers) {
  const before = (a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i];
    return true;
  };
  let slot = -1;
  layers.forEach((l, i) => { if (before(l, def)) slot = i; });
  return slot < 0 ? { layer: 0, where: "below" } : { layer: slot, where: "above" };
}

// systems in drawing order: order in layer, queue, back to front, then the prefab's order
export function drawOrder(systems) {
  return systems.slice().sort((a, b) => {
    const ka = sortKey(a.def), kb = sortKey(b.def);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a.index - b.index;
  });
}
