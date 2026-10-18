// Fullscreen memorial lobby interaction, as in the game and from its own data (lobby.json: the prefab's SpineDragIK
// and SpineCharacterBodyTouch boxes; lobby.js plays the clips):
// - press and hold on the head: after the trigger delay the pat clips play and the Touch_Point bone follows the pointer
//   inside its box (the skeleton's own constraints make the hair and face follow); on release the end clips play and
//   the bone eases back. Cheek pinch, hand follow and the other drag kinds work the same way on their bones.
// - press and drag anywhere else: the eyes follow (Touch_Eye). During a dialogue only the bone follows and the
//   dialogue goes on; any other drag ends it.
// - tap on the body: the next dialogue.
// - mouse wheel or trackpad pinch: zoom at the pointer; right- or middle-button drag and the horizontal wheel pan.
// Positions are NGUI units (lobby.js): the stage shows the current view, each skeleton sits at its prefab offset and
// scale. Lobbies without prefab data get boxes around the character's own bones (medians over the game's lobbies).

const SLOP = { mouse: 10, pen: 10, touch: 24 };  // stage px a tap may move (NGUI's mouse click threshold is 10)
const WHEEL = 0.0015;                            // zoom by exp(-deltaY * WHEEL) per wheel pixel
const STAGE = { w: 1920, h: 1080 };

let lobby = null, items = [], bodies = [], host = null, press = null, pointer = null, gesture = 1;
const clamp = (v, a, b) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));

// per lobby: the drags resolved to their skeletons' bones, the body boxes; null clears
export function setup(api) {
  detach();
  lobby = api;
  items = [];
  bodies = [];
  if (!api?.main) return;
  const byName = new Map(api.players.filter((p) => p.bamtLayer).map((p) => [p.bamtLayer.name, p]));
  const resolve = (list) => list.filter((d) => d.enabled !== false).map((d) => {
    const player = byName.get(d.skeleton), bone = player?.skeleton.findBone(d.bone);
    return bone ? { d, player, bone, cur: [...d.orig], started: false, resting: true } : null;
  }).filter(Boolean);
  items = resolve(api.info?.drags || []);
  bodies = (api.info?.touches || []).filter((t) => t.enabled !== false && byName.has(t.skeleton));
  // no prefab data, or a mod whose skeletons the prefab does not know: boxes around the main skeleton's bones
  if (!items.length) items = resolve(fallbackDrags(api.main));
  if (!bodies.length) bodies = fallbackBodies(api.main);
}

// the typical boxes of the game's lobbies (medians of 272), around the bones in the current pose, in NGUI units
function around(p, bone, dx, dy, w, h) {
  const l = p.bamtLayer, x = l.x + (bone.worldX + dx) * l.scale, y = l.y + (bone.worldY + dy) * l.scale;
  return [x - (w * l.scale) / 2, y - (h * l.scale) / 2, x + (w * l.scale) / 2, y + (h * l.scale) / 2];
}
function fallbackDrags(p) {
  const out = [], sk = p.skeleton, name = p.bamtLayer.name;
  const drag = (bone, extra) => {
    const o = [bone.data.x, bone.data.y];
    return { skeleton: name, bone: bone.data.name, orig: o, offset: [0, 0], rot: 0, delay: 0.1, enabled: true, ...extra,
      min: [o[0] - extra.reach[0], o[1] - extra.reach[1]], max: [o[0] + extra.reach[0], o[1] + extra.reach[1]] };
  };
  const pat = sk.findBone("Touch_Point"), eye = sk.findBone("Touch_Eye");
  if (pat) out.push(drag(pat, { kind: "pat", rect: around(p, pat, 0, 75, 460, 290), depth: -89, reach: [5, 41],
    drag: 0.21, release: 0.15, ing: "Pat_01_M", end: "PatEnd_01_M" }));
  if (eye) out.push(drag(eye, { kind: "look", rect: [-1e6, -1e6, 1e6, 1e6], depth: -100, reach: [66, 82],
    drag: 0.16, release: 0.07, ing: "Look_01_M", end: "LookEnd_01_M" }));
  return out;
}
function fallbackBodies(p) {
  const bone = p.skeleton.findBone("Touch_Point");
  return bone ? [{ skeleton: p.bamtLayer.name, rect: around(p, bone, 0, -800, 880, 1000), rot: 0, depth: -90 }] : [];
}

