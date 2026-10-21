// Fullscreen memorial lobby interaction, as in the game and from its own data (lobby.json: the prefab's SpineDragIK
// and SpineCharacterBodyTouch boxes; lobby.js plays the clips):
// - press and hold on the head: after the trigger delay the pat clips play and the Touch_Point bone follows the pointer
//   inside its box (the skeleton's own constraints make the hair and face follow); on release the end clips play and
//   the bone eases back. Cheek pinch, hand follow and the other drag kinds work the same way on their bones.
// - press and drag anywhere else: the eyes follow (Touch_Eye). During a dialogue only the bone follows and the
//   dialogue goes on; any other drag ends it.
// - tap on the body: the next dialogue.
// - zoom at the pointer with a mouse wheel or a trackpad pinch (ctrl + wheel in Chromium and WebView2, gesture events
//   in WebKit); pan with a two-finger trackpad swipe in any direction, the horizontal wheel, or a right- or
//   middle-button drag. Panning only moves while zoomed in. A Magic Mouse scrolls like a trackpad: ctrl + scroll zooms.
// Positions are NGUI units (lobby.js): the stage shows the current view, each skeleton sits at its prefab offset and
// scale. Lobbies without prefab data get boxes around the character's own bones (medians over the game's lobbies).

const SLOP = { mouse: 10, pen: 10, touch: 24 };  // stage px a tap may move (NGUI's mouse click threshold is 10)
const WHEEL = 0.0015;                            // zoom by exp(-deltaY * WHEEL) per wheel pixel
const LINE = 40;                                 // px: a wheel notch zooms at least as far as one line
const PINCH = 0.01;                              // ctrl + wheel (a trackpad pinch): exp(-deltaY * PINCH)
const SCROLL_MS = 120;                           // wheel events this close together belong to one scroll
const STAGE = { w: 1920, h: 1080 };

let lobby = null, items = [], bodies = [], host = null, press = null, pointer = null, gesture = 1;
let scroll = { kind: null, at: -Infinity }, pinchUntil = -Infinity, traceSink = null;
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

// pointer capture keeps a drag that leaves the stage; where it is refused, the press goes on without it
function capture(e) {
  try { host.setPointerCapture?.(e.pointerId); } catch (err) { trace("capture-refused", e, { error: String(err?.name || err) }); }
}

