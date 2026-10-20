// The memorial lobby's intro (lobby.json "intro", gameassets/intro.py): the Timeline the lobby prefab's
// PlayableDirector plays when the lobby is entered. Played on the lobby's own clock (the players' frame time, GameTime
// like the director) from the first frame the lobby is on screen:
// - its Spine tracks set their clips on the skeleton's AnimationState as spine-unity's SpineAnimationStateMixerBehaviour
//   does at run time: a clip that starts (weight 0 to above 0) is set with its mix and its time in the clip, and the
//   AnimationState runs on its own; a clip that ends with no other clip of its track playing leaves the track empty
//   unless it says not to (Idle_01, which keeps playing after the intro);
// - its recorded clips' curves switch GameObjects on and off (the flash sprite, intro-only effects, the depth of field
//   volume, scene skeletons), move transforms (skeletons sliding in, the background zoom, bokeh), colour the flash
//   sprites, weigh the post-processing volumes and set particle and renderer properties, evaluated at the time;
// - its control clips switch their GameObject on for the clip and its particle systems play from the clip's start
//   (ParticleControlPlayable: stopped and cleared when the timeline is built, simulated from the clip's start, its
//   clip-in seconds in); its activation clips switch theirs;
// - its sounds play at their times, at the app's voice volume, never when muted.
// A tap on the lobby skips it, as the game's does: the timeline jumps to its end. At its end the director's wrap mode
// None puts back what it changed (Unity reverts a stopped timeline's bindings); Hold (Shiroko) keeps its last frame.
// The idle, its clips and the random idle clips start as the lobby's SpineCharacter starts them (lobby.js); the intro
// takes over the track its Spine clips play on.
import * as Linear from "./linear.js";
import * as Dof from "./lobby-dof.js";
import { IDENTITY, mul, euler } from "./particles.js";

// --- curves --------------------------------------------------------------------------------------------------------

// a curve at time t (intro.py evaluate): a streamed curve's last key at or before t ({"s": [[time, a, b, c, d]]},
// ((a x + b) x + c) x + d with x the time since the key), a dense curve's frames lerped ({"d": [begin, rate, values]}),
// a constant ({"k": v})
export function evaluate(c, t) {
  if (!c) return 0;
  if (c.k !== undefined) return c.k;
  if (c.s) {
    const keys = c.s;
    let key = keys[0];
    for (let i = 1; i < keys.length && keys[i][0] <= t; i++) key = keys[i];
    const x = key[0] > -1e8 ? Math.max(0, t - key[0]) : 0;
    return ((key[1] * x + key[2]) * x + key[3]) * x + key[4];
  }
  const [begin, rate, values] = c.d || [0, 30, []];
  if (!values.length) return 0;
  const f = Math.min(Math.max((t - begin) * rate, 0), values.length - 1), i = Math.floor(f), j = Math.min(i + 1, values.length - 1);
  return values[i] + (values[j] - values[i]) * (f - i);
}

// --- GameObjects ---------------------------------------------------------------------------------------------------

// a GameObject's own activity at time t: as at rest, else its animated m_IsActive (on above 0.5), else its activation
// clips (on during one, off outside: ActivationMixerPlayable); a control clip switches it on for the clip and off once
// it has ended (ActivationControlPlayable)
export function activeAt(n, t) {
  let on = n.own;
  if (n.curve) on = evaluate(n.curve, t) > 0.5;
  if (n.activation) on = n.activation.some(([a, d]) => t >= a && t < a + d);
  for (const c of n.control) {
    if (t >= c.t && t < c.t + c.d) return true;
    if (t >= c.t + c.d) on = false;
  }
  return on;
}

