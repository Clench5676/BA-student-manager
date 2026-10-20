// Exercise the detail job's orchestration with stand-ins for the rendered screen and RPC transport.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const jobSource = source.slice(source.indexOf("async function job("), source.indexOf("function shownMod()"));
function harness(overrides = {}) {
  const messages = [], calls = [];
  let released = false, end;
  const env = {
    toast: (s) => messages.push(s), T: (s) => s, renderScreen: async () => {},
    rpc: async () => { calls.push("submit"); return "j1"; }, waitJob: async () => ({}), reload: async () => {},
    errorText: String, QUEUEABLE: ["actions.apply", "actions.restore"], refused: (err) => messages.push(String(err)),
    overwrittenMessage: async () => {}, variant: () => ({}), resumeChanged: () => {},
    leftPage: new Promise((resolve) => { end = resolve; }),
    Loading: { hold: async (work) => { try { return await work(); } finally { released = true; } } }, ...overrides,
  };
  const state = new Function("env", `let { ${Object.keys(env).join(", ")} } = env;
    let busy = false, open = true, pageToken = 1;
    ${jobSource}
    return { job, busy: () => busy, leave() { open = false; pageToken++; } };`)(env);
  return { ...state, messages, calls, released: () => released, end };
}

test("submission, job, onDone and final reload errors release busy and allow the next switch", async () => {
  for (const where of ["render", "submit", "wait", "done", "reload"]) {
    let fail = true;
    const throws = async () => { if (fail) throw new Error(where); return "j1"; };
    const h = harness({ ...where === "render" ? { renderScreen: throws } : {},
      ...where === "submit" ? { rpc: throws } : {}, ...where === "wait" ? { waitJob: throws } : {} });
    await h.job("actions.apply", {}, { onDone: where === "done" ? throws : undefined, after: where === "reload" ? throws : undefined });
    assert.equal(h.busy(), false, where);
    assert.ok(h.released(), where);
    assert.ok(h.messages.some((s) => s.includes(where)), where);
    fail = false;
    assert.equal(await h.job("actions.restore", {}), true, where);
    assert.equal(h.busy(), false);
  }
});

test("a second switch is refused; leaving during the job still reports its end without rendering the old page", async () => {
  let finish, after = 0;
  const h = harness({ waitJob: () => new Promise((resolve) => { finish = resolve; }) });
  const job = h.job("actions.apply", {}, { after: () => { after++; } });
  await new Promise(setImmediate);
  assert.equal(await h.job("actions.restore", {}), false);
  h.leave(); h.end();
  finish({});
  assert.equal(await job, true);
  assert.equal(after, 0);
  assert.equal(h.busy(), false);
  assert.ok(h.messages.includes("job.done"));
});

test("the default job reload does not pass its success flag as a list of preview kinds", async () => {
  const reloads = [];
  const h = harness({ reload: (...args) => { reloads.push(args); } });
  assert.equal(await h.job("actions.apply", {}), true);
  assert.deepEqual(reloads, [[]]);
});

test("the apply result reaches the refresh while input is still held", async () => {
  const result = { files: [], unchanged: true, deferred: true };
  const seen = [];
  const h = harness({ waitJob: async () => result });
  assert.equal(await h.job("actions.apply", {}, {
    onDone: (value) => seen.push(value),
    after: (ok, value) => {
      assert.equal(ok, true);
      assert.equal(h.released(), false);
      seen.push(value);
    },
  }), true);
  assert.deepEqual(seen, [result, result]);
  assert.ok(h.released());
  assert.equal(h.busy(), false);
});

test("a completed add reloads only the page that opened its picker", async () => {
  const start = source.indexOf("async function addMods(");
  const addSource = source.slice(start, source.indexOf("\n}\n", start) + 2);
  for (const move of ["stay", "go", "left", "newPage"]) {
    const calls = [];
    const env = {
      ctx: { invalidateRoster: () => calls.push("roster") }, reload: async () => calls.push("reload"),
      call: (fn) => fn(), location: { hash: "#/student/base/base" }, variant: () => ({ key: "base" }),
    };
    const h = new Function("env", `const { ctx, reload, call, location, variant } = env;
      let pageToken = 1, open = true;
      const ModAdd = { add: async (paths, key) => {
        env.check(paths, key);
        if ("${move}" === "go") location.hash = "#/student/base/dress";
        if ("${move}" === "left") open = false;
        if ("${move}" === "newPage") pageToken++;
        return [{ target: "dress" }];
      } };
      ${addSource}
      return { addMods };`)({ ...env, check: (paths, key) => {
        assert.equal(paths, null);
        assert.equal(key, "base", "the selected variant is captured before the picker or job runs");
      } });
    await h.addMods();
    assert.deepEqual(calls, move === "stay" ? ["roster", "reload"] : ["roster"]);
  }
});
