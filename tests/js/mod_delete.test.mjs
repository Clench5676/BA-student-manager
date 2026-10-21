import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const removeSource = source.slice(source.indexOf("async function removeMod("), source.indexOf("// the Add First"));
function harness({ locale = "en-US", used = true, button = "ok", error = null } = {}) {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
  const calls = [], messages = [];
  const T = (key, values = {}) => key.split(".").reduce((v, part) => v[part], strings).replace(/\{(\w+)\}/g, (_, k) => values[k]);
  const deps = {
    T, rpc: async (...args) => { calls.push(args); if (error) throw error; return { name: "My portrait", used }; },
    message: async (opts) => { messages.push(opts); return { button }; },
    job: async (...args) => { calls.push(args); return true; }, notify: (text) => calls.push(["notify", text]), errorText: String,
  };
  const remove = new Function("deps", `const {${Object.keys(deps).join(",")}} = deps; ${removeSource}; return removeMod;`)(deps);
  return { remove, calls, messages, T };
}

test("delete names the mod and explains the saved source before submitting a writer job", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = harness({ locale });
    assert.equal(await h.remove("m1"), true);
    assert.deepEqual(h.calls[0], ["mods.removalInfo", { id: "m1" }]);
    assert.deepEqual(h.messages[0].lines, [h.T("mods.deleteConfirm", { name: "My portrait" }), h.T("mods.deleteRestore")]);
    assert.equal(h.messages[0].ok, h.T("btn.delete"));
    assert.equal(h.messages[0].cancel, h.T("popup.cancel"));
    assert.deepEqual(h.calls[1].slice(0, 2), ["mods.remove", { id: "m1", confirm: true }]);
  }
});

test("cancel, close, Escape and backdrop never submit deletion", async () => {
  for (const button of ["cancel", null]) {
    const h = harness({ button });
    assert.equal(await h.remove("m1"), false);
    assert.equal(h.calls.length, 1);
  }
});

test("unused mods still need confirmation, without a restore message", async () => {
  const h = harness({ used: false });
  await h.remove("m1");
  assert.deepEqual(h.messages[0].lines, [h.T("mods.deleteConfirm", { name: "My portrait" })]);
});

test("a failed confirmation lookup shows the error and cannot delete", async () => {
  const h = harness({ error: new Error("lookup failed") });
  assert.equal(await h.remove("m1"), false);
  assert.equal(h.messages.length, 0);
  assert.match(h.calls[1][1], /lookup failed/);
});

test("a completed deletion reports any pending restoration from its single writer job", async () => {
  for (const failed of [[], [{ code: "game_running" }]]) {
    const h = harness();
    await h.remove("m1");
    assert.equal(h.calls.filter(([method]) => method === "mods.remove").length, 1);
    h.calls[1][2].onDone({ failed });
    assert.deepEqual(h.calls.filter(([method]) => method === "notify"),
      failed.length ? [["notify", h.T("mods.deletePending")]] : []);
  }
});

test("applying the source already in use shows its status without starting a job", async () => {
  const applySource = source.slice(source.indexOf("async function applyCandidate("), source.indexOf("// --- variant chips"));
  const messages = [];
  const apply = new Function("deps", `const {${["variant", "modsOn", "appliedKey", "notify", "T", "job"].join(",")}} = deps;
    ${applySource}; return applyCandidate;`)({
    variant: () => ({ key: "test" }), modsOn: () => true, appliedKey: () => "m:m1",
    T: (s) => s, notify: (s) => messages.push(s), job: () => assert.fail("must not submit a job"),
  });
  await apply("m:m1", "spr");
  assert.deepEqual(messages, []);
});