// a 3 x 4 matrix from position, rotation (quaternion) and scale, as particles.py trs
export function trs(p, q, s) {
  let [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  return [(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y - z * w) * s[1], 2 * (x * z + y * w) * s[2], p[0],
    2 * (x * y + z * w) * s[0], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z - x * w) * s[2], p[1],
    2 * (x * z - y * w) * s[0], 2 * (y * z + x * w) * s[1], (1 - 2 * (x * x + y * y)) * s[2], p[2]];
}
// a moved GameObject's local matrix at time t: its animated position, rotation (quaternion or Euler angles in
// degrees) and scale, the rest from its rest transform
export function localAt(n, t) {
  const r = n.trs, pick = (curves, k, rest) => (curves?.[k] ? evaluate(curves[k], t) : rest);
  const p = [0, 1, 2].map((k) => pick(n.position, k, r[k]));
  const s = [0, 1, 2].map((k) => pick(n.scale, k, r[7 + k]));
  if (n.euler) {
    const R = euler(pick(n.euler, 0, 0), pick(n.euler, 1, 0), pick(n.euler, 2, 0));
    return mul([1, 0, 0, p[0], 0, 1, 0, p[1], 0, 0, 1, p[2]], mul(R, [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0]));
  }
  const q = [0, 1, 2, 3].map((k) => pick(n.rotation, k, r[3 + k]));
  return trs(p, q, s);
}
// M0 L(i1) M1 ... L(ik) Mk (intro.py moves) with the nodes' local matrices now
export function compose(moves, local) {
  let W = moves.m[0];
  moves.nodes.forEach((i, k) => { W = mul(mul(W, local(i)), moves.m[k + 1]); });
  return W;
}

// --- post-processing -----------------------------------------------------------------------------------------------

// the volume parameters' defaults in URP 12, which every frame starts from (lobby.py VOLUME_DEFAULTS, and depth of
// field: Off, far blur from 10 to 30, radius 1)
const DEFAULTS = {
  ChromaticAberration: { intensity: 0 },
  LiftGammaGain: { lift: [1, 1, 1, 0], gamma: [1, 1, 1, 0], gain: [1, 1, 1, 0] },
  PaniniProjection: { distance: 0, cropToFit: 1 },
  ColorAdjustments: { postExposure: 0, contrast: 0, colorFilter: [1, 1, 1, 1], hueShift: 0, saturation: 0 },
  DepthOfField: { mode: 0, gaussianStart: 10, gaussianEnd: 30, gaussianMaxRadius: 1, highQualitySampling: 0, focusDistance: 10,
    aperture: 5.6, focalLength: 50 },
};
// parameters that do not interpolate: an enum or a bool takes the volume's value once its weight is above 0
const DISCRETE = new Set(["mode", "highQualitySampling"]);
const KEYS = { ChromaticAberration: "chromaticAberration", LiftGammaGain: "liftGammaGain", PaniniProjection: "panini",
  ColorAdjustments: "colorAdjustments" };
const lerp = (a, b, t) => (Array.isArray(a) ? a.map((x, i) => x + (b[i] - x) * t) : a + (b - a) * t);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// What the volumes leave on screen, blended as URP's VolumeManager does (lobby.py post_processing): the enabled,
// active, global volumes on the camera's layers with a weight above 0, by priority (equal ones in hierarchy order),
// each active component's overridden parameters lerped from the stack's by the volume's weight. volumes: [{weight,
// priority, global, enabled, active, layer, components: [{name, active, params}]}]. Returns lobby.json's "post" form,
// with "dof": {radius} while Gaussian depth of field is on.
export function blend(volumes) {
  const stack = JSON.parse(JSON.stringify(DEFAULTS));
  const ordered = volumes.map((v, i) => [v, i]).sort((a, b) => (a[0].priority || 0) - (b[0].priority || 0) || a[1] - b[1]);
  for (const [v] of ordered) {
    if (!v.global || !v.enabled || !v.active || v.layer === false || !(v.weight > 0)) continue;
    const w = Math.min(1, v.weight);
    for (const c of v.components || []) {
      const params = stack[c.name];
      if (!params || !c.active) continue;
      for (const [key, value] of Object.entries(c.params || {})) {
        if (!(key in params)) continue;
        params[key] = DISCRETE.has(key) ? value : lerp(params[key], value, w);
      }
    }
  }
  const post = {};
  for (const [kind, params] of Object.entries(stack)) {
    if (kind === "DepthOfField") {
      if (Math.round(params.mode) === 1) post.dof = { radius: params.gaussianMaxRadius, start: params.gaussianStart, end: params.gaussianEnd };
      continue;
    }
    if (same(params, DEFAULTS[kind]) || (kind === "PaniniProjection" && params.distance <= 0)
      || (kind === "ChromaticAberration" && params.intensity <= 0)) continue;
    const out = { ...params };
    if (kind === "ColorAdjustments") out.colorFilter = out.colorFilter.slice(0, 3);
    post[KEYS[kind]] = kind === "ChromaticAberration" ? out.intensity : out;
  }
  return post;
}

