import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clipRosterBand } from "../../src/ba_modding_toolkit/web/js/roster-card.js";
import { collectionStill } from "../../src/ba_modding_toolkit/web/js/thumbs.js";

const source = (file) => readFileSync(new URL(`../../src/ba_modding_toolkit/web/js/${file}.js`, import.meta.url), "utf8");

test("the native 405-unit tag shares the game card's baked alpha, including fractional scales", async () => {
  assert.doesNotMatch(source("roster"), /w_ = 406/);
  for (const scale of [0.5, 1920 / 2960, 0.873, 1.25]) {
    let resolve;
    const images = [new Promise((r) => { resolve = r; })];
    const style = (x, y, w, h) => ({ left: `${x * scale}px`, top: `${y * scale}px`, width: `${w * scale}px`, height: `${h * scale}px` });
    const frame = { style: { ...style(-218, -245, 436, 490), backgroundImage: 'url("card-silhouette")' } };
    const band = { style: style(-203, 139.1, 405, 87) }, portrait = { style: style(-202, -230.8, 404, 456) };
    const nodes = new Map([["Card/BG", { els: [frame] }], ["Card/Sort/Sprite", { els: [band] }], ["Card/Char_Portrait", { els: [portrait] }]]);
    const clipping = clipRosterBand({ nodes, images }, "Card");
    assert.equal(band.style.maskImage, undefined);
    resolve(); await clipping;
    assert.equal(band.style.maskImage, frame.style.backgroundImage);
    assert.equal(band.style.maskSize, `${436 * scale}px ${490 * scale}px`);
    const [x, y] = band.style.maskPosition.split(" ").map(parseFloat);
    assert.ok(Math.abs(x + 15 * scale) < 1e-6);
    assert.ok(Math.abs(y + 384.1 * scale) < 1e-6);
    assert.equal(band.style.maskRepeat, "no-repeat");
    assert.equal(portrait.style.clipPath, "inset(0 0.5px 0 0)");
  }
});

test("a collection still covers the frame with the catalog background before drawing Spine", async () => {
  const before = globalThis.document, draws = [];
  const canvas = { getContext: () => ({ drawImage: (...args) => draws.push(args) }) };
  globalThis.document = { createElement: () => canvas };
  try {
    const portrait = { width: 404, height: 456 }, bg = { naturalWidth: 1600, naturalHeight: 900 }, signal = new AbortController().signal;
    const result = await collectionStill(portrait, "/bg/practice-room", signal, async (url, options) => {
      assert.equal(url, "/bg/practice-room"); assert.equal(options.signal, signal); return bg;
    });
    assert.equal(result, canvas); assert.equal(canvas.width, 404); assert.equal(canvas.height, 456);
    assert.equal(draws[0][0], bg); assert.equal(draws[1][0], portrait);
    assert.ok(Math.abs(draws[0][2]) < 1e-6); assert.ok(draws[0][1] < 0); assert.ok(Math.abs(draws[0][4] - 456) < 1e-6);
    assert.deepEqual(draws[1].slice(1), [0, 0, 404, 456]);
    assert.equal(await collectionStill(portrait, null, signal), portrait);
    const controller = new AbortController();
    await collectionStill(portrait, "/bg/late", controller.signal, async () => { controller.abort(); return bg; });
    assert.equal(draws.length, 2, "cancellation cannot compose a late picture");
  } finally { globalThis.document = before; }
});

test("an expression cancels blinking immediately, stale blinks cannot replace it, and default resumes", () => {
  const timers = new Map(), tracks = [], clears = [];
  let next = 0;
  const player = { skeleton: { data: { findAnimation: () => true } }, animationState: {
    setAnimation: (...args) => tracks.push(args), addEmptyAnimation: (...args) => tracks.push(args), clearTrack: (track) => clears.push(track),
  } };
  const code = source("detail").split("function scheduleBlink(player) {")[1].split("function disposePortrait()")[0];
  const run = new Function("player", "setTimeout", "clearTimeout", `let mainPlayer = player, expression = "00", blinkTimer;\nfunction scheduleBlink(player) {${code}\nreturn { applyExpression, set: (face) => { expression = face; applyExpression(); } };`);
  const h = run(player, (fn) => { timers.set(++next, fn); return next; }, (id) => timers.delete(id));
  h.applyExpression(); assert.equal(timers.size, 1);
  const stale = [...timers.values()][0]; h.set("03");
  assert.equal(timers.size, 0); assert.equal(clears.at(-1), 2);
  assert.deepEqual(tracks.at(-1), [1, "03", true]);
  const count = tracks.length; stale(); assert.equal(tracks.length, count); assert.equal(timers.size, 0);
  h.set("00"); assert.equal(timers.size, 1);
  const blink = [...timers.values()][0]; timers.clear(); blink();
  assert.ok(tracks.some((item) => item[1] === "Eye_Close_01")); assert.equal(timers.size, 1);
});

test("merging uses variants rather than families and leaves unidentified and generic Mods separate", async () => {
  const { importGroups } = await import("../../src/ba_modding_toolkit/web/js/import-groups.js");
  const entries = [
    { id: "p1", kind: "spr", variant: "base" }, { id: "l1", kind: "lobby", variant: "base" },
    { id: "p2", kind: "spr", variant: "dress" }, { id: "m1", kind: "model", variant: "dress" },
    { id: "other", kind: "other", variant: "base" }, { id: "unknown", kind: "spr" },
  ];
  const identify = (entry) => ({ variant: entry.variant && { key: entry.variant, family: { key: "student" } } });
  assert.equal(importGroups(entries, false, identify).length, entries.length);
  const groups = importGroups(entries, true, identify);
  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.id)), [["p1", "l1"], ["p2", "m1"], ["other"], ["unknown"]]);
});
