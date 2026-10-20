import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { overlaps, worldBounds } from "../../src/ba_modding_toolkit/web/js/lobby-health.js";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/lobby.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("export function reveal()"), source.indexOf("// the intro setting:"))
  .replace("export function", "function");
function harness(mode = "left") {
  let now = 1, pixels = true;
  const errors = [], timers = new Map(), document = { hidden: false };
  const p = { canvas: { width: 1920, height: 1080 }, stopRequestAnimationFrame: true,
    bamtLayer: { x: 0, y: 0, scale: 1 }, skeleton: {},
    startRendering() { this.stopRequestAnimationFrame = false; this.started = true; } };
  const c = { host: { hidden: false }, signal: { aborted: false }, artBase: "/art/revision/", base: "/layout/revision/",
    view: { x: 0, y: 0, w: 100, h: 100 }, all: [{ player: p }], drawnAt: now };
  const env = {
    current: c, players: [p], document, mode, talk: null, performance: { now: () => now }, overlaps, worldBounds,
    artBounds: () => ({ x0: 0, y0: 0, x1: 100, y1: 100 }),
    rectOf: (v) => ({ x0: v.x, y0: v.y, x1: v.x + v.w, y1: v.y + v.h }),
    Stage: { hostOf: () => null, shown: () => true }, Linear: { hasPixels: () => pixels },
    setTimeout: (fn) => { const id = {}; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id),
    failView: (err, host, url, step) => errors.push({ err, host, url, step }),
  };
  const reveal = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; ${code}; return reveal;`)(env);
  return { c, p, document, errors, reveal, setPixels: (value) => { pixels = value; },
    tick(frames = true) {
      now += 5000;
      if (frames) c.drawnAt = now;
      const work = [...timers.values()]; timers.clear(); work.forEach((fn) => fn());
    } };
}

test("revealing a tab restarts its stopped root player and defers drawing checks while the document is hidden", () => {
  const h = harness();
  h.reveal();
  assert.equal(h.p.started, true);
  assert.equal(h.c.revealed, true);
  h.document.hidden = true; h.tick(false);
  assert.equal(h.errors.length, 0);
  h.document.hidden = false; h.tick();
  assert.equal(h.errors.length, 0);
  assert.equal(h.c.pixelsChecked, true);
});

for (const failure of ["frames", "size", "context", "pixels", "bounds"]) test(`a visible lobby with no ${failure} reports a cause instead of remaining empty`, () => {
  const h = harness(); h.reveal();
  if (failure === "size") h.p.canvas.width = 0;
  if (failure === "context") h.p.context = { gl: { isContextLost: () => true } };
  if (failure === "pixels") h.setPixels(false);
  if (failure === "bounds") h.p.bamtLayer.x = 1e6;
  h.tick(failure !== "frames");
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].url, /\/art\/revision\/files.json/);
  assert.match(h.errors[0].step, /draw/);
});

test("a revealed intro cannot wait forever for visibility, a hold, or an unchanging clock", () => {
  for (const started of [false, true]) {
    const h = harness();
    h.c.intro = { pending: () => true, state: () => ({ started, t: 0 }) };
    h.reveal(); h.tick();
    if (started) { assert.equal(h.errors.length, 0); h.tick(); }
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].step, "intro watchdog");
    assert.equal(h.errors[0].url, "/layout/revision/lobby.json");
  }
});

test("a cancelled view's watchdog cannot fail a replacement", () => {
  const h = harness(); h.reveal(); h.c.signal.aborted = true; h.tick(false);
  assert.equal(h.errors.length, 0);
});

test("an intentional fullscreen pan past the artwork keeps its empty camera space", () => {
  const h = harness("full"); h.reveal();
  h.c.userFramed = true; h.p.bamtLayer.x = 1e6; h.setPixels(false); h.tick();
  assert.equal(h.errors.length, 0);
});
