import assert from "node:assert/strict";
import { test } from "node:test";
import { resizeButton } from "../../src/ba_modding_toolkit/web/js/button-layout.js";

const px = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1], py = [1, 1, 1, 0.5, 0.5, 0.5, 0, 0, 0];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function fixture(pivot = 4, bodyPivot = 4, scale = [1, 1]) {
  const pattern = { sprite: "Common_Btn_Normal_B_C_Pt", w_: 126, h_: 70, pivot,
    anchors: { leftAnchor: [1, -130], rightAnchor: [1, -4], bottomAnchor: [1, -76], topAnchor: [1, -6] } };
  return { pos: [55, -20], widgets: [{ sprite: "Common_Btn_BG", w_: 496, h_: 177, pivot: bodyPivot }],
    children: [{ pos: [-50, -20], scale, widgets: [pattern] },
      { pos: [0, 6], scale: [1, 1], widgets: [{ text: "A long caption", w_: 200, h_: 60 }] }] };
}

test("the pattern follows the body's NGUI anchors for every pivot, width and child scale", () => {
  for (let pivot = 0; pivot < 9; pivot++) for (let bodyPivot = 0; bodyPivot < 9; bodyPivot++) {
    for (const scale of [[1, 1], [0.5, 0.75]]) {
      const body = fixture(pivot, bodyPivot, scale), deco = body.children[0], w = deco.widgets[0];
      for (const width of [205, 292.5, 496, 820, 205]) {
        resizeButton(body, width);
        near(deco.pos[0] + (1 - px[pivot]) * w.w_ * scale[0], width * (1 - px[bodyPivot]) - 4);
        near(deco.pos[1] + (1 - py[pivot]) * w.h_ * scale[1], 177 * (1 - py[bodyPivot]) - 6);
        near(w.w_ * scale[0], 126);
        near(w.h_ * scale[1], 70);
        assert.deepEqual(body.pos, [55, -20]);
        assert.deepEqual(body.children[1].pos, [0, 6]);
        const before = structuredClone(body);
        resizeButton(body);
        assert.deepEqual(body, before, "repeated layout does not accumulate an offset");
      }
    }
  }
});

test("one anchor preserves size; relative anchor pairs stretch with the body", () => {
  const body = fixture(2), deco = body.children[0], w = deco.widgets[0];
  w.anchors = { rightAnchor: [1, -4], topAnchor: [1, -6] };
  resizeButton(body, 700, 200);
  assert.deepEqual(deco.pos, [346, 94]);
  assert.deepEqual([w.w_, w.h_], [126, 70]);
  w.anchors = { leftAnchor: [0.5, 5], rightAnchor: [1, -4], bottomAnchor: [0, 13], topAnchor: [1, -6] };
  resizeButton(body, 600, 160);
  assert.deepEqual(deco.pos, [296, 74]);
  assert.deepEqual([w.w_, w.h_], [291, 141]);
});

test("patterns without anchors retain their prefab edge offsets when the body widens", () => {
  const body = fixture(), deco = body.children[0];
  delete deco.widgets[0].anchors;
  const offset = deco.pos[0] - 496 / 2;
  for (const width of [820, 205, 496]) {
    resizeButton(body, width);
    near(deco.pos[0] - width / 2, offset);
    assert.deepEqual([deco.widgets[0].w_, deco.widgets[0].h_], [126, 70]);
  }
});