function down(e) {
  trace("down", e, { blocked: lobby?.blocked() || undefined });
  if (!lobby || press) return;
  const [sx, sy] = stagePoint(e);
  if (e.button === 1 || e.button === 2) {
    e.preventDefault();
    press = { id: e.pointerId, pan: true, last: [sx, sy] };
    capture(e);
    cursor();
    return;
  }
  if (e.button !== 0 || lobby.blocked()) return;
  capture(e);
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
  trace("move", e);
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
  trace(e.type === "pointercancel" ? "cancel" : "up", e);
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
// What one wheel event says about its device: "notch" (a mouse wheel), "maybe" (a wheel, or a trackpad step that
// happens to look like one) or "smooth" (a trackpad, a Magic Mouse).
// - Lines or pages (deltaMode 1, 2): a wheel.
// - Both axes, or neither (a trackpad's gesture start): a trackpad. A wheel moves one axis.
// - WebKit (Safari, the macOS app's WKWebView) gives wheelDeltaY = 3 x deltaY for every device (wheel ticks of 40 px;
//   Chromium on macOS does the same for a trackpad), so there it says nothing. A wheel notch is the system's line
//   delta times 40 px instead: macOS accelerates notches in tenths of a line, kept in 16.16 fixed point, so a notch is
//   k x 4 px off by a hair (4.000244, 7.99988, 12.000732 ...) and a whole number only at half lines (k a multiple of
//   5). A trackpad's steps are whole pixels: 8 px is a trackpad, 4.000244 a wheel, 20 or 40 either.
// - Chromium and WebView2 count whole notches in wheelDeltaY, in steps of 120.
export function wheelStep(e) {
  if (e.deltaMode === 1 || e.deltaMode === 2) return "notch";
  const dx = e.deltaX || 0, dy = e.deltaY || 0;
  if (!dx === !dy) return "smooth";
  const d = dy || dx, w = (dy ? e.wheelDeltaY : e.wheelDeltaX) || 0;
  if (Math.abs(w + 3 * d) < 1.01) {
    const v = Math.abs(d), k = Math.round(v / 4);
    if (k < 1 || Math.abs(v - 4 * k) > 8e-4 * k) return "smooth";
    if (v !== Math.round(v)) return "notch";
    return k % 5 === 0 ? "maybe" : "smooth";
  }
  return w && w % 120 === 0 ? "notch" : "smooth";
}
// A mouse wheel zooms, a trackpad swipe pans. Events this close together are one scroll and keep its kind, so a
// trackpad step or its momentum that looks like a notch still pans; but a scroll read as a wheel turns out a trackpad
// at the first event a wheel never sends.
export function wheelKind(e, now = performance.now(), last = scroll) {
  const step = wheelStep(e);
  if (!(now - last.at < SCROLL_MS && last.kind)) return step === "smooth" ? "trackpad" : "mouse";
  return last.kind === "mouse" && step === "smooth" ? "trackpad" : last.kind;
}
// a notch zooms at least as far as a line: a slow notch on macOS is a tenth of one (4 px), a step too small to see
const notchZoom = (e, unit) => Math.exp(-Math.sign(e.deltaY) * Math.max(Math.abs(e.deltaY * unit), LINE) * WHEEL);
function wheel(e) {
  if (!lobby) return;
  e.preventDefault();
  const [sx, sy] = stagePoint(e), unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1, now = performance.now();
  // stage px per CSS px: a two-finger swipe moves the art as far as the fingers moved
  const r = host.getBoundingClientRect(), k = r.width ? STAGE.w / r.width : 1;
  const step = wheelStep(e);
  if (e.ctrlKey) {
    // a trackpad pinch (Chromium, WebView2) or ctrl + mouse wheel (or + Magic Mouse); WebKit pinches with gesture
    // events instead, which some versions accompany with ctrl + wheel events: those are left to the gesture
    scroll = { kind: null, at: -Infinity };
    if (now < pinchUntil) return trace("wheel", e, { act: "skip", step });
    const notch = step !== "smooth";
    lobby.zoomAt(notch ? notchZoom(e, unit) : Math.exp(-e.deltaY * unit * PINCH), sx, sy);
    return trace("wheel", e, { act: notch ? "zoom" : "pinch", step });
  }
  const fresh = !(now - scroll.at < SCROLL_MS && scroll.kind), kind = wheelKind(e, now);
  if (fresh) {
    // a scroll that starts like a wheel zooming in pixels keeps the view it started from, to go back to if it turns
    // out a trackpad: a WebKit whole line, and a Chromium notch too (a Windows touchpad's first step can be exactly
    // 100 px, wheelDelta 120); a second notch confirms the wheel
    const zooms = kind === "mouse" && !e.deltaMode && Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    scroll = { kind, at: now, from: zooms ? lobby.viewTarget?.() : null };
  } else {
    if (scroll.kind === "mouse" && kind === "trackpad" && scroll.from) lobby.setViewTarget?.(scroll.from);
    if (step === "notch" || kind === "trackpad") scroll.from = null;
    scroll.kind = kind;
    scroll.at = now;
  }
  if (kind === "mouse" && Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
    lobby.zoomAt(notchZoom(e, unit), sx, sy);
    return trace("wheel", e, { act: "zoom", step });
  }
  // a trackpad swipe (or a horizontal wheel): the art moves with the fingers, as in a scrolled page
  lobby.panBy(-e.deltaX * unit * k, kind === "mouse" ? 0 : -e.deltaY * unit * k);
  trace("wheel", e, { act: "pan", step });
}
// Safari / WKWebView trackpad pinch
function gestureStart(e) { e.preventDefault(); gesture = 1; pinchUntil = performance.now() + 300; trace("gesturestart", e); }
function gestureChange(e) {
  if (!lobby) return;
  e.preventDefault();
  pinchUntil = performance.now() + 300;
  const [sx, sy] = stagePoint(e);
  lobby.zoomAt(e.scale / gesture, sx, sy);
  gesture = e.scale;
  trace("gesturechange", e);
}
function gestureEnd(e) { e.preventDefault(); pinchUntil = performance.now() + 300; trace("gestureend", e); }
const menu = (e) => e.preventDefault();
// no native drag of the canvases, and no Force Touch look-up on a firm trackpad press (WebKit)
function noDrag(e) { e.preventDefault(); trace(e.type, e); }

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
  ["lostpointercapture", (e) => trace("lostcapture", e)], ["wheel", wheel, { passive: false }],
  ["gesturestart", gestureStart], ["gesturechange", gestureChange], ["gestureend", gestureEnd], ["contextmenu", menu],
  ["dragstart", noDrag], ["webkitmouseforcewillbegin", noDrag], ["webkitmouseforcedown", noDrag]];
