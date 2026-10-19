// Tests for web/js/visual-view.js (the portrait's visual mode framing and its prefab's numbers), run by
// tests/test_visual_mode.py with Node's test runner: node --test tests/js/visual_view.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { SKELETON_SCALE, stagePoint } from "../../src/ba_modding_toolkit/web/js/portrait-view.js";
import {
  FULL_SCALE, SCREEN, SLIDE, SLIDE_S, STAGE, ZOOM_MAX, anchoredCentre, artBox, atHome, clampView, hermite, homeView, limits,
  mix, panBy, slideFrames, viewOf, viewport, zoomAt,
} from "../../src/ba_modding_toolkit/web/js/visual-view.js";

const S = 1920 / 2960; // stage px per prefab unit (util.js)
const BOX = { left: 0, top: 0, width: STAGE.width, height: STAGE.height };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearPt = (p, q, eps = 1e-6) => { near(p[0], q[0], eps); near(p[1], q[1], eps); };
// skeleton bounds of real portraits (SkeletonData x, y, width, height): Hoshino, Eimi (Armed) with her long gun on
// the left, and the tallest one, an NPC without Idle_01
const HOSHINO = { x: -580, y: -747, width: 1161, height: 2074 };
const EIMI_ARMED = { x: -1462.95, y: -1246, width: 1997.8, height: 2680.9 };
const BLACKSUIT = { x: -402, y: -1683, width: 936, height: 3277 };

test("a view and its spine-player viewport are the same framing", () => {
  const v = { cx: 120, cy: -340, k: 0.42 };
  const vp = viewport(v);
  near(vp.width / vp.height, STAGE.width / STAGE.height);
  assert.deepEqual([vp.padLeft, vp.padRight, vp.padTop, vp.padBottom], [0, 0, 0, 0]);
  const back = viewOf(vp);
  near(back.cx, v.cx); near(back.cy, v.cy); near(back.k, v.k);
  // spine-player's own camera puts the view's centre on the stage's centre, k px per skeleton unit
  nearPt(stagePoint(vp, BOX, v.cx, v.cy), [960, 540], 1e-6);
  nearPt(stagePoint(vp, BOX, v.cx + 100, v.cy + 100), [960 + 100 * v.k, 540 - 100 * v.k], 1e-6);
});

test("the whole art: the body in the middle at CharacterPos's scale, every portrait inside the screen", () => {
  for (const data of [HOSHINO, EIMI_ARMED, BLACKSUIT]) {
    const box = artBox(data), home = homeView(box, { s: S });
    near(home.k, FULL_SCALE * SKELETON_SCALE * S);
    // across: the skeleton's origin, where the character stands (a weapon beside her does not move her)
    near(home.cx, 0);
    // down: the middle of the art; the art fits the screen's height
    near(home.cy, data.y + data.height / 2);
    assert.ok(data.height * home.k <= STAGE.height, `${data.height} units do not fit`);
  }
  // the prefab's own scale is followed; an origin outside the art is brought onto it
  near(homeView(artBox(HOSHINO), { s: S, scale: 101 }).k, 101 * SKELETON_SCALE * S);
  near(homeView(artBox(HOSHINO), { s: S, scale: 0 }).k, FULL_SCALE * SKELETON_SCALE * S);
  near(homeView([200, 0, 900, 1000], { s: S }).cx, 200);
});

test("the art box: the skeleton's exported bounds, else the measured pose, else a stand-in", () => {
  assert.deepEqual(artBox(HOSHINO), [-580, -747, 581, 1327]);
  assert.deepEqual(artBox({ x: 0, y: 0, width: 0, height: 0 }, [-10, -20, 30, 40]), [-10, -20, 20, 20]);
  const fallback = artBox(null, null);
  assert.ok(fallback[2] > fallback[0] && fallback[3] > fallback[1]);
});

test("zoom at the pointer keeps the skeleton point under it, between the whole art and ZOOM_MAX", () => {
  const box = artBox(HOSHINO), home = homeView(box, { s: S }), lim = limits(box, home);
  const at = [1100, 300], vp0 = viewport(home);
  // the skeleton point under the pointer
  const px = home.cx + (at[0] - 960) / home.k, py = home.cy - (at[1] - 540) / home.k;
  const z = zoomAt(home, 1.5, at[0], at[1], lim);
  near(z.k, home.k * 1.5);
  nearPt(stagePoint(viewport(z), BOX, px, py), at, 1e-6);
  nearPt(stagePoint(vp0, BOX, px, py), at, 1e-6);
  // never past the limits
  near(zoomAt(home, 100, 960, 540, lim).k, home.k * ZOOM_MAX);
  near(zoomAt(home, 0.01, 960, 540, lim).k, home.k);
  // ZOOM_MAX is about twice the detail screen's size (CharacterPos scale 101)
  near(lim.kMax / (101 * SKELETON_SCALE * S), ZOOM_MAX * FULL_SCALE / 101);
});

