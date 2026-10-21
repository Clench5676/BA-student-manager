import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("let routeToken ="), source.indexOf("async function boot("));
const deferred = () => { let resolve, reject; const promise = new Promise((r, fail) => { resolve = r; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(initial = "roster") {
  const family = deferred(), preview = deferred(), rows = deferred(), rosterData = deferred();
  const screens = Object.fromEntries(["detail", "roster", "import"].map((key) => [`screen-${key}`, { hidden: key !== initial }]));
  const details = [], events = [];
  let covered = false, generation = 0, detailOpen = initial === "detail";
  const env = {
    location: { hash: "#/student/ibuki/ibuki", replace(hash) { this.hash = hash; events.push(`replace:${hash}`); } }, $: (key) => screens[key],
    ctx: {}, rosterData: null, stepCards: null, roster: () => rosterData.promise,
    BatchImport: { hide() {}, show: async () => { events.push("build-import"); await rows.promise; } }, renderNav() {},
    rpc: async () => family.promise, visited() {}, setTitle() {}, T: (key) => key, askQuit() {},
    showScreen: (key) => { for (const [id, el] of Object.entries(screens)) el.hidden = id !== `screen-${key}`; events.push(key); },
    Loading: {
      hold: (work) => work(),
      scene: async (work, { until }) => {
        const my = ++generation;
        covered = true;
        try { return await Promise.race([work(Promise.resolve()), until]); }
        finally { if (my === generation) covered = false; }
      },
    },
    Detail: {
      show: async (_ctx, _family, _key, options) => { detailOpen = true; details.push(options); await preview.promise; },
      hide: () => { detailOpen = false; events.push("hide-detail"); }, stepFailed() {},
      currentVariant: () => detailOpen ? "ibuki" : null,
    },
    Roster: { invalidate() {}, hide: () => events.push("hide-roster"), order: () => [], show: async () => { events.push("build-roster"); await rows.promise; } },
    noGame() {}, notify() {},
  };
  const route = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; ${code} return route;`)(env);
  return { route, family, preview, rows, rosterData, details, events, screens, location: env.location, covered: () => covered };
}

for (const initial of ["roster", "detail"]) test(`${initial} to student stays covered through the preview's first frame`, async () => {
  const h = harness(initial);
  const route = h.route();
  await flush(); assert.equal(h.covered(), true);
  assert.ok(h.events.includes("hide-roster"), "abandon list thumbnails before the detail work starts");
  assert.equal(h.details.length, 0, "the family has not arrived");
  h.family.resolve({ key: "ibuki" }); await flush();
  assert.deepEqual(h.details, [{ inPlace: initial === "detail", kind: undefined }]);
  assert.equal(h.covered(), true, "the preview is still drawing");
  h.preview.resolve(); await route;
  assert.equal(h.covered(), false);
});

for (const [kind, tab] of [["spr", "portrait"], ["portrait", "portrait"], ["lobby", "lobby"], ["model", "model"]])
  test(`imported ${kind} navigation requests its ${tab} detail tab`, async () => {
    const h = harness("import");
    const contextCode = source.slice(source.indexOf("const ctx = {"), source.indexOf("async function roster("));
    const ctx = new Function("location", `${contextCode}\nreturn ctx;`)(h.location);
    ctx.go("ibuki", "ibuki", kind);
    assert.equal(h.location.hash, `#/student/ibuki/ibuki/${tab}`);
    h.family.resolve({ key: "ibuki" }); h.preview.resolve();
    await h.route();
    assert.deepEqual(h.details, [{ inPlace: false, kind: tab }]);
  });

test("Back covers detail teardown and reveals the roster only after its rows finish", async () => {
  const h = harness("detail");
  h.location.hash = "#/roster";
  const route = h.route(); await flush();
  assert.equal(h.covered(), true);
  assert.deepEqual(h.events, ["hide-detail"], "release the detail before a potentially blocked roster RPC");
  h.rosterData.resolve({ families: [] }); await flush();
  assert.equal(h.covered(), true);
  assert.equal(h.screens["screen-roster"].hidden, true);
  h.rows.resolve(); await route;
  assert.equal(h.screens["screen-roster"].hidden, false);
  assert.equal(h.covered(), false);
});

test("Back takes over a pending student RPC without a late student reveal", async () => {
  const h = harness();
  const student = h.route(); await flush();
  h.location.hash = "#/roster";
  const back = h.route(); await flush(); await student;
  assert.equal(h.covered(), true);
  h.family.resolve({ key: "ibuki" }); await flush();
  assert.equal(h.details.length, 0);
  h.rosterData.resolve({ families: [] }); h.rows.resolve(); await back;
  assert.equal(h.screens["screen-roster"].hidden, false);
  assert.equal(h.covered(), false);
});

test("Batch Import releases detail previews and stays covered until its screen is built", async () => {
  const h = harness("detail");
  h.location.hash = "#/import";
  const route = h.route(); await flush();
  assert.equal(h.covered(), true);
  assert.ok(h.events.includes("hide-detail"));
  h.rosterData.resolve({ families: [] }); await flush();
  assert.ok(h.events.includes("build-import"));
  assert.equal(h.screens["screen-import"].hidden, true);
  h.rows.resolve(); await route;
  assert.equal(h.screens["screen-import"].hidden, false);
  assert.equal(h.covered(), false);
});

test("a failed import returns to the last student route and rebuilds its released preview", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness();
  h.family.resolve({ key: "ibuki" }); h.preview.resolve(); await h.route();
  h.location.hash = "#/import";
  h.rosterData.resolve({ families: [] });
  const importing = h.route(); await flush();
  assert.ok(h.events.includes("hide-detail"));
  h.rows.reject(new Error("layout export failed")); await importing;
  assert.equal(h.location.hash, "#/student/ibuki/ibuki");
  assert.ok(h.events.includes("replace:#/student/ibuki/ibuki"));
  await h.route();
  assert.equal(h.details.length, 2, "the old detail DOM is re-entered through show, not left closed");
  assert.deepEqual(h.details[1], { inPlace: false, kind: undefined });
  assert.equal(h.screens["screen-detail"].hidden, false);
});

test("a late import failure cannot redirect a newer student navigation", async (t) => {
  t.mock.method(console, "error", () => {});
  const h = harness("detail");
  h.rosterData.resolve({ families: [] }); h.location.hash = "#/import";
  const importing = h.route(); await flush();
  h.location.hash = "#/student/ibuki/dress";
  h.family.resolve({ key: "ibuki" }); h.preview.resolve(); await h.route(); await importing;
  h.rows.reject(new Error("late failure")); await flush();
  assert.equal(h.location.hash, "#/student/ibuki/dress");
  assert.ok(!h.events.some((event) => event.startsWith("replace:")));
});

test("startup scan prompts follow current consent without a separate startup mode", async () => {
  const prompts = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/prompts.js", import.meta.url), "utf8");
  const start = prompts.slice(prompts.indexOf("export async function start("), prompts.indexOf("async function later("))
    .replace("export async function", "async function");
  const calls = [];
  const deps = {
    scanned: async () => calls.push("wait"),
    ModSwitch: { refresh: async () => ({ scan: false }), startDue: () => false },
    rpc: () => assert.fail("Off must not fetch entries"), show: () => assert.fail("Off has no prompt"),
  };
  const h = new Function("deps", `let { scanned, ModSwitch, rpc, show } = deps; let started = false; ${start} return { start, started: () => started };`)(deps);
  await h.start("drift", {});
  await h.start("untracked", {});
  assert.deepEqual(calls, ["wait", "wait"]);
  assert.equal(h.started(), true);
});

function bootHarness({ compiled = true, startupUpdate = true } = {}) {
  const first = deferred(), consent = deferred(), update = deferred();
  const events = [], offers = [], blockers = [];
  const host = {}, modState = { busy: false };
  let loading = false;
  const env = {
    info: { gameFound: true, compiled, startupUpdate }, startup: {}, fitStage() {}, addEventListener() {},
    timed: (_phase, work) => work(), start: () => first.promise,
    rpc: async (method) => events.push(method), Cursor: { init: () => events.push("cursor") }, $: () => host,
    Loading: { scene: (work) => work(), timings: () => ({}), busy: () => loading, init() {} },
    Popup: {
      sequence: async (steps) => { for (const [, run] of steps) await run(); },
      whenIdle: async (_every, blocked) => { blockers.push(blocked); },
    },
    ModSwitch: {
      current: () => modState,
      startDue: (name, { info }) => name === "update" ? info.compiled && info.startupUpdate !== false : ["consent", "scan"].includes(name),
    },
    Consent: { show: () => { events.push("consent"); return consent.promise; }, scan: async () => events.push("scan") },
    Prompts: { start: async (name) => events.push(name) },
    Update: { check: (_host, _info, options) => { events.push("update-check"); offers.push(options); return update.promise; } },
  };
  const bootCode = source.slice(source.indexOf("async function boot("), source.indexOf("async function start()"));
  const boot = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; ${bootCode} return boot;`)(env);
  return { boot, first, consent, update, events, offers, blockers, modState, setLoading: (v) => { loading = v; } };
}

test("startup launches its update check only after reveal and finishes while the network is still pending", async () => {
  const h = bootHarness();
  const boot = h.boot();
  await flush();
  assert.deepEqual(h.events, [], "the first screen is still covered");
  h.first.resolve(); await flush();
  assert.deepEqual(h.events, ["app.ready", "cursor", "consent", "update-check"]);
  const offer = h.offers[0].beforeShow();
  await flush();
  assert.equal(h.blockers.length, 0, "the offer waits for the startup popups");
  h.consent.resolve(true);
  await boot;
  await offer;
  assert.deepEqual(h.events.slice(4), ["scan", "drift", "untracked"], "scan prompts never wait for the network check");
  const blocked = h.blockers[0];
  assert.equal(blocked(), false);
  h.setLoading(true); assert.equal(blocked(), true);
  h.setLoading(false); h.modState.busy = true; assert.equal(blocked(), true);
  h.modState.busy = false; assert.equal(blocked(), false);
  h.update.resolve();
});

for (const options of [{ compiled: false }, { startupUpdate: false }]) test(`startup skips automatic updates for ${JSON.stringify(options)}`, async () => {
  const h = bootHarness(options);
  h.first.resolve(); h.consent.resolve(true);
  await h.boot();
  assert.equal(h.offers.length, 0);
  assert.ok(!h.events.includes("update-check"));
});
