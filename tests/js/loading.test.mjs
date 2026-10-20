import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/loading.js", import.meta.url), "utf8");
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let seq = 0;

class El {
  constructor() {
    this.children = []; this.parentNode = null; this.attrs = {}; this.style = {}; this.className = "";
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(" "), ...names])].join(" ").trim(); },
      remove: (...names) => { this.className = this.className.split(" ").filter((n) => !names.includes(n)).join(" "); },
      replace: (a, b) => { this.classList.remove(a); this.classList.add(b); },
      contains: (name) => this.className.split(" ").includes(name),
    };
  }
  get isConnected() { return !!this.parentNode; }
  get firstChild() { return this.children[0]; }
  appendChild(el) { el.remove(); this.children.push(el); el.parentNode = this; return el; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((el) => el !== this); this.parentNode = null; }
  replaceChildren(...children) { for (const el of [...this.children]) el.remove(); for (const el of children) this.appendChild(el); }
  set innerHTML(html) {
    this.replaceChildren();
    if (html.includes('class="loading-back"')) {
      for (const name of ["loading-back", "loading-ind"]) { const el = new El(); el.className = name; this.appendChild(el); }
    } else if (html.includes('class="loading-fallback"') || html.includes('class="loading-plain"')) {
      const fallback = new El(); fallback.className = html.includes('class="loading-plain"') ? "loading-plain" : "loading-fallback"; this.appendChild(fallback);
      const span = new El(); span.tagName = "span"; fallback.appendChild(span);
      for (let i = 0; i < (fallback.className === "loading-plain" ? 0 : 3); i++) { const dot = new El(); dot.tagName = "i"; fallback.appendChild(dot); }
    }
  }
  querySelectorAll(selector) { return this.children.flatMap((el) => [...(selector === ".ngui" && el.classList.contains("ngui") ? [el] : []), ...el.querySelectorAll(selector)]); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  querySelector(selector) {
    const [first, ...rest] = selector.split(" ");
    for (const el of this.children) {
      if (first.startsWith(".") ? el.classList.contains(first.slice(1)) : el.tagName === first) {
        if (!rest.length) return el;
        const found = el.querySelector(rest.join(" ")); if (found) return found;
      }
      const found = el.querySelector(selector); if (found) return found;
    }
    return null;
  }
}

async function harness({ translated = true, render = "ready", decoded = true, boot = false, consent = true, uiCached = false, infoReady = true } = {}) {
  const stage = new El(), sprites = deferred(), timers = new Map(), assets = [];
  let now = 0, timerId = 0;
  let localized = translated;
  const initial = boot ? stage.appendChild(new El()) : null;
  if (initial) {
    initial.id = "loading-boot"; initial.className = `loading full on${consent && uiCached ? "" : " neutral"}`;
    initial.innerHTML = '<div class="loading-back"></div><div class="loading-ind"></div>';
    initial.querySelector(".loading-ind").innerHTML = consent && uiCached ?
      '<div class="loading-fallback"><span></span><i></i><i></i><i></i></div>' : '<div class="loading-plain"><span></span></div>';
  }
  const d = {
    document: { createElement: () => new El(), getElementById: (id) => id === "stage" ? stage : id === "loading-boot" && initial?.isConnected && initial.id ? initial : null },
    performance: { now: () => now }, getComputedStyle: () => ({ opacity: "1" }),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id), requestAnimationFrame: (fn) => fn(),
    T: (key) => localized ? ({ "loading.now": "Now Loading", "loading.plain": "Loading", "app.loading": "Reading game files" }[key] || key) : key, S: 1, toast() {},
    NGUI: { find: () => null, init: () => { assets.push("indexes"); return sprites.promise; }, layout: async (name) => { assets.push(name); return {}; }, decoded: async () => decoded, render: async (tree, host) => {
      if (render === "reject") throw new Error("Missing atlas");
      if (render === "empty") return;
      const el = new El(); el.className = "ngui";
      if (render === "ready") el.style.backgroundImage = 'url("sprite.png")';
      host.appendChild(el);
    } },
  };
  globalThis.loadingDeps = d;
  const code = `const {document,performance,setTimeout,clearTimeout,requestAnimationFrame,getComputedStyle,NGUI,T,S,toast} = globalThis.loadingDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${seq++}`;
  const loading = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  if (infoReady) loading.init({ consent, uiCached, gameFound: true });
  const advance = async (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { loading, stage, sprites, advance, initial, assets, translate: () => { localized = true; loading.relabel(); } };
}

