import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ROOT_ROUTE, routeHistory } from "../../src/ba_modding_toolkit/web/js/route-history.js";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("let routeToken ="), source.indexOf("async function boot("));
const deferred = () => { let resolve, reject; const promise = new Promise((r, fail) => { resolve = r; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(initial = "roster") {
  const family = deferred(), preview = deferred(), rows = deferred(), rosterData = deferred();
  const screens = Object.fromEntries(["hall", "detail", "roster", "import"].map((key) => [`screen-${key}`, { hidden: key !== initial, style: {} }]));
  const details = [], events = [];
  let covered = false, generation = 0, detailOpen = initial === "detail";
  let leave = () => true, hallHides = 0, hallSettles = 0, quitResult = "cancel";
  const env = {
    ROOT_ROUTE, routeHistory,
    StudentHall: { canLeave: () => leave(), settleView: async () => { hallSettles++; }, hide() { hallHides++; }, show: async () => { events.push("build-hall"); await rows.promise; } },
    location: { hash: "#/student/ibuki/ibuki", replace(hash) { this.hash = hash; events.push(`replace:${hash}`); } }, $: (key) => screens[key],
    history: { replaceState(_state, _title, hash) { env.location.hash = hash; } },
    ctx: {}, rosterData: null, stepCards: null, roster: () => rosterData.promise,
    BatchImport: { hide() {}, show: async () => { events.push("build-import"); await rows.promise; } }, renderNav() {},
    withTimeout: (promise) => promise, rpc: async () => family.promise, visited() {}, setTitle() {}, T: (key) => key, askQuit: () => quitResult,
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
      hide: () => { detailOpen = false; events.push("hide-detail"); }, suspend: () => { events.push("suspend-detail"); }, stepFailed() {},
      currentVariant: () => detailOpen ? "ibuki" : null,
    },
    Roster: { invalidate() {}, hide: () => events.push("hide-roster"), order: () => [], show: async () => { events.push("build-roster"); await rows.promise; } },
    noGame() {}, notify() {},
  };
  const api = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; ${code} return { route, goBack, goHome, navigation };`)(env);
  return { ...api, family, preview, rows, rosterData, details, events, screens, location: env.location, covered: () => covered,
    setLeave(fn) { leave = fn; }, setQuit(value) { quitResult = value; }, hallHides: () => hallHides, hallSettles: () => hallSettles };
}

test("the empty launch route opens Student Hall before exposing its controls", async () => {
  const h = harness("hall"); h.location.hash = "";
  const opening = h.route(); await flush();
  assert.equal(h.covered(), true); assert.ok(h.events.includes("build-hall"));
  h.rows.resolve(); await opening;
  assert.equal(h.screens["screen-hall"].hidden, false);
  assert.equal(h.navigation.current(), ROOT_ROUTE);
});

test("entering Student Hall releases the detail renderer before loading the hall scene", async () => {
  const h = harness("detail"); h.location.hash = ROOT_ROUTE;
  const opening = h.route(); await flush();
  assert.ok(h.events.indexOf("hide-detail") < h.events.indexOf("build-hall"));
  h.rows.resolve(); await opening;
  assert.equal(h.events.filter((event) => event === "hide-detail").length, 1,
    "a second detail teardown would dispose the new hall memorial renderer");
  assert.equal(h.events.at(-1), "hall");
});

test("Back returns from an imported student's detail to the same import page", async () => {
  const h = harness("hall"); h.location.hash = "#/import";
  h.rosterData.resolve({ families: [] }); h.rows.resolve(); await h.route();
  h.location.hash = "#/student/ibuki/ibuki/lobby";
  h.family.resolve({ key: "ibuki" }); h.preview.resolve(); await h.route();
  h.goBack(); assert.equal(h.location.hash, "#/import"); await h.route();
  assert.equal(h.screens["screen-import"].hidden, false);
  h.goBack(); assert.equal(h.location.hash, ROOT_ROUTE);
});

test("a canceled hall draft exit restores the address without hiding or rebuilding the scene", async () => {
  const h = harness("hall"), gate = deferred();
  h.location.hash = "#/import"; h.setLeave(() => gate.promise);
  const leaving = h.route(); await flush();
  assert.equal(h.hallHides(), 0);
  assert.equal(h.covered(), false);
  gate.resolve(false); await leaving;
  assert.equal(h.location.hash, ROOT_ROUTE);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.navigation.entries(), [ROOT_ROUTE]);
});

test("an accepted hall draft exit only releases the hall after the decision", async () => {
  const h = harness("hall"), gate = deferred();
  h.location.hash = "#/import"; h.setLeave(() => gate.promise);
  h.rosterData.resolve({ families: [] }); h.rows.resolve();
  const leaving = h.route(); await flush();
  assert.equal(h.hallHides(), 0);
  gate.resolve(true); await leaving;
  assert.equal(h.hallHides(), 1);
  assert.equal(h.screens["screen-import"].hidden, false);
});

test("a stale hall-exit rejection cannot overwrite a later accepted destination", async () => {
  const h = harness("hall"), first = deferred(), second = deferred();
  const gates = [first, second]; h.setLeave(() => gates.shift().promise);
  h.location.hash = "#/import"; const older = h.route();
  h.location.hash = "#/roster"; const newer = h.route();
  h.rosterData.resolve({ families: [] }); h.rows.resolve(); second.resolve(true); await newer;
  first.resolve(false); await older;
  assert.equal(h.location.hash, "#/roster");
  assert.equal(h.screens["screen-roster"].hidden, false);
});

test("an older hall render cannot commit while a later exit decision is pending", async () => {
  const h = harness("hall"), decision = deferred();
  h.location.hash = ROOT_ROUTE;
  const older = h.route(); await flush();
  h.setLeave(() => decision.promise); h.location.hash = "#/import";
  const newer = h.route(); await flush();
  h.rows.resolve(); await older;
  assert.ok(!h.events.includes("hall"), "the obsolete renderer cannot reveal or commit a route");
  decision.resolve(false); await newer;
  assert.equal(h.location.hash, ROOT_ROUTE);
  assert.equal(h.screens["screen-hall"].hidden, false);
  assert.equal(h.screens["screen-hall"].style.visibility, "");
  assert.deepEqual(h.navigation.entries(), [ROOT_ROUTE]);
});

test("a stale Home permission cannot execute after a newer route wins", async () => {
  const h = harness("hall"), first = deferred();
  h.location.hash = ROOT_ROUTE; h.setLeave(() => first.promise);
  const home = h.goHome();
  h.setLeave(() => true); h.location.hash = "#/roster";
  h.rows.resolve(); h.rosterData.resolve({ families: [] }); await h.route();
  first.resolve(true); await home;
  assert.equal(h.location.hash, "#/roster");
  assert.equal(h.navigation.current(), "#/roster");
});

test("Home reaches the hall and resets history after its scene commits", async () => {
  const h = harness("hall");
  h.location.hash = "#/import"; h.rosterData.resolve({ families: [] }); h.rows.resolve(); await h.route();
  h.location.hash = "#/student/ibuki/ibuki"; h.family.resolve({ key: "ibuki" }); h.preview.resolve(); await h.route();
  await h.goHome(); await h.route();
  assert.equal(h.location.hash, ROOT_ROUTE);
  assert.deepEqual(h.navigation.entries(), [ROOT_ROUTE]);
  assert.equal(h.screens["screen-hall"].hidden, false);
});

test("canceled Back and Home leave a dirty hall's return stack intact", async () => {
  const h = harness("hall");
  h.location.hash = ROOT_ROUTE; h.navigation.commit("#/import"); h.navigation.commit(ROOT_ROUTE);
  h.setLeave(() => false);
  await h.goBack(); await h.goHome();
  assert.equal(h.location.hash, ROOT_ROUTE);
  assert.deepEqual(h.navigation.entries(), [ROOT_ROUTE, "#/import", ROOT_ROUTE]);
  assert.equal(h.hallHides(), 0);
});

test("Home already in the hall settles accepted draft visuals without reopening the route", async () => {
  const h = harness("hall"); h.location.hash = ROOT_ROUTE;
  await h.goHome();
  assert.equal(h.hallSettles(), 1);
  assert.ok(!h.events.includes("build-hall"));
  assert.equal(h.hallHides(), 0);
});

test("canceling quit restores the hall after an accepted draft exit", async () => {
  const h = harness("hall"); h.location.hash = ROOT_ROUTE;
  await h.goBack();
  assert.equal(h.hallSettles(), 1);
  h.setQuit("quit"); await h.goBack();
  assert.equal(h.hallSettles(), 1, "no new scene is started after quitting");
});

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
  assert.deepEqual(h.events, ["suspend-detail"], "release the detail before a potentially blocked roster RPC");
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
  assert.ok(h.events.includes("suspend-detail"));
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
  assert.ok(h.events.includes("suspend-detail"));
  h.rows.reject(new Error("layout export failed")); await importing;
  assert.equal(h.location.hash, "#/student/ibuki/ibuki");
  assert.ok(h.events.includes("replace:#/student/ibuki/ibuki"));
  await h.route();
  assert.equal(h.details.length, 2, "the old detail DOM is re-entered through show, not left closed");
  assert.deepEqual(h.details[1], { inPlace: true, kind: undefined });
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
    ModSwitch: { refresh: async () => ({ scan: false }), startDue: () => false },
    rpc: () => assert.fail("Off must not fetch entries"), show: () => assert.fail("Off has no prompt"),
    later: async () => calls.push("later"),
  };
  const h = new Function("deps", `let { ModSwitch, rpc, show, later } = deps; let started = false; ${start} return { start, started: () => started };`)(deps);
  await h.start("drift", {});
  await h.start("untracked", {});
  assert.deepEqual(calls, ["later"]);
  assert.equal(h.started(), true);
});

function bootHarness({ compiled = true, startupUpdate = true } = {}) {
  const first = deferred(), consent = deferred(), update = deferred();
  const events = [], offers = [], blockers = [], tourOffers = [];
  const host = {}, modState = { busy: false };
  let loading = false, promptBusy = false, recovery = null;
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
    Tours: { start: async (options) => { tourOffers.push(options); } },
    document: { getElementById: () => recovery },
    Consent: { show: () => { events.push("consent"); return consent.promise; }, scan: async () => events.push("scan") },
    Prompts: { start: async (name) => events.push(name), isBusy: () => promptBusy },
    Update: { check: (_host, _info, options) => { events.push("update-check"); offers.push(options); return update.promise; } },
  };
  const bootCode = source.slice(source.indexOf("async function boot("), source.indexOf("async function start()"));
  const boot = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; ${bootCode} return boot;`)(env);
  return { boot, first, consent, update, events, offers, blockers, tourOffers, modState, setLoading: (v) => { loading = v; },
    setPromptBusy: v => { promptBusy = v; }, setRecovery: v => { recovery = v; } };
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

test("roster remains visible while detail builds and only a completed detail is swapped in", async () => {
  const h = harness("roster");
  const route = h.route(); await flush();
  h.family.resolve({ key: "ibuki" }); await flush();
  assert.equal(h.screens["screen-roster"].hidden, false);
  assert.equal(h.screens["screen-detail"].style?.visibility, "hidden");
  assert.ok(!h.events.includes("detail"), "no visible showScreen before the first-frame barrier");
  h.preview.resolve(); await route;
  assert.equal(h.screens["screen-roster"].hidden, true);
  assert.equal(h.screens["screen-detail"].hidden, false);
  assert.equal(h.screens["screen-detail"].style.visibility, "");
});

test("cancelling a hidden detail build clears its staging state and prevents a late reveal", async () => {
  const h = harness("roster");
  const student = h.route(); h.family.resolve({ key: "ibuki" }); await flush();
  assert.equal(h.screens["screen-detail"].style.visibility, "hidden");
  h.location.hash = "#/roster";
  const back = h.route(); await flush(); await student;
  assert.equal(h.screens["screen-detail"].hidden, true);
  assert.equal(h.screens["screen-detail"].style.visibility, "");
  assert.equal(h.screens["screen-detail"].inert, false);
  h.preview.resolve(); h.rosterData.resolve({ families: [] }); h.rows.resolve(); await back;
  assert.equal(h.screens["screen-roster"].hidden, false);
  assert.equal(h.screens["screen-detail"].hidden, true);
});


test("the tour hook waits for first reveal and consents while a pending update network request stays independent", async () => {
  const h = bootHarness();
  const boot = h.boot();
  await flush(); assert.equal(h.tourOffers.length, 0);
  h.first.resolve(); await flush(); assert.equal(h.tourOffers.length, 0);
  h.consent.resolve(true); await boot;
  assert.equal(h.tourOffers.length, 1);
  const { ready, blocked } = h.tourOffers[0];
  await ready;
  assert.equal(blocked(), false);
  h.setLoading(true); assert.equal(blocked(), true);
  h.setLoading(false); h.modState.busy = true; assert.equal(blocked(), true);
  h.modState.busy = false; h.setPromptBusy(true); assert.equal(blocked(), true);
  h.setPromptBusy(false); h.setRecovery({}); assert.equal(blocked(), true);
  h.setRecovery(null); assert.equal(blocked(), false);
  h.update.resolve();
});