// --- Spine tracks --------------------------------------------------------------------------------------------------

// the clips of a Spine track that play at time t (weight above 0: from their start to their end)
export const playingAt = (clips, t) => clips.filter((c) => t >= c.t && t < c.t + c.d);

// a clip starts on the skeleton's AnimationState (SpineAnimationStateMixerBehaviour.ProcessFrame at run time): its
// animation with the clip's mix (the skeleton's default without a custom one; an empty track first fades in from
// the setup pose), at its time in the clip; `delta`: the frame time the AnimationState adds right after
export function startClip(st, data, track, c, t, delta) {
  if (!c.anim) {
    st.setEmptyAnimation(track, c.mix ?? st.data.defaultMix);
    return null;
  }
  const anim = data.findAnimation(c.anim);
  if (!anim) return null;
  const custom = c.mix ?? 0, cur = st.getCurrent(track);
  let e;
  if (!cur && custom > 0) {
    st.setEmptyAnimation(track, 0);
    e = st.addAnimationWith(track, anim, c.loop, 0);
  } else e = st.setAnimationWith(track, anim, c.loop);
  const speed = c.speed ?? 1, local = Math.max(0, t - c.t) * speed + (c.in || 0);
  e.trackTime = Math.max(0, (local - delta) * speed);
  e.timeScale = speed;
  e.holdPrevious = !!c.hold;
  e.alpha = c.alpha ?? 1;
  if (c.mix != null) e.mixDuration = c.mix;
  return e;
}

// --- the intro -----------------------------------------------------------------------------------------------------

