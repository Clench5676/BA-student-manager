import {portraitCaptureView} from './photography/camera.js';
// The portrait's visual mode framing and the numbers of its prefab (visual-mode.js draws it). No DOM: the tests run
// it in Node.
// A view is the skeleton point at the stage's centre (cx, cy, skeleton units) and the stage px per skeleton unit (k);
// the portrait's player covers the whole stage, so its spine-player viewport follows from the view alone.

import { SKELETON_SCALE } from "./portrait-view.js";

export const STAGE = Object.freeze({ width: 1920, height: 1080 });
// the game's 16:9 screen in NGUI units (util.js S: 2960 units across the stage)
export const SCREEN = Object.freeze({ w: 2960, h: 1665 });
// Inventory_ListControl_PC/Character/CharacterPos: half the detail screen's 101, so the tallest portrait (3277
// skeleton units, an NPC's) still fits the screen's height
export const FULL_SCALE = 50;
// zoom limit relative to the whole art: about twice the detail screen's size
export const ZOOM_MAX = 4;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// the spine-player viewport showing a view in a box of the stage's size, and back
export function viewport(view, box = STAGE) {
  const w = box.width / view.k, h = box.height / view.k;
  return { x: view.cx - w / 2, y: view.cy - h / 2, width: w, height: h, padLeft: 0, padRight: 0, padTop: 0, padBottom: 0 };
}
export function viewOf(vp, box = STAGE) {
  return { cx: vp.x + vp.width / 2, cy: vp.y + vp.height / 2, k: box.width / vp.width };
}

// the art's box in skeleton units [x0, y0, x1, y1]: the skeleton's own bounds (SkeletonData x, y, width, height, as
// the Spine editor exported them), else the setup pose's
export function artBox(data, measured = null) {
  if (data && data.width > 0 && data.height > 0) return [data.x, data.y, data.x + data.width, data.y + data.height];
  if (measured && measured[2] > 0 && measured[3] > 0) return [measured[0], measured[1], measured[0] + measured[2], measured[1] + measured[3]];
  return [-1000, -1000, 1000, 1500];
}

// The whole art: the body in the middle of the screen at CharacterPos's scale. The game reads the body's centre from
// its CharacterIllustCoordinate table; without it, across: the skeleton's origin, which every portrait puts on the
// character (a weapon or a prop beside her only widens the bounds); down: the middle of the art.
export function homeView(box, { s, scale = FULL_SCALE } = {}) {
  const [x0, y0, x1, y1] = box;
  return { cx: clamp(0, x0, x1), cy: (y0 + y1) / 2, k: (scale > 0 ? scale : FULL_SCALE) * SKELETON_SCALE * s };
}

// how far a view may go: from the whole art to ZOOM_MAX times closer; the stage's centre stays on the art
export function limits(box, home) {
  return { box, kMin: home.k, kMax: home.k * ZOOM_MAX };
}
export function clampView(v, lim) {
  if(lim.photoFrame)return portraitCaptureView({...v,k:clamp(v.k,lim.kMin,lim.kMax)},lim.photoBounds,lim.photoFrame);
  const [x0, y0, x1, y1] = lim.box;
  return { cx: clamp(v.cx, x0, x1), cy: clamp(v.cy, y0, y1), k: clamp(v.k, lim.kMin, lim.kMax) };
}

// zoom by f with the skeleton point under the stage point (sx, sy) staying there (until the limits move it)
export function zoomAt(v, f, sx, sy, lim, box = STAGE) {
  const k = clamp(v.k * f, lim.kMin, lim.kMax);
  const dx = sx - box.width / 2, dy = sy - box.height / 2;
  const px = v.cx + dx / v.k, py = v.cy - dy / v.k;
  return clampView({ cx: px - dx / k, cy: py + dy / k, k }, lim);
}
// the art follows the pointer: (dx, dy) stage px, y down
export function panBy(v, dx, dy, lim) {
  return clampView({ cx: v.cx - dx / v.k, cy: v.cy + dy / v.k, k: v.k }, lim);
}
// a view between two (t from 0 to 1): the centre in a line, the zoom at a steady rate
export function mix(a, b, t) {
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, k: a.k * Math.pow(b.k / a.k, t) };
}
// the view is the whole art (the reset button greys out): within a hundredth of a stage px
export function atHome(v, home) {
  return Math.abs(v.k / home.k - 1) < 1e-4 && Math.abs((v.cx - home.cx) * v.k) < 0.01 && Math.abs((v.cy - home.cy) * v.k) < 0.01;
}

// --- the prefab's layout ---

// the stage point of a widget anchored to the screen's edges (NGUI anchors [relative, absolute] per side, the
// target the screen): its centre, in NGUI units around the screen's centre. null without anchors.
export function anchoredCentre(widget, screen = SCREEN) {
  const a = widget?.anchors;
  if (!a?.leftAnchor || !a.rightAnchor || !a.bottomAnchor || !a.topAnchor) return null;
  const x = ([rel, abs]) => -screen.w / 2 + rel * screen.w + abs, y = ([rel, abs]) => -screen.h / 2 + rel * screen.h + abs;
  return [(x(a.leftAnchor) + x(a.rightAnchor)) / 2, (y(a.bottomAnchor) + y(a.topAnchor)) / 2];
}

// UIAni_CharacterVisualMode_PC (legacy clip, 60 fps): the buttons slide in from the screen's edges. Keys of their x
// as offsets from where they stop: [time s, value, in slope, out slope] (Unity Hermite keys, not weighted).
export const SLIDE = Object.freeze({
  Btn_Back: [[0, -300, 0, 0], [0.21666667, -30, 378.94733, 378.94733], [0.31666666, 0, 0, 0]],
  Btn_HideUI: [[0, 300, 0, 0], [0.21666667, 30, -378.94733, -378.94733], [0.31666666, 0, 0, 0]],
  Btn_RefreshPos: [[0, 300, 0, 0], [0.21666667, 40.85596, -516.07526, -516.07526], [0.31666666, 0, 0, 0]],
});
export const SLIDE_S = 0.31666666;

// a Unity animation curve's value at t (Hermite between keys, held before the first and after the last)
export function hermite(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (t > keys[i + 1][0]) i++;
  const [t0, p0, , out0] = keys[i], [t1, p1, in1] = keys[i + 1];
  const d = t1 - t0, s = (t - t0) / d, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * out0 * d + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * in1 * d;
}
// the curve sampled at the clip's frame rate: [{offset 0..1, value}]
export function slideFrames(keys, fps = 60) {
  const end = keys[keys.length - 1][0], n = Math.max(1, Math.round(end * fps));
  return Array.from({ length: n + 1 }, (_, i) => ({ offset: i / n, value: hermite(keys, (i / n) * end) }));
}