// a point (NGUI units) inside a box [left, bottom, right, top] turned by rot degrees about its centre
function contains(r, rot, u, v) {
  if (!r) return false;
  if (rot) {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, a = (-rot * Math.PI) / 180;
    const du = u - cx, dv = v - cy;
    [u, v] = [cx + du * Math.cos(a) - dv * Math.sin(a), cy + du * Math.sin(a) + dv * Math.cos(a)];
  }
  return u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3];
}
// the topmost box under a stage point: the highest widget depth wins (pat and pinch above the body, the full-screen
// eye-follow box below everything), then prefab order
function hit(sx, sy) {
  const [u, v] = lobby.toWorld(sx, sy);
  const found = [
    ...items.map((it, i) => ({ type: "drag", it, depth: it.d.depth ?? 0, i, box: it.d })),
    ...bodies.map((t, i) => ({ type: "body", t, depth: t.depth ?? 0, i: items.length + i, box: t })),
  ].filter((c) => contains(c.box.rect, c.box.rot, u, v));
  found.sort((a, b) => b.depth - a.depth || a.i - b.i);
  return found[0] || null;
}
const lookAt = (sx, sy) => {
  const [u, v] = lobby.toWorld(sx, sy);
  return items.find((it) => it.d.kind === "look" && contains(it.d.rect, it.d.rot, u, v));
};

function stagePoint(e) {
  const r = host.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * STAGE.w, ((e.clientY - r.top) / r.height) * STAGE.h];
}

function start(it) {
  if (it.started) return;
  it.started = true;
  it.resting = false;
  lobby.pause();
  // eye follow during a dialogue: the bone follows, the look clips stay off the talk tracks
  if (lobby.talking() && it.d.kind === "look") { it.clipless = true; cursor(); return; }
  if (lobby.talking()) lobby.stopTalk();
  lobby.interrupt();
  if (it.d.ing) lobby.playClip(it.player, it.d.ing);
  cursor();
}
function end(it) {
  if (!it.started) return; // let go before the trigger delay: nothing, like the game
  it.started = false;
  lobby.resume();
  if (it.clipless) { it.clipless = false; return; }
  if (it.d.end && it.player.skeleton.data.findAnimation(it.d.end)) lobby.playClip(it.player, it.d.end);
  else if (it.d.ing) lobby.clearClip(it.player, it.d.ing);
}

// one press at a time, owned by its pointer: a second finger neither starts, steers nor ends anything
const other = (e) => press && e.pointerId !== press.id;

function down(e) {
  if (!lobby || press) return;
  const [sx, sy] = stagePoint(e);
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    press = { id: e.pointerId, pan: true, last: [sx, sy] };
    host.setPointerCapture?.(e.pointerId);
    cursor();
    return;
  }
  if (e.button !== 0 || lobby.blocked()) return;
  host.setPointerCapture?.(e.pointerId);
  pointer = [sx, sy];
  const h = hit(sx, sy);
  press = { id: e.pointerId, at: [sx, sy], h, moved: false, timer: null, slop: SLOP[e.pointerType] ?? 10 };
  if (h?.type === "drag") {
    const my = press;
    press.timer = setTimeout(() => { if (press === my) start(h.it); }, (h.it.d.delay ?? 0.1) * 1000);
  }
  cursor();
}
function move(e) {
  if (!lobby || other(e)) return;
  const [sx, sy] = stagePoint(e);
  if (press?.pan) {
    lobby.panBy(sx - press.last[0], sy - press.last[1]);
    press.last = [sx, sy];
    return;
  }
  pointer = [sx, sy];
  if (!press) { cursor(sx, sy); return; }
  if (!press.moved && Math.hypot(sx - press.at[0], sy - press.at[1]) > press.slop) {
    press.moved = true;
    // a press on the body that moves is no tap: it becomes the eye follow behind it
    if (press.h?.type === "body") {
      const look = lookAt(sx, sy);
      if (look) { press.h = { type: "drag", it: look }; start(look); }
    }
  }
}
function up(e) {
  if (!press || other(e)) return;
  const p = press;
  press = null;
  if (!p.pan) {
    clearTimeout(p.timer);
    if (p.h?.type === "drag") end(p.h.it);
    else if (p.h?.type === "body" && !p.moved) lobby.next();
  }
  cursor(...(pointer || []));
}
function wheel(e) {
  if (!lobby) return;
  e.preventDefault();
  const [sx, sy] = stagePoint(e), unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  // vertical wheel and trackpad pinch (ctrlKey) zoom; horizontal scrolling pans, which only moves while zoomed in
  if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) lobby.zoomAt(Math.exp(-e.deltaY * unit * WHEEL * (e.ctrlKey ? 4 : 1)), sx, sy);
  else lobby.panBy(-e.deltaX * unit, 0);
}
// Safari / WKWebView trackpad pinch
function gestureStart(e) { e.preventDefault(); gesture = 1; }
function gestureChange(e) {
  if (!lobby) return;
  e.preventDefault();
  const [sx, sy] = stagePoint(e);
  lobby.zoomAt(e.scale / gesture, sx, sy);
  gesture = e.scale;
}
const menu = (e) => e.preventDefault();

