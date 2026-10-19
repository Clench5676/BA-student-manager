// Tests for the memorial lobby's random-timing clips and sound keys (web/js/lobby-sync.js) and the clips a skeleton's
// idle starts (web/js/lobby.js idleClips), against a stand-in for spine's AnimationState. Run by
// tests/test_lobby_view.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

const Sync = await import("../../src/ba_modding_toolkit/web/js/lobby-sync.js");
const Lobby = await import("../../src/ba_modding_toolkit/web/js/lobby.js");

// an AnimationState that records what is set and queued; entries carry a listener like spine-ts's
class State {
  constructor() { this.tracks = []; this.log = []; }
  entry(track, name, loop) { return { track, name, loop, mixDuration: 0.25, listener: null, animationEnd: 1, time: 0, getAnimationTime() { return this.time; } }; }
  setAnimation(track, name, loop) {
    const e = this.entry(track, name, loop);
    this.tracks[track] = e;
    this.log.push(["set", track, name]);
    return e;
  }
  addAnimation(track, name, loop, delay) {
    this.log.push(["add", track, name, delay]);
    return this.entry(track, name, loop);
  }
  addEmptyAnimation(track, mix, delay) {
    this.log.push(["empty", track, mix, delay]);
    return this.entry(track, "<empty>", false);
  }
}
// Shigure's Train_00_R: track 3, looping, no intro mix, waits its preDelay of 3 s plus 10 to 15 s, then 10 to 15 s
const TRAIN = { track: 3, loop: true, mode: 2, finish: 2, intro: 0, outro: 0.2, outroAt: null,
  random: { min: 10, max: 15, loops: [0, 0], pre: 2, preDelay: 3 }, sounds: [[3.1, "subway"]] };
const runs = (clips, durations, state = new State(), random = () => 0.5, onEntry = () => {}) => new Sync.Runs(state, {
  clip: (name) => clips[name], duration: (name) => durations[name] || 0, random, onEntry });

test("the first wait follows RandomTimingIntroDelayMode, the extra plays AddRandomCountLoop", () => {
  const r = { min: 10, max: 15, preDelay: 3, loops: [0, 0] };
  assert.equal(Sync.firstWait({ ...r, pre: 0 }, () => 0.5), 0);
  assert.equal(Sync.firstWait({ ...r, pre: 1 }, () => 0.5), 12.5);
  assert.equal(Sync.firstWait({ ...r, pre: 2 }, () => 0.5), 15.5);
  assert.equal(Sync.firstWait({ ...r, pre: 2 }, () => 0), 13);
  assert.equal(Sync.firstWait(null), 0);
  // Random.Range(min, max + 1) when max is above 0: Eye_Close_01's [0, 1] gives 0 or 1 extra blink
  assert.equal(Sync.extraPlays({ loops: [0, 1] }, () => 0.49), 0);
  assert.equal(Sync.extraPlays({ loops: [0, 1] }, () => 0.51), 1);
  assert.equal(Sync.extraPlays({ loops: [2, 0] }, () => 0.9), 0);
  assert.equal(Sync.rangeInt(3, 3, () => 0.7), 3);
});

test("a random-timing clip waits, plays on its track and waits again from that start", () => {
  const state = new State(), entries = [];
  const r = runs({ Train_00_R: TRAIN }, { Train_00_R: 6.67 }, state, () => 0.5, (e, c, name) => entries.push([e.name, name]));
  r.start("Train_00_R");
  assert.deepEqual(r.list(), [{ clip: "Train_00_R", track: 3, in: 15.5, plays: 0 }]);
  r.tick(15.4);
  assert.deepEqual(state.log, []);
  r.tick(0.1);
  // set at full weight (its intro mix 0), its sound keys watched, nothing queued after it: the track holds its last frame
  assert.deepEqual(state.log, [["set", 3, "Train_00_R"]]);
  assert.equal(state.tracks[3].mixDuration, 0);
  assert.deepEqual(entries, [["Train_00_R", "Train_00_R"]]);
  // the next play: its duration plus 10 to 15 s after this one started
  assert.deepEqual(r.list(), [{ clip: "Train_00_R", track: 3, in: 19.17, plays: 1 }]);
  r.tick(19.2);
  assert.equal(state.log.length, 2);
  r.stop("Train_00_R");
  r.tick(100);
  assert.equal(state.log.length, 2);
});

