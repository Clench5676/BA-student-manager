import assert from "node:assert/strict";
import { test } from "node:test";
import { LOBBY_CHARACTER_POS, PORTRAIT_ANCHOR, PORTRAIT_BASE_SCALE, portraitScale, portraitRect } from "../../src/ba_modding_toolkit/web/js/student-hall-framing.js";
import { portraitViewport, stagePoint } from "../../src/ba_modding_toolkit/web/js/portrait-view.js";
import { createDraft } from "../../src/ba_modding_toolkit/web/js/student-hall-model.js";
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const box = { left: 0, top: 0, width: 1920, height: 1080 };

test("ordinary LobbyCommon portrait projection matches its authored CharPos and the game UI camera", () => {
  const view = portraitViewport(LOBBY_CHARACTER_POS, { origin: [960, 540], s: 1920 / 2960, box });
  close(PORTRAIT_BASE_SCALE, .72);
  close(PORTRAIT_ANCHOR.x, 887.3513513513514); close(PORTRAIT_ANCHOR.y, 1114.7027027027027);
  for (const [x, y] of [[0, 0], [200, 1000], [-600, 1600]]) for (const dpr of [1, 2, 3]) {
    const actual = stagePoint(view, box, x, y, dpr);
    close(actual[0], PORTRAIT_ANCHOR.x + .72 * x); close(actual[1], PORTRAIT_ANCHOR.y - .72 * y);
  }
});
test("different authored student sizes and weapons preserve their proportions rather than fitting to a box", () => {
  const entry = { ...PORTRAIT_ANCHOR, scale: 1 };
  const small = portraitRect(entry, { x: -200, y: 0, width: 400, height: 1200 });
  const tall = portraitRect(entry, { x: -800, y: 0, width: 1600, height: 1600 });
  close(small.height, 864); close(tall.height, 1152); close(tall.width / small.width, 4);
  close(portraitScale(entry), .72);
});
test("intentional stored positions and relative zoom remain untouched while hit and dialogue bounds use the corrected projection", () => {
  const entry = { x: 1400, y: 950, scale: .6 }, before = structuredClone(entry);
  const rect = portraitRect(entry, { x: -100, y: 40, width: 500, height: 1300 });
  close(rect.x, 1356.8); close(rect.y, 371.12); close(rect.width, 216); close(rect.height, 561.6);
  assert.deepEqual(entry, before);
});
test("new entries use the verified lobby anchor with relative scale one", () => {
  const state = createDraft({ revision: 0, mode: "portraits", portraits: [], memorials: [], active: null });
  state.begin("layout");
  const entry = state.add({ variant: "hero", source: "mod:a", kind: "spr" }, () => "first");
  assert.equal(entry.scale, 1); close(entry.x, PORTRAIT_ANCHOR.x); close(entry.y, PORTRAIT_ANCHOR.y);
});

test("horizontal flip reflects asymmetric bounds around the same anchor for hits and dialogue",()=>{
  const entry={x:1000,y:1100,scale:.8},bounds={x:-180,y:35,width:730,height:1450};
  for(const globalScale of [.25,1,1.5]){
    const plain=portraitRect(entry,bounds,globalScale),flipped=portraitRect({...entry,mirror:true},bounds,globalScale);
    close(flipped.x,2*entry.x-plain.x-plain.width);close(flipped.width,plain.width);close(flipped.height,plain.height);close(flipped.y,plain.y);
  }
});
