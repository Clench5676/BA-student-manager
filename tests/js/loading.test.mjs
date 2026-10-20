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
    } else if (html.includes('class="loading-plain"')) {
      const plain = new El(); plain.className = "loading-plain"; this.appendChild(plain);
      const span = new El(); span.tagName = "span"; plain.appendChild(span);
    }
  }
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

async function harness() {
  const stage = new El(), sprites = deferred(), timers = new Map();
  let now = 0, timerId = 0;
  const d = {
    document: { createElement: () => new El(), getElementById: (id) => id === "stage" ? stage : null },
    performance: { now: () => now }, getComputedStyle: () => ({ opacity: "1" }),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => timers.delete(id), requestAnimationFrame: (fn) => fn(),
    T: (key) => key, S: 1, toast() {},
    NGUI: { init: () => sprites.promise, layout: async () => ({}), decoded: async () => {}, render: async (tree, host) => {
      const el = new El(); el.className = "ngui"; host.appendChild(el);
    } },
  };
  globalThis.loadingDeps = d;
  const code = `const {document,performance,setTimeout,clearTimeout,requestAnimationFrame,getComputedStyle,NGUI,T,S,toast} = globalThis.loadingDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${seq++}`;
  const loading = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const advance = async (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { loading, stage, sprites, advance };
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
  assert.match(css, /\.loading-plain \{[^}]*right: 84px/);
  assert.doesNotMatch(css, /with-progress \.loading-(?:plain|ind)\s*\{/);
  assert.match(css, /\.loading-progress \{[^}]*left: 84px/);
});

test("the initial cover measures the plain and game-styled portions through reveal", async () => {
  const h = await harness(), page = deferred();
  const boot = h.loading.scene(() => page.promise, { opaque: true });
  await flush(); await h.advance(200);
  h.sprites.resolve(); await flush();
  await h.advance(700);
  page.resolve(); await flush(); await h.advance(300); await boot;
  assert.deepEqual(h.loading.timings(), { "plain-loading": 200, "styled-loading": 1000 });
});