for (const mode of ["wait", "scene"]) test(`writer progress survives ${mode} navigation and the sprite upgrade`, async () => {
  const h = await harness(), writer = deferred(), page = deferred();
  let progress;
  const job = h.loading.task(async (update) => { progress = update; await writer.promise; });
  const indicator = h.stage.children[0], detail = indicator.querySelector(".loading-progress");
  progress({ label: "first.bundle", current: 1, total: 3 });
  const navigation = mode === "wait" ? h.loading.wait(page.promise) : h.loading.scene(async (covered) => { await covered; return page.promise; });
  await h.advance(300);
  assert.equal(h.stage.children.length, 2);
  page.resolve(); await flush();
  await h.advance(500); await h.advance(300); await navigation;
  assert.equal(indicator.isConnected, true);
  assert.equal(indicator.classList.contains("out"), false);
  progress({ label: "second.bundle", current: 2, total: 3 });
  assert.equal(detail.textContent, "second.bundle 2/3");
  h.sprites.resolve(); await flush();
  assert.ok(indicator.querySelector(".loading-repeater"));
  assert.equal(detail.textContent, "second.bundle 2/3");
  writer.resolve(); await flush(); await h.advance(300); await job;
  assert.equal(h.stage.children.length, 0);
});

test("automatic popup readiness includes independent writer progress and navigation", async () => {
  const h = await harness(), writer = deferred(), page = deferred();
  assert.equal(h.loading.busy(), false);
  const job = h.loading.task(() => writer.promise);
  assert.equal(h.loading.active(), false, "writer progress has a separate lifetime");
  assert.equal(h.loading.busy(), true);
  const navigation = h.loading.scene(() => page.promise);
  page.resolve(); await flush(); await h.advance(300); await navigation;
  assert.equal(h.loading.busy(), true, "navigation cannot release the writer's blocker");
  writer.resolve(); await flush(); await h.advance(300); await job;
  assert.equal(h.loading.busy(), false);
});

test("automatic popups wait for work before its indicator appears and after its display cap", async () => {
  const h = await harness(), work = deferred();
  const waiting = h.loading.wait(work.promise, { cap: 1000 });
  assert.equal(h.loading.active(), false, "the indicator's initial delay");
  assert.equal(h.loading.busy(), true);
  await h.advance(300);
  assert.equal(h.loading.active(), true);
  await h.advance(1000); await waiting;
  await h.advance(300);
  assert.equal(h.loading.active(), false, "the indicator has reached its display cap");
  assert.equal(h.loading.busy(), true, "the job continues past that cap");
  work.resolve(); await flush();
  assert.equal(h.loading.busy(), false);
});

test("a newer writer finishing does not release an older job's automatic popup blocker", async () => {
  const h = await harness(), first = deferred(), second = deferred();
  const older = h.loading.task(() => first.promise);
  const newer = h.loading.task(() => second.promise);
  second.resolve(); await flush(); await h.advance(300); await newer;
  assert.equal(h.loading.active(), false);
  assert.equal(h.loading.busy(), true);
  first.resolve(); await older;
  assert.equal(h.loading.busy(), false);
});

test("a writer finishing cannot close a running scene, and its late progress is ignored", async () => {
  const h = await harness(), writer = deferred(), page = deferred();
  let progress;
  const job = h.loading.task(async (update) => { progress = update; await writer.promise; });
  const indicator = h.stage.children[0];
  const navigation = h.loading.scene(async (covered) => { await covered; return page.promise; });
  await flush();
  writer.resolve(); await flush(); await h.advance(300); await job;
  progress({ label: "late.bundle", current: 3, total: 3 });
  assert.equal(indicator.isConnected, false);
  assert.equal(h.loading.covering(), true);
  page.resolve(); await flush(); await h.advance(300); await navigation;
  assert.equal(h.stage.children.length, 0);
});

test("a slow scene stays covered and cannot end writer progress", async () => {
  const h = await harness(), writer = deferred();
  let progress;
  const job = h.loading.task(async (update) => { progress = update; await writer.promise; });
  const rejected = assert.rejects(job, /upload refused/);
  const indicator = h.stage.children[0];
  const page = deferred();
  const navigation = h.loading.scene(() => page.promise);
  await flush(); await h.advance(15000); await h.advance(300);
  assert.equal(h.loading.covering(), true, "a slow scene never reveals partial content");
  progress({ label: "third.bundle", current: 3, total: 3 });
  assert.equal(indicator.querySelector(".loading-progress").textContent, "third.bundle 3/3");
  assert.equal(indicator.classList.contains("out"), false);
  writer.reject(new Error("upload refused")); await flush(); await h.advance(300); await rejected;
  assert.equal(h.loading.covering(), true);
  page.resolve(); await flush(); await h.advance(300); await navigation;
  assert.equal(h.stage.children.length, 0);
});


