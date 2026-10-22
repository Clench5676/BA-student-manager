import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/recovery.js", import.meta.url), "utf8");
class El {
  children = []; style = {}; textContent = "";
  constructor(tag) { this.tag = tag; }
  append(...children) { for (const c of children) this.appendChild(c); }
  appendChild(child) { this.children.push(child); child.parent = this; return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute() {}
  querySelector(tag) { return this.children.find((c) => c.tag === tag); }
  getContext() { throw new Error("No GPU"); }
}
function harness({ safeMode = false, canRestartSafe = true } = {}) {
  let now = 0, timerId = 0;
  const timers = new Map(), listeners = {}, calls = [], body = new El("body");
  const strings = JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url))).webui;
  const flat = {};
  const flatten = (data, prefix = "") => { for (const [k, value] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof value === "string") flat[key] = value; else flatten(value, key);
  } };
  flatten(strings);
  const ctx = { BAMT_CONFIG: { safeMode, canRestartSafe, language: "en-US", strings: flat },
    document: { body, createElement: (tag) => new El(tag), addEventListener: (name, fn) => { listeners[name] = fn; } },
    addEventListener: (name, fn) => { listeners[name] = fn; }, location: { hash: "#/student/old", reload() { calls.push(["reload"]); } },
    navigator: { userAgent: "test" }, screen: { width: 1920, height: 1080 }, devicePixelRatio: 2,
    Date: { now: () => now }, AbortController,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, due: now + ms }); return timerId; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => { const { method, params } = JSON.parse(options.body); calls.push([method, params]);
      return { ok: true, json: async () => ({ result: method === "app.report"
        ? { path: "Desktop/BAMT-report.zip", summary: "summary", copied: true } : { text: "log" } }) }; },
  };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  const walk = (node) => [node, ...node.children.flatMap(walk)];
  return { api: ctx.BAMTRecovery, calls, listeners, ctx,
    panel: () => body.children.find((c) => c.id === "bamt-recovery"),
    click: async (text) => { const b = walk(body).find((c) => c.tag === "button" && c.textContent === text); assert.ok(b, text); await b.onclick(); },
    advance: async (ms) => { now += ms; for (const [id, t] of [...timers]) if (t.due <= now) { timers.delete(id); t.fn(); } await Promise.resolve(); },
  };
}

test("slow boot stays covered; stuck boot shows the current phase and four recovery actions", async () => {
  const h = harness();
  h.api.begin("ui-indexes");
  await h.advance(44000);
  assert.equal(h.panel(), undefined);
  await h.advance(1000);
  assert.ok(h.panel());
  assert.ok(h.panel().children.some((c) => c.textContent.includes("Game UI")));
  assert.equal(h.panel().children.filter((c) => c.tag === "button").length, 4);
  await h.click("Error Report");
  assert.equal(h.calls.filter(([name]) => name === "app.report").length, 1);
  await h.click("Open Log Folder");
  await h.click("Restart in Safe Mode");
  await h.click("Retry");
  assert.ok(h.calls.some(([name]) => name === "app.restartSafe"));
});

test("first reveal cancels the watchdog and later errors are forwarded without replacing the screen", async () => {
  const h = harness();
  h.api.ready();
  h.listeners.error({ target: h.ctx, error: new Error("late error") });
  await h.advance(46000);
  assert.equal(h.panel(), undefined);
  assert.ok(h.calls.some(([name, p]) => name === "app.frontendError" && p.event?.message === "late error"));
});

test("boot exceptions, rejections and module or stylesheet load failures recover immediately", () => {
  for (const mode of ["error", "rejection", "module", "style"]) {
    const h = harness();
    if (mode === "rejection") h.listeners.unhandledrejection({ reason: new Error("rejected") });
    else h.listeners.error({ target: mode === "module" ? { src: "js/main.js" } : mode === "style" ? { href: "css/app.css" } : h.ctx,
      message: mode === "error" ? "failed" : undefined, filename: "js/main.js" });
    assert.ok(h.panel(), mode);
    assert.equal(h.api.failed(), true);
    assert.ok(h.calls.some(([name, p]) => name === "app.frontendError" && p.event?.phase === "modules"));
  }
});

test("error forwarding deduplicates and limits a burst to ten reports per minute", async () => {
  const h = harness();
  h.api.ready();
  const error = new Error("repeat");
  assert.equal(h.api.forward(error), true);
  assert.equal(h.api.forward(error), false);
  for (let i = 0; i < 30; i++) h.api.forward(new Error(String(i)));
  assert.equal(h.calls.filter(([name, p]) => name === "app.frontendError" && p.event).length, 10);
  await h.advance(60001);
  assert.equal(h.api.forward(error), true);
});

test("safe mode ignores the last page and reaches plain Settings without WebGL", async () => {
  const h = harness({ safeMode: true });
  h.listeners.DOMContentLoaded();
  assert.equal(h.ctx.location.hash, "#/settings");
  assert.equal(h.api.context().webgl.disabled, true);
  assert.ok(h.panel().children.some((c) => c.textContent === "Restart normally to leave Safe Mode"));
  await h.click("Settings");
  await h.click("Error Report");
  await h.click("Open");
  assert.ok(h.calls.some(([name]) => name === "app.log"));
  await h.advance(46000);
  assert.equal(h.api.failed(), false);
});

test("optional media load failures reach the log while their existing placeholders can finish boot", () => {
  const h = harness();
  h.listeners.error({ target: { tagName: "IMG", src: "portrait.png" } });
  assert.equal(h.panel(), undefined);
  assert.ok(h.calls.some(([name, params]) => name === "app.frontendError" && params.event.kind === "asset"));
  assert.equal(h.api.ready(), true);
});

test("normal report results use the game's shared presenter and repeated clicks create only one file", async () => {
  const h = harness(), shown = [];
  h.api.ready();
  h.api.presentReport((result) => shown.push(result));
  await Promise.all([h.api.report(), h.api.report()]);
  assert.equal(h.calls.filter(([name]) => name === "app.report").length, 1);
  assert.equal(shown.length, 1);
  assert.equal(h.panel(), undefined);
});


test("watchdog tracks progress beyond 45 seconds and late ready restores the app", async () => {
  const h = harness(), stage = { hidden: false, inert: false };
  h.ctx.document.getElementById = () => stage;
  h.api.begin("boot");
  await h.advance(30000);
  h.api.begin("ui-indexes");
  await h.advance(30000);
  assert.equal(h.panel(), undefined);
  h.api.end("ui-indexes", 30000);
  await h.advance(44000);
  assert.equal(h.panel(), undefined);
  await h.advance(1000);
  assert.ok(h.panel());
  assert.equal(stage.hidden, true);
  const logged = h.calls.filter(([name, p]) => name === "app.frontendError" && p.event).length;
  assert.equal(h.api.ready(), true);
  assert.equal(h.panel(), undefined);
  assert.equal(stage.hidden, false);
  assert.equal(stage.inert, false);
  assert.equal(h.api.failed(), false);
  assert.equal(h.calls.filter(([name, p]) => name === "app.frontendError" && p.event).length, logged);
});

test("unsupported launches hide safe restart and popup reports carry their trigger", async () => {
  const h = harness({ canRestartSafe: false });
  h.api.fail(new Error("failed"));
  assert.ok(!h.panel().children.some((c) => c.textContent === "Restart in Safe Mode"));
  const event = { kind: "popup", code: "busy", params: { operation: "apply" } };
  await h.api.report(event);
  assert.deepEqual(h.calls.find(([name]) => name === "app.report")[1].event, event);
});
