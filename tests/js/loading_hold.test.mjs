import assert from "node:assert/strict";
import { test } from "node:test";

class El {
  children = []; style = {}; listeners = {}; className = ""; isConnected = true; hidden = false; parentNode = null;
  classList = { add() {}, remove() {}, replace() {} };
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute() {}
  removeAttribute() {}
  remove() { this.isConnected = false; }
  appendChild(el) { el.parentNode = this; this.children.push(el); return el; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(selector) {
    for (let n = this; n; n = n.parentNode) {
      if (selector === ".topbar .back" && n.back) return n;
      if (selector.includes(":not([hidden])") && !n.hidden && /popup-host|consent-host/.test(n.className)) return n;
    }
    return null;
  }
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
globalThis.document = { createElement: () => new El(), getElementById: (id) => id === "stage" ? stage : null,
  querySelector: () => stage.children.find((el) => !el.hidden && /popup-host|consent-host/.test(el.className)) || null };
globalThis.addEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.fetch = async () => { throw new Error("no game assets in this test"); };
const Loading = await import("../../src/ba_modding_toolkit/web/js/loading.js");
const Popup = await import("../../src/ba_modding_toolkit/web/js/popup.js");
const event = (target = new El(), key) => ({ target, key, prevented: false, stopped: false,
  preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

test("input is held immediately through a slow apply, while Back keeps working", async () => {
  const job = deferred();
  const done = Loading.hold(() => job.promise);
  assert.equal(Loading.held(), true);
  const click = event(); stage.listeners.click(click);
  assert.ok(click.prevented && click.stopped);
  const backButton = new El(); backButton.back = true;
  const back = event(backButton); stage.listeners.click(back);
  assert.equal(back.prevented, false);
  await new Promise((r) => setTimeout(r, 350));
  assert.ok(Loading.active(), "the existing corner indicator shows during the hold");
  assert.equal(Loading.held(), true);
  job.resolve(7);
  assert.equal(await done, 7);
  assert.equal(Loading.held(), false);
});

test("every open popup layer and the consent and prompt controls pass capture while page input stays held", async () => {
  const work = deferred();
  const done = Loading.hold(() => work.promise);
  try {
    const host = stage.appendChild(new El());
    const lower = host.appendChild(new El()), upper = host.appendChild(new El());
    Popup.opened(host, () => {}, { el: lower });
    Popup.opened(host, null, { el: upper });
    const consent = stage.appendChild(new El()); consent.className = "consent-host";
    const prompt = stage.appendChild(new El()); prompt.className = "popup-host";
    for (const layer of [lower, upper, consent, prompt]) {
      const button = layer.appendChild(new El());
      for (const type of ["pointerdown", "click", "keydown"]) {
        const ev = event(button, type === "keydown" ? "Enter" : undefined);
        stage.listeners[type](ev);
        assert.equal(ev.prevented || ev.stopped, false, `${type} in ${layer.className || "a stacked popup"}`);
      }
    }
    for (const type of ["pointerdown", "click", "keydown"]) {
      const ev = event(stage, type === "keydown" ? "Enter" : undefined);
      stage.listeners[type](ev);
      assert.ok(ev.prevented && ev.stopped, `${type} on the underlying page`);
    }
    for (const layer of [host, consent, prompt]) layer.hidden = true;
    const hidden = event(lower); stage.listeners.click(hidden);
    assert.ok(hidden.prevented && hidden.stopped, "closed layers grant no exemption");
  } finally { work.resolve(); await done; }
});

test("Escape reaches the top popup while focus remains on the held page", async () => {
  const work = deferred();
  const done = Loading.hold(() => work.promise);
  const host = stage.appendChild(new El());
  let closed = false;
  Popup.opened(host, () => { closed = true; host.hidden = true; });
  try {
    const escape = event(stage, "Escape"); stage.listeners.keydown(escape);
    assert.equal(escape.prevented || escape.stopped, false);
    Popup.onKey({ ...escape, defaultPrevented: escape.prevented });
    assert.ok(closed, "the popup's own Escape handler runs");
    assert.equal(Loading.held(), true);
    const background = event(); stage.listeners.click(background);
    assert.ok(background.prevented && background.stopped);
  } finally { work.resolve(); await done; }
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
