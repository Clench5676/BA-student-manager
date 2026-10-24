import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
let source = await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall-portraits.js", import.meta.url), "utf8");
source = source.replace(/^import .*;$/gm, "");
const { talkExpression } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
function fixture(names = ["Idle_01", "00", "02", "04", "05", "Talk", "Eye_Close_01"]) {
  const animations = names.map((name) => ({ name })), calls = [], tracks = new Map();
  const state = { getCurrent: (track) => tracks.get(track),
    setAnimation(track, name, loop) { const value = { animation: { name }, loop, trackTime: 0, timeScale: 1, alpha: 1 }; tracks.set(track, value); calls.push([track, name, loop]); return value; },
    setEmptyAnimation(track, mix) { tracks.delete(track); calls.push([track, null, mix]); } };
  const actor = { player: { skeleton: { data: { animations, findAnimation: (name) => animations.find((animation) => animation.name === name) } }, animationState: state } };
  state.setAnimation(0, "Idle_01", true); state.setAnimation(1, "00", true).trackTime = 12;
  state.setAnimation(2, "Eye_Close_01", false); calls.length = 0;
  return { actor, calls, tracks };
}

test("verified Eimi numbered expression clips change only track 1 and restore its pre-speech pose", () => {
  const h = fixture();
  talkExpression(h.actor, true, { animation: "04", track: 1, loop: true, mix: 0, outro: 0, sync: [] });
  talkExpression(h.actor, true, { animation: "05", track: 1, loop: true, mix: 0, outro: 0, sync: [] });
  assert.deepEqual(h.calls, [[1, "04", true], [1, "05", true]]);
  assert.equal(h.tracks.get(0).animation.name, "Idle_01"); assert.equal(h.tracks.get(2).animation.name, "Eye_Close_01");
  talkExpression(h.actor, false); assert.equal(h.tracks.get(1).animation.name, "00"); assert.equal(h.tracks.get(1).trackTime, 12);
  const length = h.calls.length; talkExpression(h.actor, false); assert.equal(h.calls.length, length);
});

test("missing authored expressions never guess a generic Talk animation or reset an unchanged face", () => {
  const h = fixture(); talkExpression(h.actor, true, null); talkExpression(h.actor, true, "99"); talkExpression(h.actor, false);
  assert.deepEqual(h.calls, []); assert.equal(h.tracks.get(1).trackTime, 12);
});

test("explicit synchronized speech clips obey their tracks and release tracks absent from the next cue", () => {
  const h = fixture();
  talkExpression(h.actor, true, { animation: "04", track: 1, loop: true, mix: .1, outro: .2,
    sync: [{ animation: "Talk", track: 3, loop: true, mix: .05, outro: .15 }] });
  assert.equal(h.tracks.get(1).mixDuration, .1); assert.equal(h.tracks.get(3).animation.name, "Talk");
  talkExpression(h.actor, true, "05"); assert.equal(h.tracks.has(3), false); assert.ok(h.calls.some(([track, name]) => track === 3 && name === null));
  talkExpression(h.actor, false); assert.equal(h.tracks.get(1).animation.name, "00");
});

test("reapplying a cue does not restart its animation, and actors retain independent restoration state", () => {
  const a = fixture(), b = fixture();
  b.tracks.get(1).animation.name = "02"; b.tracks.get(1).trackTime = 7;
  talkExpression(a.actor, true, "04"); a.tracks.get(1).trackTime = 3; talkExpression(a.actor, true, "04");
  assert.equal(a.tracks.get(1).trackTime, 3); assert.equal(a.calls.length, 1);
  talkExpression(b.actor, true, "05"); talkExpression(a.actor, false); talkExpression(b.actor, false);
  assert.equal(a.tracks.get(1).animation.name, "00"); assert.equal(b.tracks.get(1).animation.name, "02"); assert.equal(b.tracks.get(1).trackTime, 7);
});
