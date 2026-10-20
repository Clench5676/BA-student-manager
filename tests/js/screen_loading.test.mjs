import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("let routeToken ="), source.indexOf("async function boot("));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(initial = "roster") {
  const family = deferred(), preview = deferred(), rows = deferred(), rosterData = deferred();
  const screens = Object.fromEntries(["detail", "roster"].map((key) => [`screen-${key}`, { hidden: key !== initial }]));
  const details = [], events = [];
  let covered = false, generation = 0;
  const env = {
    location: { hash: "#/student/ibuki/ibuki" }, $: (key) => screens[key],
    ctx: {}, rosterData: null, stepCards: null, roster: () => rosterData.promise,
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
      show: async (_ctx, _family, _key, options) => { details.push(options); await preview.promise; },
      hide: () => events.push("hide-detail"), stepFailed() {},
    },
    Roster: { invalidate() {}, order: () => [], show: async () => { events.push("build-roster"); await rows.promise; } },
    noGame() {}, toast() {},
  };
  const route = new Function("env", `let { ${Object.keys(env).join(", ")} } = env; ${code} return route;`)(env);
  return { route, family, preview, rows, rosterData, details, events, screens, location: env.location, covered: () => covered };
}

for (const initial of ["roster", "detail"]) test(`${initial} to student stays covered through the preview's first frame`, async () => {
  const h = harness(initial);
  const route = h.route();
  await flush(); assert.equal(h.covered(), true);
  assert.equal(h.details.length, 0, "the family has not arrived");
  h.family.resolve({ key: "ibuki" }); await flush();
  assert.deepEqual(h.details, [{ inPlace: initial === "detail" }]);
  assert.equal(h.covered(), true, "the preview is still drawing");
  h.preview.resolve(); await route;
  assert.equal(h.covered(), false);
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

test("disabling startup checks skips scan waits and leaves later manual-scan prompts enabled", async () => {
  const prompts = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/prompts.js", import.meta.url), "utf8");
  const start = prompts.slice(prompts.indexOf("export async function start("), prompts.indexOf("async function later("))
    .replace("export async function", "async function");
  const calls = [];
  const h = new Function("scanned", `let started = false; ${start} return { start, started: () => started };`)(() => calls.push("scan"));
  await h.start("drift", { startupChecks: false });
  await h.start("untracked", { startupChecks: false });
  assert.deepEqual(calls, []);
  assert.equal(h.started(), true);
});
