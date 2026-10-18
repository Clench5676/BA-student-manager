// The game's touch effect, Resources/UI/FX_Touch: TouchEffectCreater (Persistent in level1) shows it at the pointer
// through the UI camera on every press, moves it while the button is held (SetDragPosition) and stops it 60 frames
// (FXTouch.Duration, the system's 1 s) after the release. Its parts, read from the prefab's ParticleSystem and
// TrailRenderer typetrees and their materials:
//   arc     MeshTri: 2 thin rings (mesh Cylinder002, radius 1 to 1.0637) spinning and growing, cut by a dissolve
//           threshold over FX_TEX_Grad_Ring3's alpha along the ring (Shader Graphs/FX_SHADER_Dissolve_GachaGauge_P,
//           blend SrcAlpha One)
//   flash   ring: 1 disc (FX_TEX_Circle_01, DSFX/FX_SHADER_AlphaBlend_Add, blend One OneMinusSrcAlpha: its colour is
//           added, its alpha only hides what is behind)
//   burst   Ring (3): 4 triangles (FX_TEX_Triangle_02_1, two frames) leaving a circle edge, twinkling (additive)
//   drag    Ring (4): the same triangles, 5 per unit of drag
//   trail   Trail: a 0.3 s TrailRenderer, 0.005 units wide (FX_TEX_Trail_03 stretched along it, additive)
// Pure data and simulation, no DOM (cursor.js draws it). Units are the UI camera's world units (orthographic size 1:
// the screen is 2 units high), times are seconds. Colours: the game runs in linear colour space; vertex colours and
// material Color properties are converted from sRGB (Unity's GammaToLinearSpace: HDR values above 1 by a 2.2 power).

