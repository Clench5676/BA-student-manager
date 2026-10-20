// Tests for the memorial lobby's zoom-out limit (web/js/lobby.js): the poses it checks (every clip the lobby plays,
// over the idle) and the painted rect shrunk until none of them uncovers its edge. Run by tests/test_lobby_view.py with
// Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

const Lobby = await import("../../src/ba_modding_toolkit/web/js/lobby.js");
const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");

test("a configured lobby reads every art layer from the library preview and keeps the game's layout", async () => {
  const before = globalThis.fetch, requests = [];
  const artRevision = "a".repeat(64), layoutRevision = "b".repeat(64);
  const info = { layers: [{ name: "hero_home", active: true, x: 10, y: -20, scale: 1, order: 0, index: 0 }] };
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("manifest.json")) return { ok: true, json: async () => ({ revision: url.includes("/mod/") ? artRevision : layoutRevision }) };
    return { ok: true, json: async () => url.endsWith("lobby.json") ? info : ["hero_home.skel", "hero_home.atlas"] };
  };
  try {
    const modded = await Lobby.layersOf("hero_home", "configured");
    assert.deepEqual(requests, ["/asset/spine/mod/configured/manifest.json", "/asset/spine/lobby/hero_home/manifest.json",
      `/asset/spine/mod/configured/${artRevision}/files.json`, `/asset/spine/lobby/hero_home/${layoutRevision}/lobby.json`]);
    assert.equal(modded.layers[0].spine, `/asset/spine/mod/configured/${artRevision}/hero_home`);
    assert.equal(modded.layers[0].atlas, `/asset/spine/mod/configured/${artRevision}/hero_home.atlas`);
    assert.equal(modded.layers[0].x, 10);
    assert.equal(modded.info, info);
    requests.length = 0;
    const official = await Lobby.layersOf("hero_home");
    assert.deepEqual(requests, ["/asset/spine/lobby/hero_home/manifest.json",
      `/asset/spine/lobby/hero_home/${layoutRevision}/files.json`, `/asset/spine/lobby/hero_home/${layoutRevision}/lobby.json`]);
    assert.equal(official.layers[0].spine, `/asset/spine/lobby/hero_home/${layoutRevision}/hero_home`);
  } finally { globalThis.fetch = before; }
});

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

