import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8");
const dialogue = source.slice(source.indexOf("export function play(anim"), source.indexOf("export const playingAll"))
  .replaceAll("export function", "function");
const detail = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const toggle = detail.slice(detail.indexOf("function togglePlayAll()"), detail.indexOf("// a dialogue started"));

function player() {
  const starts = [];
  const current = { meta: { sequences: [1, 2, 3].map((n) => ({ anim: `Talk_0${n}_M`, cues: [], duration: 1 })) }, intro: { skip() {} } };
  const env = { current, mainPlayer: () => ({ animationState: {} }), Idle: { interrupt() {} },
    returnToIdle() {}, playClip: (_player, anim) => starts.push(anim), clearClip() {}, emit() {}, silence() {}, subtitle() {} };
  const controls = new Function(...Object.keys(env), `
    let talk = null, chain = null, talkIndex = 0, cueTimers = [], lines = {}, muted = true;
    ${dialogue}
    return { play, playAll, stop, playingAll: () => !!chain, selected: () => talk?.seq.anim || null };
  `)(...Object.values(env));
  const clickPlay = (selected = controls.selected()) => new Function("Lobby", "lobbySeq", `${toggle}; togglePlayAll();`)(controls, selected);
  return { starts, controls, clickPlay };
}

test("detail Play starts at the selected dialogue and continues through subsequent lines", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = player();
  try {
    h.controls.play("Talk_02_M"); h.starts.length = 0;
    h.clickPlay(); assert.deepEqual(h.starts, ["Talk_02_M"]); assert.equal(h.controls.playingAll(), true);
    t.mock.timers.tick(1300); t.mock.timers.tick(200);
    assert.deepEqual(h.starts, ["Talk_02_M", "Talk_03_M"]);
    t.mock.timers.tick(1300); assert.equal(h.controls.playingAll(), false);
    assert.equal(h.controls.selected(), null);
  } finally { h.controls.stop(); t.mock.timers.reset(); }
});

test("Play without a selection starts at the beginning, and the running button stops playback", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = player();
  try {
    h.clickPlay(); assert.deepEqual(h.starts, ["Talk_01_M"]);
    h.clickPlay(); assert.equal(h.controls.playingAll(), false); assert.equal(h.controls.selected(), null);
    t.mock.timers.tick(10000); assert.deepEqual(h.starts, ["Talk_01_M"]);
    h.clickPlay("missing"); assert.equal(h.starts.at(-1), "Talk_01_M");
  } finally { h.controls.stop(); t.mock.timers.reset(); }
});
