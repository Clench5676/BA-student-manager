// Exercise the detail job's orchestration with stand-ins for the rendered screen and RPC transport.
import { jobProgress, progressName } from "../../src/ba_modding_toolkit/web/js/job-progress.js";
import { setStrings, T as translate } from "../../src/ba_modding_toolkit/web/js/i18n.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const jobSource = source.slice(source.indexOf("async function job("), source.indexOf("function shownMod()"));
const loadingSource = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/loading.js", import.meta.url), "utf8");
const progressSource = loadingSource.slice(loadingSource.indexOf("export function progressText("), loadingSource.indexOf("// A writer task"));
function harness(overrides = {}) {
  const messages = [], calls = [], progress = [];
  let released = false, end;
  const env = {
    notify: (s) => messages.push(s), jobProgress, progressName, fam: {}, switchKind: () => "spr", T: (s) => s, renderScreen: async () => {},
    rpc: async () => { calls.push("submit"); return "j1"; }, waitJob: async () => ({}), reload: async () => {},
    errorText: String, QUEUEABLE: ["actions.apply", "actions.restore"], refused: (err) => messages.push(String(err)),
    overwrittenMessage: async () => {}, variant: () => ({}), fullName: () => "Example", resumeChanged: () => {},
    leftPage: new Promise((resolve) => { end = resolve; }),
    Loading: { hold: async (work) => { try { return await work((value) => progress.push(value)); } finally { released = true; } } }, ...overrides,
  };
  const state = new Function("env", `let { ${Object.keys(env).join(", ")} } = env;
    let busy = false, open = true, pageToken = 1;
    ${jobSource}
    return { job, busy: () => busy, leave() { open = false; pageToken++; } };`)(env);
  return { ...state, messages, calls, progress, released: () => released, end };
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

test("detail actions keep the verb, target and count from progress in all locales", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
    const T = (key, vars = {}) => key.split(".").reduce((o, k) => o[k], strings).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
    const flat = (o, prefix = "", result = {}) => { for (const [key, value] of Object.entries(o)) {
      if (value && typeof value === "object") flat(value, prefix + key + ".", result); else result["webui." + prefix + key] = value;
    } return result; };
    globalThis.document ||= { documentElement: {} }; globalThis.document.documentElement ||= {};
    setStrings(locale, flat(strings));
    const progressText = new Function("T", `${progressSource.replace("export ", "")}; return progressText;`)(T);
    for (const [method, action, params = {}] of [["actions.apply", "apply"], ["actions.apply", "restore", { source: "official" }], ["actions.restore", "restore"], ["actions.update", "repair"],
      ["actions.extract", "extract"], ["mods.remove", "delete"]]) {
      const label = T(`progress.${action}`, { name: "portrait.bundle" });
      const progress = [];
      const h = harness({ T, Loading: { hold: (fn) => fn((value) => progress.push(value)), progressText }, waitJob: async (id, update) => {
        update({ label, current: 1, total: 3 });
        return {};
      } });
      assert.equal(await h.job(method, params, { name: "Example" }), true);
      const subject = progressName(null, T("tab.portrait"), "Example");
      const actionKey = `progress.action${action[0].toUpperCase()}${action.slice(1)}`;
      assert.deepEqual(progress, [jobProgress({ action: actionKey, name: subject }), jobProgress({ action: actionKey, name: subject, current: 1, total: 3 })]);
      assert.deepEqual(h.messages, [T("job.done")]);
      assert.ok(progress.every((text) => !text.includes("portrait.bundle")));
    }
  }
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

test("detail progress identifies the target Mod's student variant and kind instead of the active tab or bundle", async () => {
  const strings = JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"));
  const flat = (o, prefix = "", out = {}) => { for (const [key, value] of Object.entries(o)) {
    if (value && typeof value === "object") flat(value, `${prefix}${key}.`, out); else out[prefix + key] = value;
  } return out; };
  setStrings("en-US", flat(strings));
  const family = { variants: [{ key: "band", names: { en: { full: "Yoshimi (Band)", short: "Band" } },
    modList: [{ id: "m1", target: "band", kind: "lobby" }] }] };
  const h = harness({ T: translate, fam: family, variant: () => ({ key: "base" }), waitJob: async (_id, update) => {
    update({ label: "Repairing: assets-_mx-test.bundle", current: 2, total: 2 }); return {};
  } });
  await h.job("actions.update", { mod: "m1" });
  assert.match(h.progress.at(-1), /Repairing Yoshimi \(Band, Memorial Lobby\) 2 \/ 2/);
  assert.doesNotMatch(h.progress.at(-1), /assets-|\.bundle|Portrait/);
});
