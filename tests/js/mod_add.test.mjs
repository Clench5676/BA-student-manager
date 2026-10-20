import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-add.js", import.meta.url), "utf8");
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") flat(v, `${p}${k}.`, out); else out[`${p}${k}`] = v; } return out; };
let seq = 0;
async function harness({ locale = "en-US", added = [], button = "cancel", error = null, cancelled = false,
  name = ({ variant }) => ({ base: "Mutsuki", dress: "Mutsuki (Dress)" })[variant] || variant } = {}) {
  const strings = flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
  const log = [], progress = [];
  const d = {
    T: (key, vars = {}) => (strings[`webui.${key}`] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || ""),
    rpc: async (...args) => { log.push(["rpc", ...args]); return cancelled ? [] : "j1"; },
    waitJob: async (id, update) => { update({ current: 1, total: 2, label: "dress_home.bundle" }); if (error) throw error; return added; },
    Loading: { task: async (run) => { log.push(["loading"]); try { return await run((p) => progress.push(p)); } finally { log.push(["closed"]); } } },
    Popup: { message: async (opts) => { log.push(["popup", opts]); return { button }; } },
    toast: (text) => log.push(["toast", text]),
  };
  globalThis.modAddDeps = d;
  const code = `const {rpc,waitJob,T,Loading,Popup,toast} = globalThis.modAddDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${seq++}`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  mod.init({ names: async () => name,
    changed: () => log.push(["changed"]), go: (key) => log.push(["go", key]) });
  return { mod, log, progress };
}
const portrait = { target: "base", kind: "spr" }, lobby = { target: "dress", kind: "lobby" };

test("same-variant adds confirm briefly for maid, dress, swimsuit and base variants", async () => {
  for (const [key, family, core] of [
    ["ch0200", "aris", "CH0200_SPR"],
    ["ch0230", "hina", "HINA_DRESS_HOME"],
    ["hoshino_swimsuit", "hoshino", "CH0091_SPR"],
    ["aris", "aris", "ARIS_SPR"],
  ]) {
    for (const paths of [null, ["mod.bundle"]]) {
      const mod = { target: key.toUpperCase(), family, core, kind: core.endsWith("HOME") ? "lobby" : "spr" };
      const h = await harness({ added: [mod] });
      assert.deepEqual(await h.mod.add(paths, ` ${key} `), [mod]);
      assert.deepEqual(h.log.at(-1), ["toast", "Added"]);
      assert.equal(h.log.filter(([k]) => k === "changed").length, 1);
      assert.ok(!h.log.some(([k]) => k === "popup" || k === "go"));
    }
  }
});

test("another variant in the same family and another family each offer the canonical destination", async () => {
  for (const from of ["aris", "aris_noweapon", "hoshino_swimsuit"]) {
    const mod = { target: "CH0200", variant: "aris", core: "aris_maid_spr", kind: "spr" };
    const h = await harness({ added: [mod], button: "ok" });
    await h.mod.add(null, from);
    assert.equal(h.log.find(([k]) => k === "popup")[1].lines[0], "Mod for ch0200 added");
    assert.deepEqual(h.log.at(-1), ["go", "ch0200"]);
    assert.ok(!h.log.some(([k]) => k === "toast"));
  }
});

test("without a current variant the picker and file drop offer the detected student", async () => {
  for (const paths of [null, ["mod.bundle"]]) {
    const h = await harness({ added: [portrait], button: "ok" });
    await h.mod.add(paths, null);
    assert.equal(h.log.find(([k]) => k === "popup")[1].lines[0], "Mod for Mutsuki added");
    assert.deepEqual(h.log.at(-1), ["go", "base"]);
  }
});

test("entry-shaped results use variant, while core never substitutes for the catalog key", async () => {
  const mod = { variant: "CH0200", core: "aris_maid_spr", kind: "spr" };
  const h = await harness({ added: [mod] });
  await h.mod.add(null, "ch0200");
  assert.deepEqual(h.log.at(-1), ["toast", "Added"]);
  const other = await harness({ added: [mod], button: "ok" });
  await other.mod.add(null, "aris");
  assert.deepEqual(other.log.at(-1), ["go", "ch0200"]);
});

test("mixed destinations only offer navigation for mods filed away from the selected variant", async () => {
  const h = await harness({ added: [portrait, lobby], button: "ok" });
  assert.deepEqual(await h.mod.add(null, "base"), [portrait, lobby]);
  assert.deepEqual(h.log.find(([k]) => k === "popup")[1].lines, ["Mod for Mutsuki (Dress) added"]);
  assert.deepEqual(h.log.at(-1), ["go", "dress"]);
});

test("both kinds on the selected variant use the localized short confirmation", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness({ locale, added: [portrait, { ...portrait, kind: "lobby" }] });
    await h.mod.add(null, "base");
    const text = h.log.find(([k]) => k === "toast")[1];
    assert.ok(text && text !== "add.done" && !/[{}]/.test(text));
    assert.ok(!h.log.some(([k]) => k === "popup"));
  }
});

test("inserted names are trimmed without spaces around full-width commas", async () => {
  const name = "\u7231\u4e3d\u4e1d\uff08\u5973\u4ec6\uff09";
  const h = await harness({ locale: "zh-CN", added: [{ target: "ch0200", kind: "spr" }], name: () => ` ${name} \n` });
  await h.mod.add(null, "aris");
  const text = h.log.find(([k]) => k === "popup")[1].lines[0];
  assert.equal(text, `\u8be5 Mod \u5c5e\u4e8e ${name}\uff0c\u5df2\u6dfb\u52a0`);
  assert.ok(!/\s\uff0c|\uff0c\s/.test(text));
});

test("file drops use the student actually shown and refresh after either confirmation", async () => {
  const main = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
  const drop = main.slice(main.indexOf('  on("drop",'), main.indexOf('  $("top-option").addEventListener'));
  for (const shown of ["ch0200", "aris", null]) {
    const h = await harness({ added: [{ target: "ch0200", core: "aris_maid_spr", kind: "spr" }] });
    let handler, refreshes = 0, invalidations = 0;
    const env = {
      on: (name, fn) => { assert.equal(name, "drop"); handler = fn; },
      ModAdd: h.mod, Detail: { currentVariant: () => shown },
      ctx: { invalidateRoster: () => { invalidations++; } }, route: () => { refreshes++; },
      toast: () => assert.fail("a successful drop does not show a hint or error"), T: (key) => key,
    };
    new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${drop}`)(env);
    await handler({ paths: ["mod.bundle"] });
    assert.equal(h.log.some(([k]) => k === "popup"), shown !== "ch0200");
    assert.equal(h.log.some(([k]) => k === "toast"), shown === "ch0200");
    assert.equal(refreshes, 1);
    assert.equal(invalidations, 1);
  }
});

test("detail exposes the selected variant rather than its family or the route's requested variant", () => {
  const detail = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
  const variant = detail.match(/^const variant = .*$/m)[0];
  const current = detail.match(/^export const currentVariant = .*$/m)[0].replace("export ", "");
  for (const selected of ["ch0200", "aris"]) {
    const env = { open: true, fam: { key: "aris", variants: [{ key: "aris" }, { key: "ch0200" }] }, variantKey: selected };
    const h = new Function("env", `let { open, fam, variantKey } = env;
      ${variant}\n${current}
      return { currentVariant, hide() { open = false; } };`)(env);
    assert.equal(h.currentVariant(), selected);
    h.hide();
    assert.equal(h.currentVariant(), null, "the roster has no selected variant");
  }
});

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
