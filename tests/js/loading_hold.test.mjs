import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

class El {
  children = []; style = {}; listeners = {}; className = ""; isConnected = true; hidden = false; parentNode = null;
  classList = {
    add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" ").trim(); },
    remove: (...names) => { this.className = this.className.split(" ").filter((n) => !names.includes(n)).join(" "); },
    replace: (a, b) => { this.classList.remove(a); this.classList.add(b); },
    contains: (name) => this.className.split(" ").includes(name),
  };
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

test("leaving releases input but automatic popups still wait for the job after navigation", async () => {
  const job = deferred(), left = deferred();
  let completed = false;
  const done = Loading.hold(async () => { await job.promise; completed = true; return "reported"; }, { until: left.promise });
  left.resolve();
  await new Promise(setImmediate);
  assert.equal(Loading.held(), false);
  assert.equal(completed, false);
  globalThis.getComputedStyle = () => ({ opacity: "1" });
  await Loading.scene(async () => {});
  assert.equal(Loading.active(), false);
  assert.equal(Loading.busy(), true, "the released hold's job still blocks an update offer");
  job.resolve();
  assert.equal(await done, "reported");
  assert.equal(Loading.busy(), false);
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

test("a repair cover blocks Back, popup clicks and Escape until success or failure", async () => {
  globalThis.getComputedStyle = () => ({ opacity: "1" });
  for (const fail of [false, true]) {
    const job = deferred();
    const back = new El(); back.back = true;
    const popup = new El(); popup.className = "popup-host";
    const done = Loading.hold(() => Loading.scene(async () => { await job.promise; if (fail) throw new Error("repair failed"); }), { all: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(Loading.covering(), true);
    assert.equal(stage.classList.contains("input-held"), true);
    assert.equal(Loading.busy(), true);
    for (const [target, key] of [[back, undefined], [popup, undefined], [popup, "Escape"]]) {
      const ev = event(target, key);
      stage.listeners[key ? "keydown" : "click"](ev);
      assert.ok(ev.prevented && ev.stopped);
    }
    job.resolve();
    if (fail) await assert.rejects(done, /repair failed/); else await done;
    assert.equal(Loading.held(), false);
    assert.equal(Loading.covering(), false);
    assert.equal(stage.classList.contains("input-held"), false);
    assert.equal(Loading.busy(), false);
  }
});


const detailSource = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const detailJob = detailSource.slice(detailSource.indexOf("async function job("), detailSource.indexOf("function shownMod()"));
function detailHarness(overrides = {}) {
  const env = { Loading, notify() {}, T: (key) => key, variant: () => ({}), fullName: () => "Student", fam: {},
    switchKind: () => "spr", progressName: () => "Student", jobProgress: () => "Repairing Student", renderScreen: async () => {},
    rpc: async () => "job", waitJob: async () => ({}), reload: async () => {}, QUEUEABLE: [], errorText: String,
    refused() {}, overwrittenMessage() {}, resumeChanged() {}, ...overrides };
  return new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
    let busy = false, pageToken = 1, open = true;
    ${detailJob}
    return job;`)(env);
}

test("detail jobs ignore Back, nav and every other interaction until the final redraw, then restore them", async () => {
  const work = deferred(), redraw = deferred(); let renders = 0;
  const job = detailHarness({ waitJob: () => work.promise, renderScreen: async () => { if (++renders === 2) await redraw.promise; } });
  const targets = ["back", "nav", "student", "variant", "tab", "mods switch", "action card", "popup trigger"].map((name) => {
    const target = new El(); target.back = name === "back"; return target;
  });
  const actions = targets.map(() => 0);
  const click = (i) => { const ev = event(targets[i]); stage.listeners.click(ev); if (!ev.stopped) actions[i]++; return ev; };
  const done = job("actions.update", { mod: "m1" });
  await new Promise(setImmediate);
  assert.equal(Loading.held(), true);
  targets.forEach((_, i) => assert.ok(click(i).stopped));
  assert.deepEqual(actions, targets.map(() => 0));
  for (const type of ["pointerdown", "pointerup", "pointermove", "keydown", "wheel", "touchstart", "touchmove"]) {
    const ev = event(targets[0]); stage.listeners[type](ev); assert.ok(ev.stopped, type);
  }
  work.resolve({}); await new Promise(setImmediate);
  assert.equal(Loading.held(), true, "the final redraw is still protected");
  assert.ok(click(0).stopped); assert.ok(click(1).stopped);
  redraw.resolve(); assert.equal(await done, true);
  assert.equal(Loading.held(), false);
  targets.forEach((_, i) => assert.equal(click(i).stopped, false));
  assert.deepEqual(actions, targets.map(() => 1));
});

test("a detail write refusal opens its answerable popup only after releasing the strict hold", async () => {
  let shown = 0;
  const job = detailHarness({ QUEUEABLE: ["actions.apply"], waitJob: async () => { throw { code: "original_unavailable" }; },
    overwrittenMessage: async () => { assert.equal(Loading.held(), false); shown++; } });
  assert.equal(await job("actions.apply", { kind: "spr" }), false);
  assert.equal(shown, 1); assert.equal(Loading.held(), false);
});

for (const entry of ["Add Mod picker", "Add Mod files", "Enable Mods"]) test(`${entry} blocks all detail input through submission and job completion`, async () => {
  const submitted = deferred(), work = deferred(), redraw = deferred();
  const targets = ["back", "nav", "student", "variant", "tab", "mods switch", "action", "popup"].map((name) => {
    const target = new El(); target.back = name === "back";
    if (name === "popup") target.className = "popup-host";
    return target;
  });
  const assertInput = (blocked) => {
    for (const target of targets) for (const type of ["click", "keydown", "pointerdown", "wheel"]) {
      const ev = event(target, "Enter"); stage.listeners[type](ev);
      assert.equal(ev.stopped, blocked, `${entry}: ${type}`);
    }
  };
  let start;
  if (entry.startsWith("Add Mod")) {
    const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-add.js", import.meta.url), "utf8");
    const env = { Loading, T: (key) => key, rpc: () => submitted.promise,
      waitJob: async () => { await work.promise; return []; }, Popup: {} };
    const add = new Function("env", `const { ${Object.keys(env).join(", ")} } = env;
      ${source.replace(/^import .*;$/gm, "").replaceAll("export ", "")}; return add;`)(env);
    start = () => add(entry.endsWith("files") ? ["mod.bundle"] : null, "base");
  } else {
    const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-switch.js", import.meta.url), "utf8");
    const run = source.slice(source.indexOf("async function run(params)"), source.indexOf("// a toggle job followed"));
    const env = { Loading, T: (key) => key, notify: assert.fail, rpc: () => submitted.promise,
      toggleJob: () => work.promise, refreshPage: () => redraw.promise, REFRESH_CAP: 1000,
      finished: () => assertInput(false), refused: assert.fail };
    start = new Function("env", `const { ${Object.keys(env).join(", ")} } = env; let inFlight = false; ${run}; return run;`)(env);
  }
  const done = start();
  assertInput(true);
  submitted.resolve("job"); await new Promise(setImmediate); assertInput(true);
  work.resolve({}); await new Promise(setImmediate);
  if (entry === "Enable Mods") assertInput(true);
  redraw.resolve(); await done;
  assert.equal(Loading.held(), false); assertInput(false);
});
