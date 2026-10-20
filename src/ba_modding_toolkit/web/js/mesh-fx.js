// The plain mesh renderers of a memorial lobby (lobby.json fx.renderers, gameassets/meshfx.py): lens dirt and light
// quads, Hanako's water surface, Maki's clouds, Utaha's window glow. particles-gl.js draws them with the particle
// programs (their shaders are the same effect shaders), sorted with the particle systems and the skeletons' atlas
// pages; this module places them, plays the Animator clips that loop them (fx.clips: scale, position, Euler angles,
// material colours) and builds their triangles. Pure data, no DOM and no GL.
//
// A renderer is placed like a particle system: by the bone its anchor follows (the skeleton GameObject times the
// bone's world transform), times its chain of local transforms below that bone (from the prefab root without an
// anchor), each transform as the clips leave it this frame. Most are Unity's built-in Quad; triangles the material
// culls are dropped the way Unity culls them, front faces clockwise on screen, mirrored transforms turning that round.
// A mesh's vertex colours reach the shader as stored: Unity converts no Mesh.colors to linear light (only a particle
// renderer's, with Apply Active Color Space), and the programs these renderers use (FX_SHADER_Lobby_Order,
// FX_SHADER_Additive_0, FX_SHADER_AlphaBlend_Add_Distort_0) pass COLOR0 on unchanged (mov o2, v3).
import { STRIDE, mul, vertexColor } from "./particles.js";
import { toLinear } from "./touch-fx.js";

// Unity's built-in Quad (unity default resources): a unit square facing the camera, UV (0, 0) at the bottom left
export const QUAD = Object.freeze({ v: [-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0], uv: [0, 0, 1, 0, 0, 1, 1, 1],
  i: [0, 3, 1, 3, 0, 2] });
// draw order ties go to the particle systems, which come first in the prefab's lists
const INDEX = 1e6;
const MAX_DT = 0.1;

// for checks: draw the mesh renderers (true) or leave them out (false); their clips keep playing either way
export let shown = true;
export const show = (on) => { shown = !!on; };

// a local transform (position, rotation quaternion x y z w, scale) as a 3 x 4 matrix
export function trs(p, q, s) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1, [x, y, z, w] = q.map((v) => v / n);
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
  return [r[0] * s[0], r[1] * s[1], r[2] * s[2], p[0], r[3] * s[0], r[4] * s[1], r[5] * s[2], p[1],
    r[6] * s[0], r[7] * s[1], r[8] * s[2], p[2]];
}

// Euler angles (degrees) in one of Unity's rotation orders (math::RotationOrder: 0 XYZ ... 4 ZXY, Unity's own, 5
// ZYX; the first letter is applied first) as a quaternion [x, y, z, w]
const ORDERS = ["XYZ", "XZY", "YZX", "YXZ", "ZXY", "ZYX"];
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export function eulerQuat(e, order = 4) {
  const h = e.map((d) => (d * Math.PI) / 360);
  const axis = { X: [Math.sin(h[0]), 0, 0, Math.cos(h[0])], Y: [0, Math.sin(h[1]), 0, Math.cos(h[1])], Z: [0, 0, Math.sin(h[2]), Math.cos(h[2])] };
  let q = [0, 0, 0, 1];
  for (const a of ORDERS[order] || ORDERS[4]) q = qmul(axis[a], q);
  return q;
}

// a track's value at t seconds into its clip: its samples are 1 / rate apart, linear in between (one sample: constant)
export function sample(values, rate, t) {
  if (values.length === 1) return values[0];
  const f = Math.max(0, t * rate), i = Math.min(values.length - 1, Math.floor(f)), j = Math.min(values.length - 1, i + 1), k = f - i;
  const a = values[i], b = values[j];
  return Array.isArray(a) ? a.map((v, n) => v + (b[n] - v) * k) : a + (b - a) * k;
}

// The runtime state of a lobby's mesh renderers. fx: lobby.json "fx"; bone(skeleton, bone) -> {a, b, c, d, worldX,
// worldY} or null, read every frame (as particles.js Effects).
export class Meshes {
  constructor(fx, { bone = () => null } = {}) {
    this.bone = bone;
    this.time = 0;
    this.clips = fx?.clips || [];
    this.materials = fx?.materials || {};
    // items drawn like particle systems (particles-gl.js): def carries material, queue, order and z
    this.items = (fx?.renderers || []).map((def, i) => ({ def, index: INDEX + i, mesh: true, particles: [], W: def.static,
      uniforms: null }));
    this.place();
  }

  update(dt) {
    this.time += Math.max(0, Math.min(MAX_DT, dt || 0));
    this.place();
  }

  // what the clips leave this frame: transforms by node ({p, q, s}) and material property channels by renderer
  pose() {
    const nodes = new Map(), props = new Map();
    for (const c of this.clips) {
      const d = c.duration > 0 ? c.duration : 0, t = !d ? 0 : c.loop ? this.time % d : Math.min(this.time, d);
      for (const tr of c.tracks) {
        const v = sample(tr.v, c.rate, t);
        if (tr.node != null) {
          const o = nodes.get(tr.node) || {};
          if (tr.attr === "e") o.q = eulerQuat(v, tr.order);
          else o[tr.attr] = v;
          nodes.set(tr.node, o);
        } else {
          const by = props.get(tr.renderer) || {}, ch = by[tr.prop] || (by[tr.prop] = []);
          ch[tr.ch] = { v, rgba: !!tr.rgba };
          props.set(tr.renderer, by);
        }
      }
    }
    return { nodes, props };
  }