test("an immediate clip plays at once, extra plays queue one duration apart, a one-shot fades its track out", () => {
  const state = new State();
  const clips = {
    Snow_00_R: { track: 3, loop: true, mode: 2, intro: 0, random: { min: 0, max: 0, loops: [0, 0], pre: 0 } },
    Blink: { track: 5, loop: false, mode: 2, finish: 2, intro: 0.1, outro: 0.3, outroAt: 0,
      random: { min: 4, max: 8, loops: [1, 2], pre: 1 } },
  };
  const r = runs(clips, { Snow_00_R: 26.67, Blink: 0.5 }, state, () => 0.99);
  r.start("Snow_00_R");
  assert.deepEqual(state.log, [["set", 3, "Snow_00_R"]]);
  r.tick(26.6);
  assert.equal(state.log.length, 1);
  r.tick(0.1); // back to back: no wait between the plays
  assert.deepEqual(state.log.at(-1), ["set", 3, "Snow_00_R"]);
  r.start("Blink");
  r.tick(7.97);
  assert.deepEqual(state.log.slice(2), [["set", 5, "Blink"], ["add", 5, "Blink", 0.5], ["add", 5, "Blink", 0.5],
    ["empty", 5, 0.3, 0.5]]);
  assert.equal(state.tracks[5].mixDuration, 0.1);
  assert.deepEqual(r.list().map((x) => x.clip), ["Snow_00_R"]); // a one-shot is done
  // a clip the skeleton lacks never starts
  assert.equal(r.start("Missing"), null);
});

test("a dialogue restarts only the waits of clips that have not played yet", () => {
  const state = new State();
  const clips = { Train_00_R: TRAIN, Talk_01_M: { track: 1, mode: 1 }, Snow: { ...TRAIN, track: 4 } };
  const r = runs(clips, { Train_00_R: 6.67, Snow: 2 }, state, () => 0);
  r.start("Train_00_R");
  r.start("Snow");
  r.tick(13); // both play (13 s: preDelay 3 + 10)
  r.tick(5);
  r.stop("Snow");
  state.tracks[4] = undefined;
  const before = r.list();
  r.returnToIdle(["Train_00_R", "Snow", "Talk_01_M"]);
  // the train has played (its track holds it): it keeps its wait; the snow's track is empty: it starts again
  assert.deepEqual(r.list(), [before[0], { clip: "Snow", track: 4, in: 13, plays: 0 }]);
});

test("sound keys play when the entry's animation time reaches them, once, and not after the entry ends", () => {
  const played = [], keys = new Sync.SoundKeys((id) => played.push(id)), state = new State();
  const e = state.setAnimation(1, "Talk_03_M", false);
  keys.watch(e, [[0, "cloth"], [1.5, "hanger"], [1.8, "swing"], [4.4, "cloth"]]);
  keys.watch(e, [[0, "twice"]]); // an entry is watched once
  keys.tick();
  assert.deepEqual(played, []); // a key at 0 waits for the entry to start
  e.time = 0.02;
  keys.tick();
  assert.deepEqual(played, ["cloth"]);
  e.time = 1.9;
  keys.tick();
  assert.deepEqual(played, ["cloth", "hanger", "swing"]);
  e.listener.interrupt(e); // a new talk takes the track
  e.time = 5;
  keys.tick();
  assert.deepEqual(played, ["cloth", "hanger", "swing"]);
  // a looping entry plays its keys again every loop
  const loop = state.setAnimation(0, "Idle_01", true), out = new Sync.SoundKeys((id) => out.ids.push(id));
  out.ids = [];
  out.watch(loop, [[0.5, "a"]]);
  for (const t of [0.3, 0.6, 0.9, 0.2, 0.7]) { loop.time = t; out.tick(); }
  assert.deepEqual(out.ids, ["a", "a"]);
  // and a one-shot lets go when it completes
  const once = state.setAnimation(2, "Talk_01_A", false), more = new Sync.SoundKeys(() => assert.fail("completed"));
  more.watch(once, [[0.9, "x"]]);
  once.listener.complete(once);
  once.time = 1;
  more.tick();
});

test("listen adds to the handlers an entry already has", () => {
  const seen = [], e = { listener: { complete: () => seen.push("first") } };
  Sync.listen(e, { complete: () => seen.push("second"), end: () => seen.push("end") });
  e.listener.complete(e);
  e.listener.end(e);
  assert.deepEqual(seen, ["first", "second", "end"]);
});

test("the idle starts its sync clips and the rest of its pool", () => {
  const clip = (name) => ({ Idle_01: { sync: ["Train_00_R", "Train_00_R"] } }[name] || { sync: [] });
  const info = { idles: { Shigure_home: ["Idle_01"], CH0336_home: ["Idle_01", "Idle_BG_B_01_R", "Idle_Cloud_01_R"] } };
  assert.deepEqual(Lobby.idleClips(info, "Shigure_home", "Idle_01", clip), ["Train_00_R"]);
  assert.deepEqual(Lobby.idleClips(info, "CH0336_home", "Idle_01", clip), ["Train_00_R", "Idle_BG_B_01_R", "Idle_Cloud_01_R"]);
  // a looping animation the pool does not start with (a mod, a fallback idle), or no data: nothing more
  assert.deepEqual(Lobby.idleClips(info, "CH0336_home", "Idle_02", clip), []);
  assert.deepEqual(Lobby.idleClips(null, "Shigure_home", "Idle_01", clip), []);
});