export function attach(el) {
  if (!el || host === el || !lobby) return;
  detach();
  host = el;
  for (const [type, fn, opts] of handlers) host.addEventListener(type, fn, opts);
  if (traceSink) for (const type of SPY) document.addEventListener(type, spy, true);
}
// leaving fullscreen: a running drag ends as if released
export function detach() {
  if (press && !press.pan) {
    clearTimeout(press.timer);
    if (press.h?.type === "drag") end(press.h.it);
  }
  press = null;
  pointer = null;
  scroll = { kind: null, at: -Infinity };
  pinchUntil = -Infinity;
  if (!host) return;
  for (const [type, fn, opts] of handlers) host.removeEventListener(type, fn, opts);
  for (const type of SPY) document.removeEventListener(type, spy, true);
  host.classList.remove("grab", "grabbing", "talk");
  host = null;
}

// every frame, after the animation and before the world transform (lobby.js): the dragged bones follow the pointer
// (SkeletonUtilityBone override), clamped to their box in the parent bone's space, and ease back to rest when let go.
// The game's per-frame follow factors are for 60 fps; here they are frame-rate independent.
export function apply(player, delta) {
  // Only lobby.js players created after ensureSpine() install this frame hook.
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

// --- input trace (the app started with --debug): what the lobby receives, throttled, for a bug report ---
// spy: every pointer, mouse and drag event in the document while the fullscreen lobby is attached, with its target,
// so an event that never reaches the lobby shows up too
const SPY = ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup", "dragstart", "click"];
function spy(e) {
  const t = e.target, name = t?.tagName ? `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}${typeof t.className === "string" && t.className ? "." + t.className.trim().split(/\s+/).join(".") : ""}` : String(t);
  trace(`doc:${e.type}`, e, { target: name, onLobby: !!host?.contains(t) });
}
const MOVES = new Set(["move", "wheel", "gesturechange"]);
let traceBuf = [], traceTimer = null, traceLast = {}, traceDropped = 0;
// sink(events) receives batches of plain objects; null turns the trace off
export function setTrace(sink) {
  traceSink = sink || null;
  traceBuf = [];
  if (host) for (const type of SPY) document[sink ? "addEventListener" : "removeEventListener"](type, spy, true);
}
function trace(kind, e, extra) {
  if (!traceSink) return;
  const now = performance.now();
  // moves and scrolls: at most one every 50 ms of each kind (the rest are counted)
  if (MOVES.has(kind) && !extra?.act && now - (traceLast[kind] || -Infinity) < 50) { traceDropped++; return; }
  if (MOVES.has(kind) && extra?.act && now - (traceLast[kind + extra.act] || -Infinity) < 50) { traceDropped++; return; }
  traceLast[extra?.act ? kind + extra.act : kind] = now;
  const r = host?.getBoundingClientRect();
  const ev = { t: Math.round(now), k: kind, type: e?.type, pt: e?.pointerType, id: e?.pointerId, b: e?.button, bs: e?.buttons,
    x: e?.clientX != null ? Math.round(e.clientX) : undefined, y: e?.clientY != null ? Math.round(e.clientY) : undefined,
    dx: e?.deltaX, dy: e?.deltaY, dm: e?.deltaMode, wdy: e?.wheelDeltaY, wdx: e?.wheelDeltaX, ctrl: e?.ctrlKey || undefined,
    scale: e?.scale, prim: e?.isPrimary, pr: e?.pressure || undefined, force: e?.webkitForce || undefined, press: press ? (press.pan ? "pan" : press.h?.type || "none") : undefined,
    host: r ? [Math.round(r.width), Math.round(r.height)] : undefined, dropped: traceDropped || undefined, ...extra };
  traceDropped = 0;
  for (const k of Object.keys(ev)) if (ev[k] === undefined) delete ev[k];
  traceBuf.push(ev);
  if (traceBuf.length >= 40) flushTrace();
  else if (!traceTimer) traceTimer = setTimeout(flushTrace, 500);
}
function flushTrace() {
  clearTimeout(traceTimer);
  traceTimer = null;
  const batch = traceBuf.splice(0);
  if (batch.length) try { traceSink?.(batch); } catch { /* a trace never breaks the lobby */ }
}

// for checks: the boxes and the drag state
export const state = () => ({
  drags: items.map((it) => ({ kind: it.d.kind, bone: it.d.bone, rect: it.d.rect, started: it.started, cur: it.cur.map((x) => +x.toFixed(2)) })),
  bodies: bodies.map((t) => t.rect), attached: !!host, press: press && (press.pan ? "pan" : press.h ? press.h.type : "none"),
});