  // every renderer's matrix (lobby units) and animated material colours for this frame
  place() {
    const { nodes, props } = this.pose();
    this.items.forEach((s, i) => {
      const def = s.def;
      let rel = null;
      for (const c of def.chain || []) {
        const o = nodes.get(c.node);
        const m = trs(o?.p || c.p, o?.q || c.q, o?.s || c.s);
        rel = rel ? mul(rel, m) : m;
      }
      const a = def.anchor;
      let W = def.static;
      if (a) {
        const b = this.bone(a.skeleton, a.bone);
        if (b && rel) W = mul(a.go, mul([b.a, b.b, 0, b.worldX * a.ds, b.c, b.d, 0, b.worldY * a.ds, 0, 0, 1, 0], rel));
      } else if (rel) W = rel;
      s.W = W;
      s.uniforms = props.has(i) ? this.uniforms(def, props.get(i)) : null;
    });
  }

  // a renderer's animated properties as the shader gets them: a Color channel (r g b a) is converted to linear light
  // like the material's colours (alpha as it is), a Vector channel (x y z w) is set as it is; the channels a clip
  // leaves alone keep the material's colour
  uniforms(def, by) {
    const mat = this.materials[def.material] || {}, out = {};
    for (const [prop, chs] of Object.entries(by)) {
      const base = mat.colors?.[prop] || [1, 1, 1, 1];
      out[prop] = [0, 1, 2, 3].map((k) => {
        const c = chs[k];
        if (!c) return k < 3 ? toLinear(base[k]) : base[k];
        return c.rgba && k < 3 ? toLinear(c.v) : c.v;
      });
    }
    return out;
  }

  // for checks: each renderer's name, the bounds of its triangles this frame (lobby units), their count and its
  // animated colours
  stats({ meshes = {} } = {}) {
    return this.items.map((s) => {
      const g = this.geometry(s, { meshes }), b = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < g.count; k++) {
        const x = g.data[k * STRIDE], y = g.data[k * STRIDE + 1];
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
      }
      return { name: s.def.name, triangles: g.count / 3, bounds: g.count ? b.map((v) => +v.toFixed(1)) : null,
        uniforms: s.uniforms };
    });
  }

  // One renderer's triangles for this frame, in particles.js geometry's vertex layout: {data, count}. meshes: lobby.json
  // fx.meshes; positions in lobby units (z dropped: the camera is orthographic), TEXCOORD0 the mesh's UV (z 0, w 1 as
  // a two-component stream reads), the vertex colour the mesh's (as stored, 8 bits a channel) or white.
  geometry(s, { meshes = {} } = {}) {
    const def = s.def, mesh = def.mesh === "quad" ? QUAD : meshes[def.mesh];
    if (!mesh || !shown) return { data: new Float32Array(0), count: 0 };
    const W = s.W, cull = this.materials[def.material]?.cull ?? 2;
    const det = W[0] * (W[5] * W[10] - W[6] * W[9]) - W[1] * (W[4] * W[10] - W[6] * W[8]) + W[2] * (W[4] * W[9] - W[5] * W[8]);
    const data = new Float32Array(mesh.i.length * STRIDE);
    const n = mesh.v.length / 3, xy = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const x = mesh.v[k * 3], y = mesh.v[k * 3 + 1], z = mesh.v[k * 3 + 2];
      xy[k * 2] = W[0] * x + W[1] * y + W[2] * z + W[3];
      xy[k * 2 + 1] = W[4] * x + W[5] * y + W[6] * z + W[7];
    }
    let o = 0;
    for (let t = 0; t < mesh.i.length; t += 3) {
      const [a, b, c] = [mesh.i[t], mesh.i[t + 1], mesh.i[t + 2]];
      // clockwise on screen (x right, y up) is a front face; a mirrored transform's faces are judged mirrored back
      const cross = (xy[b * 2] - xy[a * 2]) * (xy[c * 2 + 1] - xy[a * 2 + 1]) - (xy[b * 2 + 1] - xy[a * 2 + 1]) * (xy[c * 2] - xy[a * 2]);
      const front = cross * (det < 0 ? -1 : 1) < 0;
      if ((cull === 2 && !front) || (cull === 1 && front)) continue;
      for (const k of [a, b, c]) {
        data[o++] = xy[k * 2]; data[o++] = xy[k * 2 + 1];
        data[o++] = mesh.uv ? mesh.uv[k * 2] : 0; data[o++] = mesh.uv ? mesh.uv[k * 2 + 1] : 0; data[o++] = 0; data[o++] = 1;
        for (let m = 0; m < 8; m++) data[o++] = 0; // TEXCOORD1 and 2: no custom data on a mesh
        const col = mesh.c ? vertexColor(mesh.c.slice(k * 4, k * 4 + 4), false) : [1, 1, 1, 1];
        data[o++] = col[0]; data[o++] = col[1]; data[o++] = col[2]; data[o++] = col[3];
        data[o++] = 0; data[o++] = 0; data[o++] = -1;
      }
    }
    return { data: data.subarray(0, o), count: o / STRIDE };
  }
}