test("a drag moves the art with the pointer; the stage's centre stays on the art", () => {
  const box = artBox(EIMI_ARMED), home = homeView(box, { s: S }), lim = limits(box, home);
  const moved = panBy(home, 30, -12, lim);
  const p = [home.cx, home.cy];
  nearPt(stagePoint(viewport(moved), BOX, ...p), [960 + 30, 540 - 12], 1e-6);
  const far = panBy(home, -1e6, 1e6, lim);
  near(far.cx, box[2]);
  near(far.cy, box[3]); // dragged down: the view goes up the art
  assert.deepEqual(clampView({ cx: -1e9, cy: 1e9, k: 1e9 }, lim), { cx: box[0], cy: box[3], k: lim.kMax });
});

test("a glide between views, and the home check the reset button follows", () => {
  const a = { cx: 0, cy: 0, k: 0.2 }, b = { cx: 100, cy: -50, k: 0.8 };
  assert.deepEqual(mix(a, b, 0), a);
  const end = mix(a, b, 1);
  near(end.cx, b.cx); near(end.cy, b.cy); near(end.k, b.k);
  near(mix(a, b, 0.5).k, 0.4); // a steady zoom rate
  assert.ok(atHome({ ...b }, b));
  assert.ok(!atHome({ ...b, cx: b.cx + 1 }, b));
  assert.ok(!atHome({ ...b, k: b.k * 1.01 }, b));
});

test("the corners are anchored to the screen's edges as in the PC prefab", () => {
  // Inventory_ListControl_PC's UIWidgets, 2960 x 1440, anchored to the top right, bottom right and top left
  const rightTop = { anchors: { leftAnchor: [1, -2960], rightAnchor: [1, 0], bottomAnchor: [1, -1474], topAnchor: [1, -34] } };
  const rightBottom = { anchors: { leftAnchor: [1, -2960], rightAnchor: [1, 0], bottomAnchor: [0, 0], topAnchor: [0, 1440] } };
  const leftTop = { anchors: { leftAnchor: [0, 0], rightAnchor: [0, 2960], bottomAnchor: [1, -1474], topAnchor: [1, -34] } };
  nearPt(anchoredCentre(rightTop), [0, SCREEN.h / 2 - 34 - 720]);
  nearPt(anchoredCentre(rightBottom), [0, -SCREEN.h / 2 + 720]);
  nearPt(anchoredCentre(leftTop), [0, SCREEN.h / 2 - 754]);
  // Btn_HideUI (1352, 650) and Btn_Back (-1354, 650) keep their distance from the top edge on a 16:9 screen
  near(SCREEN.h / 2 - (anchoredCentre(rightTop)[1] + 650), 1440 / 2 - (-34 + 650));
  assert.equal(anchoredCentre({}), null);
  assert.equal(anchoredCentre(null), null);
});

test("the buttons' slide follows UIAni_CharacterVisualMode_PC", () => {
  for (const [name, keys] of Object.entries(SLIDE)) {
    for (const [t, v] of keys) near(hermite(keys, t), v);
    near(hermite(keys, -1), keys[0][1]);
    near(hermite(keys, 9), 0);
    const frames = slideFrames(keys);
    assert.equal(frames.length, Math.round(SLIDE_S * 60) + 1, name);
    near(frames[0].value, keys[0][1]);
    near(frames.at(-1).value, 0);
    near(frames.at(-1).offset, 1);
    // from the edge inwards, never past where it stops
    const sign = Math.sign(keys[0][1]);
    for (let i = 1; i < frames.length; i++) {
      assert.ok(sign * frames[i].value <= sign * frames[i - 1].value + 1e-9, `${name} frame ${i}`);
      assert.ok(sign * frames[i].value >= -1e-9, `${name} frame ${i}`);
    }
  }
  // the middle key's slope: Btn_HideUI moves 378.9 units a second there
  const k = SLIDE.Btn_HideUI, t = k[1][0], h = 1e-5;
  near((hermite(k, t + h) - hermite(k, t)) / h, k[1][3], 0.05);
});
