// Tests for web/js/step-keys.js (the detail screen's previous / next student keys), run by tests/test_step_keys.py
// with Node's test runner: node --test tests/js/step_keys.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { KEYS, deltaOf, pacer, typing } from "../../src/ba_modding_toolkit/web/js/step-keys.js";

const key = (k, extra = {}) => ({ key: k, keyCode: 0, repeat: false, isComposing: false, defaultPrevented: false,
  altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
const flush = () => new Promise((resolve) => setImmediate(resolve));
// a step that resolves when the test says the screen shows it
function steps() {
  const runs = [], pending = [];
  let inFlight = 0, most = 0;
  const run = (delta) => {
    runs.push(delta);
    inFlight += 1;
    most = Math.max(most, inFlight);
    return new Promise((resolve) => pending.push(() => { inFlight -= 1; resolve(); }));
  };
  return { run, runs, shown: async () => { pending.shift()?.(); await flush(); }, most: () => most };
}

test("the PC client's keys: the left and right arrows", () => {
  assert.deepEqual(KEYS, { ArrowLeft: -1, ArrowRight: 1 });
  assert.equal(deltaOf(key("ArrowLeft")), -1);
  assert.equal(deltaOf(key("ArrowRight")), 1);
  assert.equal(deltaOf(key("ArrowRight", { repeat: true })), 1);
  for (const k of ["ArrowUp", "ArrowDown", "a", "d", "A", "Enter", " ", "Escape", "Left", "Right", "PageDown"]) {
    assert.equal(deltaOf(key(k)), 0, k);
  }
  assert.equal(deltaOf(null), 0);
});

test("a modifier, an input method or another handler keeps the key", () => {
  for (const m of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.equal(deltaOf(key("ArrowRight", { [m]: true })), 0, m);
  assert.equal(deltaOf(key("ArrowLeft", { isComposing: true })), 0);
  // WebKit's key that ends a conversion comes after compositionend, as keyCode 229
  assert.equal(deltaOf(key("ArrowLeft", { keyCode: 229 })), 0);
  assert.equal(deltaOf(key("ArrowLeft", { defaultPrevented: true })), 0);
});

test("text fields and controls with their own arrow keys", () => {
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) assert.equal(typing({ tagName }), true, tagName);
  assert.equal(typing({ tagName: "DIV", isContentEditable: true }), true);
  for (const tagName of ["BUTTON", "BODY", "DIV", "CANVAS"]) assert.equal(typing({ tagName, isContentEditable: false }), false, tagName);
  assert.equal(typing(null), false);
  assert.equal(typing(undefined), false);
});

test("a press steps at once; presses meanwhile wait, the latest one only", async () => {
  const s = steps(), p = pacer(s.run);
  assert.equal(p.busy, false);
  p.press(1);
  await flush();
  assert.deepEqual(s.runs, [1]);
  assert.equal(p.busy, true);
  p.press(1);
  p.press(-1);
  p.press(1);
  await flush();
  assert.deepEqual(s.runs, [1], "nothing more while the screen is not there yet");
  await s.shown();
  assert.deepEqual(s.runs, [1, 1], "the latest press, once");
  await s.shown();
  assert.deepEqual(s.runs, [1, 1]);
  assert.equal(p.busy, false);
  assert.equal(s.most(), 1);
  p.press(0);
  await flush();
  assert.deepEqual(s.runs, [1, 1]);
});

test("a held key steps at the screen's pace and stops when let go", async () => {
  const s = steps(), p = pacer(s.run);
  p.press(1, false);
  await flush();
  // the key repeats every 33 ms while the screen takes longer: one step per screen shown
  for (let screen = 0; screen < 4; screen++) {
    for (let i = 0; i < 10; i++) p.press(1, true);
    await s.shown();
  }
  assert.deepEqual(s.runs, [1, 1, 1, 1, 1]);
  assert.equal(s.most(), 1, "never two steps at once");
  for (let i = 0; i < 10; i++) p.press(1, true);
  p.release(1);
  await s.shown();
  assert.deepEqual(s.runs, [1, 1, 1, 1, 1], "let go: the repeat waiting is dropped");
  assert.equal(p.busy, false);
});

test("letting go keeps a press of its own", async () => {
  const s = steps(), p = pacer(s.run);
  p.press(-1);
  await flush();
  p.press(-1, false); // a second tap while the first step loads
  p.release(-1);
  await s.shown();
  assert.deepEqual(s.runs, [-1, -1]);
  await s.shown();
  // a repeat of the other key is not let go by this one, any repeat by a lost keyboard (the window's blur)
  p.press(1);
  await flush();
  p.press(1, true);
  p.release(-1);
  await s.shown();
  assert.deepEqual(s.runs, [-1, -1, 1, 1]);
  p.press(1, true);
  p.release();
  await s.shown();
  assert.deepEqual(s.runs, [-1, -1, 1, 1]);
  // clear drops any press waiting (the screen was left)
  p.press(1);
  await flush();
  p.press(-1);
  p.clear();
  await s.shown();
  assert.deepEqual(s.runs, [-1, -1, 1, 1, 1]);
});

test("a step that fails or declines lets the next one go", async () => {
  const runs = [];
  const errors = [];
  const original = console.error;
  console.error = (e) => errors.push(e);
  try {
    let fail = true;
    const p = pacer(async (d) => {
      runs.push(d);
      await flush();
      if (fail) { fail = false; throw new Error("rpc"); }
    });
    p.press(1);
    p.press(-1);
    await flush();
    await flush();
    await flush();
    await flush();
    assert.deepEqual(runs, [1, -1]);
    assert.equal(errors.length, 1);
    assert.equal(p.busy, false);
    // a run that declines at once (the screen is under a popup) resolves at once
    const q = pacer(() => undefined);
    q.press(1);
    await flush();
    assert.equal(q.busy, false);
  } finally {
    console.error = original;
  }
});