// Plays a lobby's intro. env: {layers: [{name, player, introOnly}] in stacking order, fx (particles-gl.js), post (the
// rest post-processing), host, sfx(id, set) (plays a sound event by the app's sound settings; its audio joins `set`),
// screen(player) (the layer moved: its post-processing screen again), clear(player, on), bone(skeleton, bone),
// visible() (the lobby is on screen), now() (the frame's time stamp, for tests)}. Returns {frame(player, delta), skip(),
// running(), pending(), done(), state(), dispose()}.
export function create(intro, env) {
  const D = intro.duration || 0, hold = intro.wrap === "hold";
  const nodes = (intro.nodes || []).map((n) => ({ ...n, curve: null, control: [], activation: null, on: n.own, L: null }));
  const volumes = (intro.volumes || []).map((v) => ({ ...v, weightCurve: null, enabledCurve: null }));
  const effects = env.fx?.effects || null, systems = effects?.systems || [], sprites = env.fx?.sprites || [];
  const sysProps = new Map(), spriteProps = new Map();
  for (const p of intro.props || []) {
    if (p.on === "node") {
      const n = nodes[p.i];
      if (!n) continue;
      if (p.attr === "active") n.curve = p.c;
      else (n[p.attr] ||= [])[p.k] = p.c;
    } else if (p.on === "volume" && volumes[p.i]) volumes[p.i][p.attr === "weight" ? "weightCurve" : "enabledCurve"] = p.c;
    else if (p.on === "system" && systems[p.i]) (sysProps.get(p.i) || sysProps.set(p.i, []).get(p.i)).push(p);
    else if (p.on === "sprite" && sprites[p.i]) (spriteProps.get(p.i) || spriteProps.set(p.i, []).get(p.i)).push(p);
  }
  for (const c of intro.control || []) nodes[c.node]?.control.push(c);
  for (const a of intro.activation || []) if (nodes[a.node]) nodes[a.node].activation = a.clips;
  const moved = nodes.filter((n) => n.trs);
  const gateOn = (gate) => gate.every((i) => nodes[i]?.on);
  const local = (i) => nodes[i].L || IDENTITY;

  // the drawables it switches or moves; a skeleton's scale is its GameObject's times its skeleton data's (from rest)
  const restLocal = (i) => { const r = nodes[i].trs; return r ? trs(r.slice(0, 3), r.slice(3, 7), r.slice(7, 10)) : IDENTITY; };
  const layerItems = env.layers.map((l) => {
    const layer = l.player.bamtLayer, W = layer.moves ? compose(layer.moves, restLocal) : null;
    return { l, layer, rest: { x: layer.x, y: layer.y, scale: layer.scale }, shown: !l.introOnly,
      ds: W ? layer.scale / (Math.hypot(W[0], W[4]) || 1) : 1 };
  });
  const controlOf = (def) => (def.gate || []).flatMap((i) => (nodes[i]?.control || []).filter((c) => c.particles));
  // the skeletons it moves: the effects on their bones go with them
  const movedSkeletons = new Set(layerItems.filter((it) => it.layer.moves).map((it) => it.layer.name));
  const onMoved = (def) => !!def.anchor && movedSkeletons.has(def.anchor.skeleton);
  const skeletonW = {}; // a moved skeleton's GameObject matrix this frame
  const sysItems = systems.map((s, i) => ({ s, i, controls: controlOf(s.def), props: sysProps.get(i) || [], on: s.def.rest !== 0 }))
    .filter((e) => e.s.def.gate || e.s.def.moves || e.props.length || onMoved(e.s.def));
  const spriteItems = sprites.map((sp, i) => ({ sp, props: spriteProps.get(i) || [] }));
  const tracks = (intro.spine || []).map((t) => ({ ...t, prev: new Set(), started: null, end: true, endMix: 0.1 }));
  const sounds = (intro.sounds || []).slice().sort((a, b) => a.t - b.t);
  const audios = new Set();

  let T = 0, stamp = null, started = false, finished = false, skipped = false, soundAt = 0, lastPost = null;
  let settle;
  const settled = new Promise((r) => { settle = r; });

  // --- one frame's state at time t ---
  function apply(t, { play = true } = {}) {
    for (const n of nodes) n.on = activeAt(n, t);
    for (const n of moved) n.L = localAt(n, t);
    // skeletons: shown while their GameObjects are on, placed where their transforms are
    let lowest = null;
    for (const it of layerItems) {
      const def = it.layer;
      const shown = def.gate ? def.base !== false && gateOn(def.gate) : !it.l.introOnly;
      show(it, shown);
      if (def.moves) {
        const W = compose(def.moves, local);
        skeletonW[def.name] = W;
        Object.assign(def, { x: W[3], y: W[7], scale: Math.hypot(W[0], W[4]) * it.ds });
        env.screen?.(it.l.player);
      }
      if (shown && !lowest) lowest = it;
    }
    clearOn(lowest);
    // particle systems: switched on (from their start) and off, moved, recoloured; one a control clip plays runs only
    // during that clip
    for (const e of sysItems) {
      const def = e.s.def, clip = e.controls.find((x) => t >= x.t && t < x.t + x.d);
      const on = (def.gate ? def.base !== false && gateOn(def.gate) : true) && (!e.controls.length || !!clip);
      if (on !== e.on) {
        e.on = on;
        if (!on) effects.stop(e.s);
        else if (!def.isSub) {
          if (clip) effects.restart(e.s, Math.max(0, t - clip.t) + (clip.in || 0));
          else if (def.playOnAwake !== 0) effects.restart(e.s);
        }
      }
      if (def.moves) {
        const W = compose(def.moves, local);
        if (def.moves.of === "rel") e.s.rel = W; else e.s.static = W;
      }
      if (onMoved(def)) e.s.go = skeletonW[def.anchor.skeleton];
      for (const p of e.props) {
        const v = evaluate(p.c, t);
        if (p.attr === "speed") e.s.speed = v;
        else if (p.attr === "startColor") {
          const base = def.main.color?.col || [1, 1, 1, 1], col = (e.s.startColor?.col || base).slice();
          col[p.k] = v;
          e.s.startColor = { col };
        } else if (p.attr === "material") {
          const c = ((e.s.colors ||= {})[p.name] ||= (p.base || [1, 1, 1, 1]).slice());
          c[p.k] = v;
        }
      }
    }
    // sprites (the flash, the fades): shown, coloured and placed
    for (const { sp, props } of spriteItems) {
      const def = sp.def;
      sp.visible = def.gate ? def.base !== false && gateOn(def.gate) : def.rest !== 0;
      const color = def.color.slice();
      for (const p of props) {
        const v = evaluate(p.c, t);
        if (p.attr === "color") color[p.k] = v;
        else if (p.attr === "material") ((sp.colors ||= {})[p.name] ||= (p.base || [1, 1, 1, 1]).slice())[p.k] = v;
      }
      sp.color = color;
      sp.M = placeSprite(def, def.moves ? compose(def.moves, local) : null);
    }
    // the post-processing volumes
    if (volumes.length) {
      for (const v of volumes) {
        v.active = v.gate ? v.base !== false && gateOn(v.gate) : v.active;
        if (v.weightCurve) v.weight = evaluate(v.weightCurve, t);
        if (v.enabledCurve) v.enabled = evaluate(v.enabledCurve, t) > 0.5;
      }
      setPost(blend(volumes));
    }
    // the sounds whose time has come (a skip plays none)
    while (soundAt < sounds.length && sounds[soundAt].t <= t) {
      const s = sounds[soundAt++];
      if (play) env.sfx?.(s.id, audios); // the sound's audio joins `audios` once it plays
    }
  }
  // a sprite's matrix: on its bone when it hangs on one, else its static (or animated) one
  function placeSprite(def, W) {
    const a = def.anchor;
    if (a && env.bone) {
      const b = env.bone(a.skeleton, a.bone);
      if (b) return mul(skeletonW[a.skeleton] || a.go, mul([b.a, b.b, 0, b.worldX * a.ds, b.c, b.d, 0, b.worldY * a.ds, 0, 0, 1, 0], def.moves?.of === "rel" && W ? W : def.rel));
    }
    return W && def.moves?.of !== "rel" ? W : def.static;
  }
  function show(it, on) {
    if (it.shown === on) return;
    it.shown = on;
    // hidden, and left out of the stills and fades taken of the lobby's canvases (lobby-off)
    const el = it.l.player.parent || it.l.player.dom?.parentElement;
    if (el) { el.style.visibility = on ? "" : "hidden"; el.classList.toggle("lobby-off", !on); }
  }
  let clearOwner = null;
  function clearOn(it) {
    const p = it?.l.player || null;
    if (p === clearOwner) return;
    if (clearOwner) env.clear?.(clearOwner, false);
    if (p) env.clear?.(p, true);
    clearOwner = p;
  }
  function setPost(post) {
    const key = JSON.stringify(post);
    if (key === lastPost) return;
    lastPost = key;
    for (const { l } of layerItems) {
      Linear.setPost(l.player, post);
      Dof.set(l.player, post?.dof ? { radius: post.dof.radius } : null, Linear);
    }
  }

  // the Spine clips of the tracks on one player's skeleton that start or end now
  function spine(p, t, delta) {
    const st = p.animationState, data = p.skeleton?.data, name = p.bamtLayer?.name;
    if (!st || !data) return;
    for (const tr of tracks) {
      if (tr.skeleton !== name) continue;
      const playing = playingAt(tr.clips, t);
      for (const c of playing.filter((x) => !tr.prev.has(x)).slice(0, 2)) {
        tr.end = c.end !== false;
        tr.endMix = c.endMix ?? 0.1;
        tr.started = startClip(st, data, tr.track, c, t, delta);
      }
      if (!playing.length && tr.started && tr.end && st.getCurrent(tr.track) === tr.started) {
        st.setEmptyAnimation(tr.track, tr.endMix);
        tr.started = null;
      }
      tr.prev = new Set(playing);
    }
  }

  // the timeline built: the particle systems its control clips play stop and clear, until their clip
  function begin() {
    for (const e of sysItems) if (e.controls.length && e.on) { effects.stop(e.s); e.on = false; }
    env.host?.addEventListener("pointerdown", onTap, true);
  }
  // its end: wrap None puts back what it changed, Hold keeps the last frame
  function finish(byTap) {
    if (finished) return;
    if (byTap) {
      skipped = true;
      for (const a of audios) a.pause();
      audios.clear();
      audios.closed = true; // a sound still loading never starts
      soundAt = sounds.length;
    }
    if (started || byTap) {
      const t = Math.max(0, D - 1e-4);
      apply(hold ? D : t, { play: !byTap });
      for (const { l } of layerItems) spine(l.player, t, 0);
    }
    finished = true;
    T = D;
    if (!hold) revert();
    env.host?.removeEventListener("pointerdown", onTap, true);
    settle();
  }
  function revert() {
    for (const n of nodes) n.on = n.own;
    for (const it of layerItems) {
      show(it, !it.l.introOnly);
      if (it.layer.moves) { Object.assign(it.layer, it.rest); env.screen?.(it.l.player); }
    }
    clearOn(layerItems.find((it) => it.shown));
    for (const e of sysItems) {
      const def = e.s.def, on = def.rest !== 0;
      if (on !== e.on) {
        e.on = on;
        if (!on) effects.stop(e.s);
        else if (!def.isSub && def.playOnAwake !== 0) effects.restart(e.s);
      }
      delete e.s.static; delete e.s.rel; delete e.s.go; delete e.s.speed; delete e.s.startColor; delete e.s.colors;
    }
    for (const { sp } of spriteItems) {
      sp.visible = sp.def.rest !== 0;
      sp.color = sp.def.color;
      sp.M = sp.def.static;
      delete sp.colors;
    }
    if (volumes.length) {
      lastPost = null;
      for (const { l } of layerItems) { Linear.setPost(l.player, env.post); Dof.set(l.player, null, Linear); }
    }
  }
  function onTap(e) {
    if (!started || finished) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    finish(true);
  }

  return {
    // every player's frame hook, before its animation update: the clock (once a frame, from the first frame the
    // lobby is on screen), the intro's state, then this player's Spine clips
    frame(p, delta) {
      if (finished) return;
      const now = env.now ? env.now() : typeof document !== "undefined" ? document.timeline?.currentTime ?? performance.now() : performance.now();
      if (now !== stamp) {
        stamp = now;
        if (!started && (!env.visible || env.visible())) { started = true; T = 0; begin(); apply(0); }
        else if (started) {
          T += Math.max(0, delta);
          if (T >= D) { finish(false); return; }
          apply(T);
        }
      }
      if (started) spine(p, T, delta);
    },
    skip() { if (!finished) finish(true); },
    running: () => started && !finished,
    pending: () => !finished,
    done: () => settled,
    state: () => ({ t: +T.toFixed(4), duration: D, wrap: intro.wrap, started, finished, skipped,
      nodes: nodes.map((n) => n.on), volumes: volumes.map((v) => ({ weight: +(+v.weight).toFixed(4), active: !!v.active, enabled: !!v.enabled })),
      post: lastPost ? JSON.parse(lastPost) : null,
      sprites: sprites.map((s) => ({ visible: s.visible, color: s.color.map((c) => +c.toFixed(4)) })),
      layers: layerItems.map((it) => ({ name: it.layer.name, shown: it.shown, x: +it.layer.x.toFixed(2), y: +it.layer.y.toFixed(2), scale: +it.layer.scale.toFixed(5) })),
      systems: sysItems.map((e) => ({ name: e.s.def.name, on: e.on, particles: e.s.particles.length })),
      tracks: tracks.map((tr) => ({ skeleton: tr.skeleton, current: tr.started?.animation?.name || null })) }),
    // the lobby closes: its sounds stop, the depth of field's targets go
    dispose() {
      for (const a of audios) a.pause();
      audios.clear();
      audios.closed = true;
      env.host?.removeEventListener("pointerdown", onTap, true);
      for (const { l } of layerItems) Dof.detach(l.player, Linear);
      finished = true;
      settle();
    },
  };
}