// the pointer shows what a press would do: grab over a drag box, grabbing while dragging, a hand over the body
function cursor(sx, sy) {
  if (!host) return;
  const dragging = press?.pan || press?.h?.it?.started;
  const h = !press && sx != null && lobby ? hit(sx, sy) : press?.h;
  host.classList.toggle("grabbing", !!dragging);
  host.classList.toggle("grab", !dragging && h?.type === "drag" && h.it.d.kind !== "look");
  host.classList.toggle("talk", !dragging && h?.type === "body");
}

const handlers = [["pointerdown", down], ["pointermove", move], ["pointerup", up], ["pointercancel", up],
  ["wheel", wheel, { passive: false }], ["gesturestart", gestureStart], ["gesturechange", gestureChange], ["contextmenu", menu]];
export function attach(el) {
  if (!el || host === el || !lobby) return;
  detach();
  host = el;
  for (const [type, fn, opts] of handlers) host.addEventListener(type, fn, opts);
}
// leaving fullscreen: a running drag ends as if released
export function detach() {
  if (press && !press.pan) {
    clearTimeout(press.timer);
    if (press.h?.type === "drag") end(press.h.it);
  }
  press = null;
  pointer = null;
  if (!host) return;
  for (const [type, fn, opts] of handlers) host.removeEventListener(type, fn, opts);
  host.classList.remove("grab", "grabbing", "talk");
  host = null;
}

// every frame, after the animation and before the world transform (lobby.js): the dragged bones follow the pointer
// (SkeletonUtilityBone override), clamped to their box in the parent bone's space, and ease back to rest when let go.
// The game's per-frame follow factors are for 60 fps; here they are frame-rate independent.
export function apply(player, delta) {
  if (!items.length) return;
  const dt = Math.max(0, Math.min(0.1, delta || 0));
  for (const it of items) {
    if (it.player !== player) continue;
    const d = it.d, active = it.started && press?.h?.it === it && pointer;
    if (!active && it.resting) continue;
    let goal = d.orig, speed = d.release;
    if (active) {
      const [u, v] = lobby.toWorld(...pointer), l = player.bamtLayer;
      const p = new spine.Vector2((u - l.x) / l.scale, (v - l.y) / l.scale);
      if (it.bone.parent) it.bone.parent.worldToLocal(p);
      goal = [clamp(p.x - d.offset[0], d.min[0], d.max[0]), clamp(p.y - d.offset[1], d.min[1], d.max[1])];
      speed = d.drag;
    }
    const k = 1 - Math.pow(1 - clamp(speed, 0, 1), dt * 60);
    it.cur[0] += (goal[0] - it.cur[0]) * k;
    it.cur[1] += (goal[1] - it.cur[1]) * k;
    if (!active && Math.abs(it.cur[0] - d.orig[0]) < 0.05 && Math.abs(it.cur[1] - d.orig[1]) < 0.05) {
      it.cur = [...d.orig];
      it.resting = true;
    }
    it.bone.x = it.cur[0];
    it.bone.y = it.cur[1];
  }
}

// for checks: the boxes and the drag state
export const state = () => ({
  drags: items.map((it) => ({ kind: it.d.kind, bone: it.d.bone, rect: it.d.rect, started: it.started, cur: it.cur.map((x) => +x.toFixed(2)) })),
  bodies: bodies.map((t) => t.rect), attached: !!host, press: press && (press.pan ? "pan" : press.h ? press.h.type : "none"),
});
