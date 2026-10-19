// Tests for the memorial lobby's zoom-out limit (web/js/lobby.js): the poses it checks (every clip the lobby plays,
// over the idle) and the painted rect shrunk until none of them uncovers its edge. Run by tests/test_lobby_view.py with
// Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

const Lobby = await import("../../src/ba_modding_toolkit/web/js/lobby.js");

// skeleton data with named animations of the given durations
const data = (anims) => ({
  animations: Object.entries(anims).map(([name, duration]) => ({ name, duration })),
  findAnimation(name) { return this.animations.find((a) => a.name === name) || null; },
});
// the clip layout lobby.json gives: talks on track 1 with their _A on 2, drags on 1, random idle clips on 4
const clip = (_l, name) => ({
  track: /_A$/.test(name) ? 2 : /^Eye/.test(name) ? 4 : 1,
  next: name === "Pat_02_M" ? "Pat_01_M" : null,
  sync: /^Talk_\d+_M$/.test(name) ? [name.replace(/_M$/, "_A")] : [],
});

test("every clip the lobby plays is sampled over the idle, with its sync clip, to its last frame", () => {
  const main = { name: "Test_home", main: true, idle: "Idle_01",
    data: data({ Idle_01: 4, Talk_01_M: 0.95, Talk_01_A: 0.95, Pat_01_M: 0.3, Pat_02_M: 0.2, PatEnd_01_M: 0.25, Eye_Close_01: 0.1,
      Start_Idle_01: 20, Talk_02_A: 1 }) };
  const bg = { name: "Test_bg", main: false, idle: "Idle_01", data: data({ Idle_01: 2, Bird_01: 0.4 }) };
  const info = { drags: [{ skeleton: "Test_home", ing: "Pat_02_M", end: "PatEnd_01_M" }, { skeleton: "Other", ing: "Look_01_M" }],
    randomIdle: { Test_home: ["Eye_Close_01", "Missing_01"], Test_bg: ["Bird_01"] } };
  const poses = Lobby.clipPoses([main, bg], info, ["Talk_01_M", "Talk_01_M"], clip);
  const byClip = {};
  for (const [layer, tracks] of poses) {
    const name = tracks.find(([track]) => track !== 0)?.[1];
    (byClip[`${layer}:${name}`] ||= []).push(tracks);
  }
  // the talk every 0.1 s up to its end (0.95 s), its sync clip on track 2 at the same time, the idle under it
  const talk = byClip["0:Talk_01_M"];
  assert.equal(talk.length, 11);
  assert.deepEqual(talk[3], [[0, "Idle_01", 0.30000000000000004, true], [1, "Talk_01_M", 0.30000000000000004, false],
    [2, "Talk_01_A", 0.30000000000000004, false]]);
  assert.deepEqual(talk.at(-1)[1], [1, "Talk_01_M", 0.95, false]);
  // the drag clips, the clip one chains to and the random idle clips; nothing twice, nothing the skeleton lacks, no
  // intro, and the other layer only its own random idle clip
  assert.deepEqual(Object.keys(byClip).sort(), ["0:Eye_Close_01", "0:PatEnd_01_M", "0:Pat_01_M", "0:Pat_02_M", "0:Talk_01_M",
    "1:Bird_01"]);
  assert.equal(byClip["0:Pat_02_M"].length, 3);
  assert.deepEqual(byClip["1:Bird_01"][4], [[0, "Idle_01", 0.4, true], [1, "Bird_01", 0.4, false]]);
});

test("without the prefab's drag boxes the drag clips are found by name", () => {
  const main = { name: "Mod_home", main: true, idle: null, data: data({ Pat_01_M: 0.1, PatEnd_01_M: 0.1, Look_01_M: 0.1, Talk_01_A: 1 }) };
  const names = new Set(Lobby.clipPoses([main], null, [], clip).map(([, tracks]) => tracks[0][1]));
  assert.deepEqual([...names].sort(), ["Look_01_M", "PatEnd_01_M", "Pat_01_M"]);
  // no idle: the clip alone
  assert.equal(Lobby.clipPoses([main], null, [], clip)[0][1].length, 1);
});

test("the painted rect gives up the cells a clip uncovers near its sides, at most a band deep", () => {
  const gw = 64, P = { i0: 10, i1: 50, j0: 5, j1: 30 }, bad = new Uint8Array(gw * 40);
  const mark = (i, j) => { bad[j * gw + i] = 1; };
  // the right edge: two columns uncovered at some rows
  mark(50, 11); mark(49, 12);
  // the bottom row: one cell
  mark(20, 5);
  assert.deepEqual(Lobby.shrinkRect(P, bad, gw, 8), { i0: 10, i1: 48, j0: 6, j1: 30 });
  // a scene that moves further than the band: the side stops a band in
  for (let i = 40; i <= 50; i++) mark(i, 20);
  assert.deepEqual(Lobby.shrinkRect(P, bad, gw, 4), { i0: 10, i1: 46, j0: 6, j1: 30 });
  // nothing uncovered: P as it was
  assert.deepEqual(Lobby.shrinkRect(P, new Uint8Array(gw * 40), gw, 8), P);
});

test("each skeleton gets its atlas, also when the game's file names differ", () => {
  const pairs = (files) => Object.fromEntries(Lobby.pairAtlases(files));
  // the usual lobby: one name each, a background with its own
  assert.deepEqual(pairs(["Akari_home.skel", "Akari_home.atlas", "Akari_home.png", "akari_bg.skel", "akari_bg.atlas"]),
    { Akari_home: "Akari_home", akari_bg: "akari_bg" });
  // Juri: the skeleton in lower case
  assert.deepEqual(pairs(["Juri_home.atlas", "Juri_home.png", "juri_home.skel"]), { juri_home: "Juri_home" });
  // CH9996: the atlas named after another character, the only one for the only skeleton
  assert.deepEqual(pairs(["CH0996_home.atlas", "CH0996_home.png", "CH9996_home.skel"]), { CH9996_home: "CH0996_home" });
  // two skeletons and one atlas that matches neither: none is guessed
  assert.deepEqual(pairs(["A_home.skel", "B_home.skel", "C_home.atlas"]), {});
  assert.deepEqual(pairs(["A_home.skel", "A_home.atlas", "B_home.skel"]), { A_home: "A_home" });
});
