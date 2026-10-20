import assert from "node:assert/strict";
import { test } from "node:test";

class El {
  children = []; style = {}; listeners = {}; className = ""; isConnected = true;
  classList = { add() {}, remove() {}, replace() {} };
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute() {}
  removeAttribute() {}
  remove() { this.isConnected = false; }
  appendChild(el) { this.children.push(el); }
  replaceChildren(...els) { this.children = els; }
  get firstChild() { return this.children[0]; }
  set innerHTML(text) {
    if (text.includes("loading-back")) this.parts = { ".loading-back": new El(), ".loading-ind": new El() };
    else this.parts = { span: new El() };
    this.children = [new El()];
  }
  querySelector(key) { return this.parts?.[key] || null; }
  getContext() { return {}; }
}
const stage = new El();
globalThis.document = { createElement: () => new El(), getElementById: (id) => id === "stage" ? stage : null };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.fetch = async () => { throw new Error("no game assets in this test"); };
const Loading = await import("../../src/ba_modding_toolkit/web/js/loading.js");
const event = (back = false) => ({ target: { closest: () => back }, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test("input is held immediately through a slow apply, while Back keeps working", async () => {
  const job = deferred();
  const done = Loading.hold(() => job.promise);
  assert.equal(Loading.held(), true);
  const click = event(); stage.listeners.click(click);
  assert.ok(click.prevented && click.stopped);
  const back = event(true); stage.listeners.click(back);
  assert.equal(back.prevented, false);
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(Loading.active(), "the existing corner indicator shows during the hold");
  assert.equal(Loading.held(), true);
  job.resolve(7);
  assert.equal(await done, 7);
  assert.equal(Loading.held(), false);
});

test("leaving releases input at once without ending or swallowing the job", async () => {
  const job = deferred(), left = deferred();
  let completed = false;
  const done = Loading.hold(async () => { await job.promise; completed = true; return "reported"; }, { until: left.promise });
  left.resolve();
  await new Promise(setImmediate);
  assert.equal(Loading.held(), false);
  assert.equal(completed, false);
  job.resolve();
  assert.equal(await done, "reported");
});

test("overlapping holds and thrown work release exactly their own input hold", async () => {
  const job = deferred();
  const done = Loading.hold(() => job.promise);
  await assert.rejects(Loading.hold(() => { throw new Error("after job failed"); }), /after job/);
  assert.equal(Loading.held(), true);
  job.resolve();
  await done;
  assert.equal(Loading.held(), false);
});