export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : c < 1 ? Math.pow((c + 0.055) / 1.055, 2.4) : Math.pow(c, 2.2));
export const toSrgb = (c) => (c <= 0 ? 0 : c >= 1 ? 1 : c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// an AnimationCurve: keys [time, value, inSlope, outSlope] with unweighted tangents (cubic Hermite), constant outside
export function curve(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 1;
  while (keys[i][0] < t) i++;
  const [t0, v0, , m0] = keys[i - 1], [t1, v1, m1] = keys[i];
  const dt = t1 - t0, s = (t - t0) / dt, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * dt * m0 + (3 * s2 - 2 * s3) * v1 + (s3 - s2) * dt * m1;
}

// a Gradient in blend mode: colour keys [time, [r, g, b]] and alpha keys [time, a], stored (sRGB) values
function ramp(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 1;
  while (keys[i][0] < t) i++;
  const [t0, a] = keys[i - 1], [t1, b] = keys[i], f = (t - t0) / (t1 - t0);
  return Array.isArray(a) ? a.map((x, k) => x + (b[k] - x) * f) : a + (b - a) * f;
}
export const gradient = (g, t) => [...ramp(g.colors, t), ramp(g.alphas, t)];

// the FX_Touch prefab, as stored
const SPARK_SCALE = 0.3078823983669281; // Ring (3) and Ring (4) transform scale (scaling mode Local: shape, size, speed)
const SPARK = {
  scale: SPARK_SCALE,
  start: 0.5377358198165894, // start colour (grey)
  intensity: 5.992156982421875, // FX_MAT_Touch_Tri 2 _Color
  size: [[0, 0, 0, 0], [0.15445095300674438, 1, 0, 0], [1, 0, -2.1621501445770264, -2.1621501445770264]],
  color: {
    colors: [[0.18236057068741893, [1, 1, 1]], [0.2823529411764706, [0.37264150381088257, 0.7731872797012329, 1]],
      [0.46176852063782714, [0.37254902720451355, 0.7725490927696228, 1]],
      [0.6617685206378271, [0.3529411852359772, 0.729411780834198, 0.9450981020927429]],
      [0.8264744029907682, [0.37254902720451355, 0.7725490927696228, 1]]],
    alphas: [[0.2882429236285954, 1], [0.36470588235294116, 0], [0.47058823529411764, 1], [0.5735255970092317, 0],
      [0.6676432440680552, 1], [0.7558861676966506, 0], [0.8529488059815366, 1], [1, 1]],
  },
};
export const FX = {
  duration: 1, // FXTouch.Duration (the root system's duration): the effect stops this long after the release
  arc: {
    count: 2, life: 0.6, size: [0.14, 0.12], inner: 1, outer: 1.0637,
    intensity: 5.992156982421875, // FX_MAT_Touch_Tri3 Color_D20A2F66
    sizeCurve: [[0.00720977783203125, 0.4205089807510376, 2.4004733562469482, 2.4004733562469482],
      [0.21392822265625, 0.7159773111343384, 0.9115744829177856, 0.9115744829177856], [1, 1, 0, 0]],
    // angular velocity (rad/s), random between two curves
    spin: { scale: 11.170106887817383,
      a: [[0.14903903007507324, 1, 0, 0], [1, 0.4556182622909546, 0, 0]],
      b: [[0.1586538404226303, 0.7988165616989136, 0, 0], [1, -0.0650913417339325, 0, 0]] },
    // custom data x: the dissolve threshold
    dissolve: [[0, 1, 0, 0], [0.2, 0, 0, 2.4249367713928223], [1, 1, 0.27735635638237, 0.27735635638237]],
    color: { colors: [[0.1117723353933013, [1, 1, 1]], [0.5000076295109483, [0.2971698045730591, 0.6532865166664124, 1]]],
      alphas: [[0, 1], [1, 1]] },
  },
  flash: {
    life: 0.2, size: 0.12 * 2, intensity: 2, // FX_MAT_Touch_Cross2 _Color
    sizeCurve: [[0, 0.32583582401275635, 2.4004733562469482, 2.4004733562469482],
      [0.21392822265625, 0.7159773111343384, 0.9115744829177856, 0.9115744829177856], [1, 1, 0, 0]],
    color: { colors: [[0, [1, 1, 1]], [0.12059205004959182, [0.24056601524353027, 0.39061814546585083, 1]]],
      alphas: [[0, 1], [0.10882734416723888, 1], [1, 0]] },
  },
  burst: { ...SPARK, count: 4, life: [0.6, 0.7], speed: [0.3, 0.4], radius: 0.3 },
  drag: { ...SPARK, rate: 5, max: 50, life: [0.2, 0.4], speed: [0.2, 0.3], radius: 0.15 },
  sparkSize: [0.1, 0.2],
  trail: {
    time: 0.3, width: 0.005, minDistance: 0.01,
    intensity: 23.9686279296875, // FX_MAT_TouchFXTrail _Color
    color: { colors: [[0.020584420538643473, [0, 0.3905813694000244, 1]],
      [0.4205844205386435, [0, 0.09486991167068481, 0.2823529541492462]], [1, [0, 0, 0]]], alphas: [[0, 1], [1, 1]] },
  },
};

const between = (rand, [a, b]) => a + (b - a) * rand();

function spark(def, x, y, now, rand) {
  const angle = rand() * Math.PI * 2, s = def.scale;
  // the texture sheet's frame: frame over time (normalized) plus start frame (in frames), both random 0 to 0.5
  const frame = Math.floor(rand() * 0.5 * 2 + rand() * 0.5) % 2;
  return { kind: "spark", def, born: now, life: between(rand, def.life), x, y, dx: Math.cos(angle), dy: Math.sin(angle),
    radius: def.radius * s, speed: between(rand, def.speed) * s, size: between(rand, FX.sparkSize) * s, frame };
}

// a press at (x, y), in world units: the bursts stay there (ox, oy: world simulation space), the head (x, y) follows
// the pointer while it is held and the trail starts from it
export function press(x, y, now, rand = Math.random) {
  const items = [];
  for (let i = 0; i < FX.arc.count; i++) {
    items.push({ kind: "arc", born: now, life: FX.arc.life, size: between(rand, FX.arc.size), rot: rand() * Math.PI * 2,
      mix: rand() });
  }
  items.push({ kind: "flash", born: now, life: FX.flash.life });
  for (let i = 0; i < FX.burst.count; i++) items.push(spark(FX.burst, x, y, now, rand));
  return { ox: x, oy: y, x, y, pressed: true, released: null, items, trail: [{ x, y, t: now }], carry: 0, last: now };
}

// a drag to (x, y): the trail gets a point once the pointer is minDistance away from the last one, and Ring (4)
// emits along the way (rate over distance); { trail, sparks } false under reduced motion
export function drag(fx, x, y, now, rand = Math.random, { trail = true, sparks = true } = {}) {
  const dx = x - fx.x, dy = y - fx.y, dist = Math.hypot(dx, dy);
  if (sparks && dist > 0) {
    // fx.carry: the part of the next emission covered so far (a small epsilon keeps rounding from losing one)
    const total = dist * FX.drag.rate, EPS = 1e-9;
    let alive = fx.items.reduce((n, p) => n + (p.kind === "spark" && p.def === FX.drag ? 1 : 0), 0);
    for (let k = 1 - fx.carry; k <= total + EPS; k += 1) {
      if (alive >= FX.drag.max) break;
      const f = Math.min(1, k / total);
      fx.items.push(spark(FX.drag, fx.x + dx * f, fx.y + dy * f, now, rand));
      alive++;
    }
    fx.carry = Math.max(0, ((fx.carry + total + EPS) % 1) - EPS);
  }
  fx.x = x;
  fx.y = y;
  if (trail) {
    const end = fx.trail[fx.trail.length - 1];
    if (!end || Math.hypot(x - end.x, y - end.y) > FX.trail.minDistance) fx.trail.push({ x, y, t: now });
  } else {
    fx.trail = []; // not even the press point: the head would draw a line back to it
  }
}

export function release(fx, now) {
  fx.pressed = false;
  fx.released = now;
}

// advance to now: spin the arcs, drop what has expired; false once nothing is left to draw
export function step(fx, now) {
  const dt = Math.max(0, Math.min(0.1, now - fx.last));
  fx.last = now;
  fx.items = fx.items.filter((p) => now - p.born < p.life);
  for (const p of fx.items) {
    if (p.kind !== "arc") continue;
    const t = (now - p.born) / p.life, s = FX.arc.spin;
    p.rot += (curve(s.a, t) + (curve(s.b, t) - curve(s.a, t)) * p.mix) * s.scale * dt;
  }
  // the system stops a second after the release: its trail is cleared then
  if (!fx.pressed && fx.released != null && now - fx.released >= FX.duration) fx.trail = [];
  fx.trail = fx.trail.filter((pt) => now - pt.t < FX.trail.time);
  return fx.items.length > 0 || fx.trail.length > 0;
}

// what to draw for each part, in linear light (values above 1 saturate)
export function arcState(p, now) {
  const a = FX.arc, t = (now - p.born) / p.life;
  const [r, g, b, alpha] = gradient(a.color, t), k = toLinear(a.intensity);
  return { size: p.size * curve(a.sizeCurve, t), rot: p.rot, threshold: curve(a.dissolve, t),
    color: [toLinear(r) * k, toLinear(g) * k, toLinear(b) * k], alpha };
}

export function flashState(p, now) {
  const f = FX.flash, t = (now - p.born) / p.life;
  const [r, g, b, alpha] = gradient(f.color, t), k = toLinear(f.intensity);
  return { size: f.size * curve(f.sizeCurve, t), color: [toLinear(r) * k, toLinear(g) * k, toLinear(b) * k], alpha };
}

// The page composites in sRGB values, the game in linear light. The flash's blend (One OneMinusSrcAlpha),
//   result = behind * (1 - alpha) + color   (linear)
// is drawn as behind * keep (a multiply layer), then screened with add (a screen layer): exact over black and over
// white, close in between (a screen in sRGB values is near an addition in linear light). Per channel, sRGB values.
export function overBlend(color, alpha) {
  const add = color.map(toSrgb);
  const keep = color.map((c, i) => (add[i] >= 1 ? 1 : Math.min(1, Math.max(0, (toSrgb(1 - alpha + c) - add[i]) / (1 - add[i])))));
  return { add, keep };
}

export function sparkState(p, now) {
  const age = now - p.born, t = age / p.life, d = p.def;
  const [r, g, b, alpha] = gradient(d.color, t), k = toLinear(d.intensity) * alpha;
  const dist = p.radius + p.speed * age;
  return { x: p.x + p.dx * dist, y: p.y + p.dy * dist, size: p.size * curve(d.size, t), frame: p.frame,
    color: [toLinear(r * d.start) * k, toLinear(g * d.start) * k, toLinear(b * d.start) * k] };
}

// the trail from the head (the effect's position) back to its oldest point: vertices with u along its length (0 at
// the head) and the colour of each segment at its middle, without the texture
export function trailState(fx) {
  const pts = [{ x: fx.x, y: fx.y }, ...fx.trail.slice().reverse()];
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = lens[lens.length - 1];
  if (!(total > 0)) return { points: [], segments: [] };
  const tr = FX.trail, k = toLinear(tr.intensity), segments = [];
  for (let i = 1; i < pts.length; i++) {
    if (lens[i] === lens[i - 1]) continue;
    const u = (lens[i - 1] + lens[i]) / 2 / total, [r, g, b, a] = gradient(tr.color, u);
    segments.push({ from: i - 1, to: i, u, color: [toLinear(r) * k * a, toLinear(g) * k * a, toLinear(b) * k * a] });
  }
  return { points: pts, segments, length: total };
}