test("a cancelled scene hands its cover to the newer navigation", async () => {
  const h = await harness(), cancelled = deferred(), next = deferred();
  const first = h.loading.scene(() => new Promise(() => {}), { until: cancelled.promise });
  await flush();
  const second = h.loading.scene(() => next.promise);
  cancelled.resolve(); await flush(); await first;
  assert.equal(h.loading.covering(), true);
  assert.equal(h.stage.children.length, 1);
  next.resolve(); await flush(); await h.advance(300); await second;
  assert.equal(h.stage.children.length, 0);
});

test("writer progress keeps Loading in the right corner", () => {
  const css = readFileSync(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  assert.match(css, /\.loading-fallback \{[^}]*right: 84px/);
  assert.doesNotMatch(css, /with-progress \.loading-(?:fallback|ind)\s*\{/);
  assert.match(css, /\.loading-progress \{[^}]*left: 84px/);
});

test("the initial cover measures the fallback and sprite portions through reveal", async () => {
  const h = await harness(), page = deferred();
  const boot = h.loading.scene(() => page.promise, { opaque: true });
  await flush(); await h.advance(200);
  h.sprites.resolve(); await flush();
  await h.advance(700);
  page.resolve(); await flush(); await h.advance(300); await boot;
  assert.deepEqual(h.loading.timings(), { "fallback-loading": 200, "sprite-loading": 1000 });
});

for (const mode of ["scene", "wait", "task"]) test(`${mode} stays neutral until consented UI assets decode`, async () => {
  const h = await harness(), work = deferred();
  const pending = mode === "scene" ? h.loading.scene(() => work.promise) : mode === "wait" ? h.loading.wait(work.promise) : h.loading.task(() => work.promise);
  await h.advance(300);
  const indicator = h.stage.children[0], fallback = indicator.querySelector(".loading-plain");
  assert.ok(fallback);
  assert.equal(fallback.querySelector("span").textContent, "Loading");
  assert.equal(fallback.children.filter((el) => el.tagName === "i").length, 0);
  assert.equal(indicator.classList.contains("neutral"), true);
  assert.equal(indicator.attrs["aria-label"], mode === "task" ? "popup.add" : "Reading game files");
  h.sprites.resolve(); await flush();
  assert.ok(indicator.querySelector(".loading-repeater"));
  assert.equal(indicator.querySelector(".loading-plain"), null);
  assert.equal(indicator.classList.contains("neutral"), false);
  work.resolve(); await flush(); await h.advance(500); await h.advance(300); await pending;
});

for (const failure of ["indexes", "reject", "empty", "blank", "decode"]) test(`the neutral indicator stays visible after ${failure} asset failure`, async () => {
  const h = await harness({ render: ["indexes", "decode"].includes(failure) ? "ready" : failure, decoded: failure !== "decode" }), work = deferred();
  const pending = h.loading.scene(() => work.promise);
  await flush();
  const fallback = h.stage.children[0].querySelector(".loading-plain");
  if (failure === "indexes") h.sprites.reject(new Error("No game assets")); else h.sprites.resolve();
  await flush();
  assert.equal(h.stage.children[0].querySelector(".loading-plain"), fallback);
  assert.equal(fallback.querySelector("span").textContent, "Loading");
  assert.equal(h.stage.children[0].querySelector(".loading-repeater"), null);
  work.resolve(); await flush(); await h.advance(300); await pending;
});

test("boot adopts the neutral indicator and relabels it when locale strings arrive", async () => {
  const h = await harness({ boot: true, translated: false }), work = deferred();
  const fallback = h.initial.querySelector(".loading-plain");
  const pending = h.loading.scene(() => work.promise, { opaque: true });
  await flush();
  assert.equal(h.stage.children.length, 1);
  assert.equal(h.initial.querySelector(".loading-plain"), fallback, "adoption keeps the neutral indicator");
  assert.equal(fallback.querySelector("span").textContent, "");
  h.translate();
  assert.equal(fallback.querySelector("span").textContent, "Loading");
  assert.equal(h.initial.attrs["aria-label"], "Reading game files");
  work.resolve(); await flush(); await h.advance(300); await pending;
});

test("the initial document uses a neutral system style before modules and locale strings arrive", () => {
  const html = readFileSync(new URL("../../src/ba_modding_toolkit/web/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../src/ba_modding_toolkit/web/css/app.css", import.meta.url), "utf8");
  assert.match(html, /class="loading full on neutral" id="loading-boot"/);
  assert.match(html, /id="loading-boot"[\s\S]*?class="loading-plain"><span><\/span>/);
  assert.match(css, /\.loading-plain \{[^}]*system-ui, sans-serif/);
  assert.match(css, /\.loading\.neutral \.loading-back \{[^}]*#f4f4f4/);
  assert.match(css, /\.loading-fallback \{[^}]*bottom: 44px[^}]*color: #8de4ff[^}]*"RHR"[^}]*text-stroke: 1px #fff/);
});

for (const mode of ["scene", "wait", "task"]) test(`${mode} reads no loading game assets without consent, then upgrades when consent is granted`, async () => {
  const h = await harness({ consent: false }), work = deferred();
  h.sprites.resolve();
  const pending = mode === "scene" ? h.loading.scene(() => work.promise) : mode === "wait" ? h.loading.wait(work.promise) : h.loading.task(() => work.promise);
  await h.advance(300);
  const indicator = h.stage.children[0];
  assert.ok(indicator.querySelector(".loading-plain"));
  assert.deepEqual(h.assets, [], "no game layout, indexes or sprites requested");
  assert.equal(indicator.querySelector(".loading-fallback"), null);
  assert.equal(indicator.querySelector(".loading-repeater"), null);
  work.resolve(); await flush(); await h.advance(500); await h.advance(300); await pending;
});

for (const mode of ["scene", "wait", "task"]) test(`${mode} uses the stylized indicator on every cover after assets are cached`, async () => {
  const h = await harness({ consent: false }), first = deferred();
  const boot = h.loading.scene(() => first.promise);
  await flush();
  h.sprites.resolve(); await flush();
  assert.ok(h.stage.children[0].querySelector(".loading-plain"), "in-memory UI alone is not consent");
  h.loading.init({ consent: true, gameFound: true }); await flush();
  assert.ok(h.stage.children[0].querySelector(".loading-repeater"), "consent upgrades the existing cover");
  first.resolve(); await flush(); await h.advance(300); await boot;
  const work = deferred();
  const pending = mode === "scene" ? h.loading.scene(() => work.promise) : mode === "wait" ? h.loading.wait(work.promise) : h.loading.task(() => work.promise);
  await h.advance(300);
  const indicator = h.stage.children[0];
  assert.equal(indicator.querySelector(".loading-plain"), null);
  assert.equal(indicator.classList.contains("neutral"), false);
  assert.ok(indicator.querySelector(".loading-repeater"));
  work.resolve(); await flush(); await h.advance(500); await h.advance(300); await pending;
});

for (const mode of ["scene", "wait", "task"]) test(`${mode} starts stylized with an existing consented cache`, async () => {
  const h = await harness({ uiCached: true }), work = deferred();
  const pending = mode === "scene" ? h.loading.scene(() => work.promise) : mode === "wait" ? h.loading.wait(work.promise) : h.loading.task(() => work.promise);
  await h.advance(300);
  const indicator = h.stage.children[0];
  assert.ok(indicator.querySelector(".loading-fallback"), "stylized while cached sprites decode");
  assert.equal(indicator.classList.contains("neutral"), false);
  h.sprites.resolve(); await flush();
  assert.ok(indicator.querySelector(".loading-repeater"));
  work.resolve(); await flush(); await h.advance(500); await h.advance(300); await pending;
});

test("withdrawn consent keeps a late sprite reply out of the neutral cover", async () => {
  const h = await harness({ uiCached: true }), work = deferred();
  const pending = h.loading.scene(() => work.promise);
  await flush();
  h.loading.init({ consent: false, gameFound: true, uiCached: true });
  h.sprites.resolve(); await flush();
  const indicator = h.stage.children[0];
  assert.ok(indicator.querySelector(".loading-plain"));
  assert.ok(indicator.classList.contains("neutral"));
  assert.equal(indicator.querySelector(".loading-repeater"), null);
  work.resolve(); await flush(); await h.advance(300); await pending;
});

test("a cached boot stays stylized before app.info arrives", async () => {
  const h = await harness({ boot: true, uiCached: true, infoReady: false }), work = deferred();
  const pending = h.loading.scene(() => work.promise, { opaque: true });
  await flush();
  assert.ok(h.initial.querySelector(".loading-fallback"));
  assert.equal(h.initial.classList.contains("neutral"), false);
  h.sprites.resolve(); await flush();
  assert.ok(h.initial.querySelector(".loading-repeater"));
  work.resolve(); await flush(); await h.advance(300); await pending;
});