test("the clips the idle starts are sampled over it on their own tracks, on every layer", () => {
  // Shigure's train on track 3 of the character; Hoshino's whale on track 1 of her background, then the clip it chains to
  const main = { name: "Shigure_home", main: true, idle: "Idle_01", data: data({ Idle_01: 4, Train_00_R: 0.25 }) };
  const bg = { name: "Hoshino_bg", main: false, idle: "Idle_01", data: data({ Idle_01: 2, Start_Whale: 0.1, Whale: 0.15 }) };
  const clips = { Idle_01: { track: 0, sync: ["Train_00_R"] }, Train_00_R: { track: 3, sync: [] },
    Start_Whale: { track: 1, next: "Whale", sync: [] }, Whale: { track: 1, sync: [] } };
  const clipOf = (l, name) => (l === bg && name === "Idle_01" ? { track: 0, sync: ["Start_Whale"] } : clips[name]);
  const info = { idles: { Shigure_home: ["Idle_01"], Hoshino_bg: ["Idle_01"] } };
  const poses = Lobby.clipPoses([main, bg], info, [], clipOf);
  const train = poses.filter(([layer, tracks]) => layer === 0 && tracks[1]?.[1] === "Train_00_R");
  assert.equal(train.length, 4);
  assert.deepEqual(train[2][1], [[0, "Idle_01", 0.2, true], [3, "Train_00_R", 0.2, false]]);
  const whale = poses.filter(([layer]) => layer === 1).map(([, tracks]) => tracks[1][1]);
  assert.deepEqual([...new Set(whale)], ["Start_Whale", "Whale"]);
  // without the idle pools (no prefab data) only the clips played on demand
  assert.equal(Lobby.clipPoses([main], {}, [], clipOf).length, 0);
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

test("Unlocked keeps the art joined to the scene and leaves out parts parked away from it", () => {
  const gw = 60, gh = 40, mask = new Uint8Array(gw * gh), P = { i0: 20, i1: 39, j0: 10, j1: 29 };
  const fill = (i0, i1, j0, j1) => { for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) mask[j * gw + i] = 1; };
  // nothing painted outside P: P itself
  assert.deepEqual(Lobby.sceneBox(mask, gw, gh, P), P);
  // a floor painted past the left side, touching it, and a lamp above, two empty cells away
  fill(12, 19, 12, 20);
  fill(30, 31, 32, 34);
  // a close-up parked to the right behind a wide gap, and a speck three empty cells off the floor
  fill(50, 58, 15, 25);
  fill(8, 8, 15, 15);
  assert.deepEqual(Lobby.sceneBox(mask, gw, gh, P), { i0: 12, i1: 39, j0: 10, j1: 34 });
  // a wider gap allowance reaches the speck, never the close-up
  assert.deepEqual(Lobby.sceneBox(mask, gw, gh, P, 3), { i0: 8, i1: 39, j0: 10, j1: 34 });
  // the cells of a rect round P outside it, in up to four rects (where a clip's paint counts)
  const R = { i0: 0, i1: 59, j0: 0, j1: 39 };
  assert.deepEqual(Lobby.around(P, R), [[0, 59, 0, 9], [0, 59, 30, 39], [0, 19, 10, 29], [40, 59, 10, 29]]);
  assert.deepEqual(Lobby.around(P, { i0: 20, i1: 45, j0: 10, j1: 29 }), [[40, 45, 10, 29]]);
  assert.deepEqual(Lobby.around(R, R), []);
});

test("each zoom-out option gives its own limit, never less than the game's view or more than four across", () => {
  const G = { x: -1480, y: -832.5, w: 2960, h: 1665 };
  const m = { full: { ...G }, outer: { x0: -1704, x1: 1928, y0: -1537, y1: 1103 }, whole: { x0: -2056, x1: 2104, y0: -1697, y1: 1631 } };
  const game = { x0: -1480, x1: 1480, y0: -832.5, y1: 832.5 };
  const B = (mode, custom) => Lobby.zoomBounds({ mode, custom }, m, G);
  assert.deepEqual(B("game"), game);
  assert.deepEqual(B("art"), m.outer);
  assert.deepEqual(B("unlocked"), m.whole);
  // custom: that many game views across, around the game's view
  assert.deepEqual(B("custom", 2), { x0: -2960, x1: 2960, y0: -1665, y1: 1665 });
  assert.deepEqual(B("custom", 1), game);
  // out of range or not a number: held to 1 to 4, else 2
  assert.deepEqual(B("custom", 9), { x0: -5920, x1: 5920, y0: -3330, y1: 3330 });
  assert.deepEqual(B("custom", 0.5), game);
  assert.deepEqual(B("custom", "x"), B("custom", 2));
  // an unknown mode is the game's view; a limit narrower than the game's view is widened to it, one wider than four
  // views is cut to them
  assert.deepEqual(B("everything"), game);
  assert.deepEqual(Lobby.zoomBounds({ mode: "art" }, { ...m, outer: { x0: -100, x1: 100, y0: -100, y1: 100 } }, G), game);
  assert.deepEqual(Lobby.zoomBounds({ mode: "unlocked" }, { ...m, whole: { x0: -90000, x1: 1600, y0: -900, y1: 900 } }, G),
    { x0: -5920, x1: 1600, y0: -900, y1: 900 });
  assert.deepEqual(Lobby.ZOOM_MODES, ["game", "art", "unlocked", "custom"]);
});

test("every layer's post-processing is placed in the game's view, whatever view the stage shows", () => {
  const G = { x: -1480, y: -832.5, w: 2960, h: 1665 };
  // spine-player's camera for a viewport on a 1920 x 1080 canvas (drawFrame: fitted and centred)
  const camera = (vp, W = 1920, H = 1080) => {
    const zoom = H / W > vp.height / vp.width ? vp.width / W : vp.height / H;
    return { zoom, position: { x: vp.x + vp.width / 2, y: vp.y + vp.height / 2 }, viewportWidth: W, viewportHeight: H };
  };
  const screen = (l) => { const s = Lobby.layerViewport(G, l); return { x: s.x, y: s.y, w: s.width, h: s.height }; };
  // a background at the standard place and a character layer with its own offset and scale (the prefab's)
  for (const l of [{ x: 0, y: -962, scale: 1 }, { x: 37.5, y: -880, scale: 0.72 }]) {
    // the fullscreen game view: the canvas itself, so the pass reads exactly as before
    assert.deepEqual(Linear.screenOnCanvas(screen(l), camera(Lobby.layerViewport(G, l))), [0, 0, 1, 1]);
    // the left view, a zoom panned into a corner, a view zoomed out past the game's: the game's view on the stage
    for (const v of [{ x: 47.6, y: -400, w: 1672.4, h: 940.725 }, { x: 0, y: 0, w: 1480, h: 832.5 },
      { x: -2960, y: -1665, w: 5920, h: 3330 }]) {
      const got = Linear.screenOnCanvas(screen(l), camera(Lobby.layerViewport(v, l)));
      [(G.x - v.x) / v.w, (G.y - v.y) / v.h, G.w / v.w, G.h / v.h].forEach((x, i) => assert.ok(Math.abs(got[i] - x) < 1e-9, `${got} ${i}`));
    }
  }
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

test("each layer loops its idle, never an intro, and an intro-only skeleton rests", () => {
  const idle = (anims, layer = {}, info = null) => Lobby.idleOf(data(anims), { name: "X", ...layer }, info);
  // the SpineCharacter's idle clip, else Idle_01, else the prefab's animation unless it is an intro (Hasumi_home)
  assert.equal(idle({ Idle_01: 4, Idle_02: 4 }, {}, { idle: { X: "Idle_02" } }), "Idle_02");
  assert.equal(idle({ Start_Idle: 9, Idle_01: 4 }, { animation: "Start_Idle" }), "Idle_01");
  assert.equal(idle({ Start_Idle_01: 9, Loop: 3 }, { animation: "Loop" }), "Loop");
  // else the first other animation, Dummy last
  assert.equal(idle({ Dummy: 0.03, Start_Idle_01: 9, Sea_01: 2 }), "Sea_01");
  assert.equal(idle({ Dummy: 0.03, Start_Idle_01: 9 }), "Dummy"); // CH0184_00, Wakamo_Scene_0
  // the scenes of Shigure's intro timeline: nothing to loop, the setup pose (looped, her intro train crossed the view)
  assert.equal(idle({ Start_Idle_00: 6 }), null);
  assert.equal(idle({}), null);
});
