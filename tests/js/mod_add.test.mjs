import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-add.js", import.meta.url), "utf8");
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") flat(v, `${p}${k}.`, out); else out[`${p}${k}`] = v; } return out; };
let seq = 0;
async function harness({ locale = "en-US", added = [], button = "cancel", error = null, cancelled = false } = {}) {
  const strings = flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
  const log = [], progress = [];
  const d = {
    T: (key, vars = {}) => (strings[`webui.${key}`] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || ""),
    rpc: async (...args) => { log.push(["rpc", ...args]); return cancelled ? [] : "j1"; },
    waitJob: async (id, update) => { update({ current: 1, total: 2, label: "dress_home.bundle" }); if (error) throw error; return added; },
    Loading: { task: async (run) => { log.push(["loading"]); try { return await run((p) => progress.push(p)); } finally { log.push(["closed"]); } } },
    Popup: { message: async (opts) => { log.push(["popup", opts]); return { button }; } },
  };
  globalThis.modAddDeps = d;
  const code = `const {rpc,waitJob,T,Loading,Popup} = globalThis.modAddDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${seq++}`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  mod.init({ names: async () => ({ variant }) => ({ base: "Mutsuki", dress: "Mutsuki (Dress)" })[variant],
    changed: () => log.push(["changed"]), go: (key) => log.push(["go", key]) });
  return { mod, log, progress };
}
const portrait = { target: "base", kind: "spr" }, lobby = { target: "dress", kind: "lobby" };

test("picker add names the detected variant; Stay here leaves the route unchanged", async () => {
  const h = await harness({ added: [lobby], locale: "zh-CN" });
  assert.deepEqual(await h.mod.add(), [lobby]);
  assert.deepEqual(h.log[0], ["rpc", "mods.pick", { background: true }]);
  const opts = h.log.find(([k]) => k === "popup")[1];
  assert.equal(opts.lines[0], "该 Mod 属于 Mutsuki (Dress)，已添加");
  assert.equal(opts.ok, "前往"); assert.equal(opts.cancel, "留在此处");
  assert.ok(!h.log.some(([k]) => k === "go"));
  assert.deepEqual(h.progress, [{ current: 1, total: 2, label: "dress_home.bundle" }]);
});

test("Go to opens the detected variant for file drops too", async () => {
  const h = await harness({ added: [lobby], button: "ok" });
  await h.mod.add(["a.bundle", "b.bundle"]);
  assert.deepEqual(h.log[0], ["rpc", "mods.add", { paths: ["a.bundle", "b.bundle"], background: true }]);
  assert.deepEqual(h.log.at(-1), ["go", "dress"]);
});

test("mixed kinds name both parts and each destination can be opened", async () => {
  const h = await harness({ added: [portrait, lobby] });
  await h.mod.add();
  const opts = h.log.find(([k]) => k === "popup")[1];
  assert.deepEqual(opts.lines.map((r) => r.text), ["Mutsuki, Portrait, added", "Mutsuki (Dress), Memorial Lobby, added"]);
  const closed = [];
  opts.lines[1].button.fn({ close: (v) => closed.push(v) });
  assert.deepEqual(closed, ["cancel"]); assert.deepEqual(h.log.at(-1), ["go", "dress"]);
});

test("all five locales name both parts without missing keys or placeholders", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness({ locale, added: [portrait, lobby] });
    await h.mod.add();
    const opts = h.log.find(([k]) => k === "popup")[1];
    assert.ok(opts.lines.every((r) => r.text.includes("Mutsuki") && !/[{}]/.test(r.text)));
    assert.notEqual(opts.ok, "add.go"); assert.notEqual(opts.cancel, "add.stay");
  }
});

test("cancelled picker, duplicates and rejected uploads show no success popup", async () => {
  for (const args of [{ cancelled: true }, { added: [] }, { error: new Error("unknown target") }]) {
    const h = await harness(args);
    if (args.error) await assert.rejects(h.mod.add(), /unknown target/); else await h.mod.add();
    assert.ok(!h.log.some(([k]) => k === "popup" || k === "changed" || k === "go"));
    if (!args.cancelled) assert.ok(h.log.some(([k]) => k === "closed"));
  }
});
