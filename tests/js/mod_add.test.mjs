import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-add.js", import.meta.url), "utf8");
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") flat(v, `${p}${k}.`, out); else out[`${p}${k}`] = v; } return out; };
let seq = 0;
async function harness({ locale = "en-US", added = [], button = "cancel", error = null, cancelled = false,
  compatibilityUpdate = false, compatibilityRemap = false,
  name = ({ variant }) => ({ base: "Mutsuki", dress: "Mutsuki (Dress)" })[variant] || variant } = {}) {
  const strings = flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")));
  const log = [], progress = [];
  const d = {
    T: (key, vars = {}) => (strings[`webui.${key}`] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] || ""),
    rpc: async (...args) => { log.push(["rpc", ...args]); return cancelled ? [] : "j1"; },
    waitJob: async (id, update) => { update({ current: 1, total: 2, label: "dress_home.bundle" }); if (error) throw error; return added; },
    Loading: { task: async (run, options) => { log.push(["loading", options]); try { return await run((p) => progress.push(p)); } finally { log.push(["closed"]); } } },
    Popup: { message: async (opts) => { log.push(["popup", opts]); return { button }; } },
    toast: (text) => log.push(["toast", text]),
    Compatibility: {
      compare: (report) => ({ issues: report.issues || [] }),
      show: async (report, options) => {
        log.push(["compatibility", report, options]);
        if (compatibilityUpdate) await options.onUpdate();
        if (compatibilityRemap) await options.onRemap();
      },
      check: async (...args) => log.push(["checked", ...args]),
      remap: async (id, changed, label) => { log.push(["remap", id, label]); await changed(); },
    },
  };
  globalThis.modAddDeps = d;
  const code = `const {rpc,waitJob,T,Loading,Popup,toast,Compatibility} = globalThis.modAddDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${seq++}`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  mod.init({ names: async () => name,
    changed: () => log.push(["changed"]), go: (key) => log.push(["go", key]) });
  return { mod, log, progress };
}
const portrait = { target: "base", kind: "spr" }, lobby = { target: "dress", kind: "lobby" };

test("picker and drop imports never run compatibility, even with legacy findings", async () => {
  for (const paths of [null, ["mod.bundle"]]) {
    const mod = { ...portrait, id: "m1", label: "Example" };
    const h = await harness({ added: { added: [mod], compatibility: { m1: { issues: [{ key: "bones" }], remappable: true } } },
      compatibilityUpdate: true, compatibilityRemap: true });
    await h.mod.add(paths, "base");
    assert.ok(!h.log.some(([key]) => ["compatibility", "checked", "remap"].includes(key)));
    assert.deepEqual(h.log.filter(([key]) => key === "rpc"), [["rpc", paths ? "mods.add" : "mods.pick", { ...(paths ? { paths } : {}), background: true }]]);
  }
});

test("a failed automatic switch remains visible on the current variant in all five locales", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const mod = { ...portrait, id: "m1" };
    const report = { added: [mod], failed: [{ id: "m1", code: "game_running", params: {} }] };
    const h = await harness({ locale, added: report });
    await h.mod.add(null, "base");
    const popup = h.log.find(([k]) => k === "popup")[1];
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
    assert.deepEqual(popup.lines, [strings.add.applyFailed.replace("{reason}", strings.error.game_running)]);
    assert.ok(!h.log.some(([k]) => k === "toast"));
  }
});

test("adding keeps its initial action label without starting a repair in all locales", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const mod = { ...portrait, id: "m1", label: "Painted" };
    const added = { added: [mod], compatibility: { m1: { issues: ["outdated"] } } };
    const h = await harness({ locale, added, compatibilityUpdate: true });
    await h.mod.add(["mod.bundle"], "base");
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui.progress;
    assert.deepEqual(h.log.filter(([k]) => k === "loading").map(([, options]) => options.label), [
      strings.add.replace("{name}", strings.mods)]);
    assert.ok(!h.log.some(([key]) => ["compatibility", "checked", "remap"].includes(key)));
    assert.deepEqual(h.log.filter(([key]) => key === "rpc").map(([, method]) => method), ["mods.add"]);
  }
});

test("same-variant adds confirm briefly for maid, dress, swimsuit and base variants", async () => {
  for (const [key, family, core] of [
    ["ch0200", "aris", "CH0200_SPR"],
    ["ch0230", "hina", "HINA_DRESS_HOME"],
    ["hoshino_swimsuit", "hoshino", "CH0091_SPR"],
    ["aris", "aris", "ARIS_SPR"],
  ]) {
    for (const paths of [null, ["mod.bundle"]]) {
      const mod = { target: key.toUpperCase(), family, core, kind: core.endsWith("HOME") ? "lobby" : "spr" };
      for (const report of [[mod], { added: [mod], duplicates: [], installed: [] }]) {
        const h = await harness({ added: report });
        assert.deepEqual(await h.mod.add(paths, ` ${key} `), report);
        assert.deepEqual(h.log.at(-1), ["toast", "Added"]);
        assert.equal(h.log.filter(([k]) => k === "changed").length, 1);
        assert.ok(!h.log.some(([k]) => k === "popup" || k === "go"));
      }
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

test("cancelled picker, empty reports and rejected uploads show no success popup", async () => {
  for (const args of [{ cancelled: true }, { added: [] }, { added: { added: [], duplicates: [], installed: [] } },
    { error: new Error("unknown target") }]) {
    const h = await harness(args);
    if (args.error) await assert.rejects(h.mod.add(), /unknown target/); else await h.mod.add();
    assert.ok(!h.log.some(([k]) => k === "popup" || k === "changed" || k === "go"));
    if (!args.cancelled) assert.ok(h.log.some(([k]) => k === "closed"));
  }
});

test("duplicate popup names the stored mod and offers Go to or OK in every locale", async () => {
  const duplicate = { ...portrait, id: "m1", label: "My portrait" };
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const report = { added: [], duplicates: [duplicate], installed: [] };
    const h = await harness({ locale, added: report, button: "ok" });
    assert.deepEqual(await h.mod.add(["renamed.bundle"]), report);
    const opts = h.log.find(([k]) => k === "popup")[1];
    assert.ok(opts.lines[0].includes("My portrait"));
    assert.ok(!/[{}]/.test(opts.lines[0]));
    assert.ok(!h.log.some(([k]) => k === "changed"));
    assert.deepEqual(h.log.at(-1), ["go", "base"]);
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
    assert.equal(opts.lines[0], strings.add.duplicate.replace("{name}", duplicate.label));
    assert.equal(opts.cancel, strings.picker.ok);
  }
});

test("adopted game files are reported as installed, and mixed duplicate destinations remain navigable", async () => {
  const added = { ...portrait, id: "m1", label: "Portrait" }, duplicate = { ...lobby, id: "m2", label: "Lobby" };
  const h = await harness({ added: { added: [added], duplicates: [duplicate], installed: [added] } });
  await h.mod.add();
  const opts = h.log.find(([k]) => k === "popup")[1];
  assert.match(opts.lines[0].text, /Recognized as an installed Mod/);
  assert.match(opts.lines[1].text, /Already in the Mod Library: Lobby/);
  opts.lines[1].button.fn({ close() {} });
  assert.deepEqual(h.log.at(-1), ["go", "dress"]);
  assert.equal(h.log.filter(([k]) => k === "changed").length, 1);
});

test("duplicates on the current canonical variant show OK without navigation in every locale", async () => {
  const duplicate = { ...portrait, target: " BASE ", id: "m1", label: " My portrait \n" };
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness({ locale, added: { added: [], duplicates: [duplicate], installed: [] }, button: "ok" });
    await h.mod.add(null, "base");
    const opts = h.log.find(([k]) => k === "popup")[1];
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
    assert.deepEqual(opts.lines, [strings.add.duplicate.replace("{name}", "My portrait")]);
    assert.equal(opts.ok, strings.picker.ok);
    assert.equal(opts.cancel, null);
    assert.ok(!h.log.some(([k]) => ["go", "toast", "changed"].includes(k)));
  }
});

test("adoption on the selected variant reports installation and refreshes even for an existing duplicate", async () => {
  const installed = { ...portrait, id: "m1", label: "My portrait" };
  for (const duplicate of [false, true]) {
    const report = { added: duplicate ? [] : [installed], duplicates: duplicate ? [installed] : [], installed: [installed] };
    const h = await harness({ added: report, button: "ok" });
    assert.deepEqual(await h.mod.add(null, "BASE"), report);
    const opts = h.log.find(([k]) => k === "popup")[1];
    assert.deepEqual(opts.lines, [(duplicate ? "Already in the Mod Library: My portrait\n" : "") + "Recognized as an installed Mod"]);
    assert.equal(opts.ok, "Confirm");
    assert.equal(opts.cancel, null);
    assert.equal(h.log.filter(([k]) => k === "changed").length, 1);
    assert.ok(!h.log.some(([k]) => k === "go" || k === "toast"));
  }
});

test("one report combines special results, toasts plain local adds and navigates only to other variants", async () => {
  const plain = { ...portrait, id: "plain" }, installed = { ...portrait, id: "installed" };
  const elsewhere = { ...lobby, id: "elsewhere" };
  const localDuplicate = { ...portrait, id: "local", label: "Local" };
  const remoteDuplicate = { target: " CH0200 ", kind: "spr", id: "remote", label: "Remote" };
  const report = { added: [plain, installed, elsewhere], duplicates: [localDuplicate, remoteDuplicate], installed: [installed] };
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness({ locale, added: report, button: "ok" });
    await h.mod.add(["mods.bundle"], " base ");
    const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
    const popups = h.log.filter(([k]) => k === "popup");
    assert.equal(popups.length, 1);
    const opts = popups[0][1];
    assert.deepEqual(opts.lines.map((row) => typeof row === "string" ? row : row.text), [
      strings.add.installed, strings.add.belongs.replace("{name}", "Mutsuki (Dress)"),
      strings.add.duplicate.replace("{name}", "Local"), strings.add.duplicate.replace("{name}", "Remote"),
    ]);
    assert.equal(typeof opts.lines[0], "string");
    assert.equal(typeof opts.lines[2], "string");
    assert.deepEqual(h.log.filter(([k]) => k === "toast"), [["toast", strings.add.done]]);
    assert.deepEqual(h.log.at(-1), ["go", "dress"]);
    for (const [index, target] of [[1, "dress"], [3, "ch0200"]]) {
      const closed = [];
      assert.equal(opts.lines[index].button.label, strings.add.go);
      opts.lines[index].button.fn({ close: (value) => closed.push(value) });
      assert.deepEqual(closed, ["cancel"]);
      assert.deepEqual(h.log.at(-1), ["go", target]);
    }
  }
});

test("the footer skips a duplicate on the current variant when another result can be opened", async () => {
  const report = { added: [], duplicates: [
    { ...portrait, id: "current", label: "Current" }, { ...lobby, id: "other", label: "Other" },
  ], installed: [] };
  const h = await harness({ added: report, button: "ok" });
  await h.mod.add(null, "base");
  const opts = h.log.find(([k]) => k === "popup")[1];
  assert.equal(typeof opts.lines[0], "string");
  assert.ok(opts.lines[1].button);
  assert.deepEqual(h.log.at(-1), ["go", "dress"]);
});

test("picker callers pass the selected variant and refresh new entries or adoption without revisiting a departed page", async () => {
  const detail = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
  const add = detail.slice(detail.indexOf("async function addMods("), detail.indexOf("// a job with a sticky"));
  const entry = { ...portrait, id: "m1" };
  for (const [report, changed] of [[[], false], [null, false], [[entry], true],
    [{ added: [entry], duplicates: [], installed: [] }, true],
    [{ added: [], duplicates: [entry], installed: [] }, false],
    [{ added: [], duplicates: [entry], installed: [entry] }, true]]) {
    for (const navigate of [false, true]) {
      let refreshes = 0, invalidations = 0;
      const env = { pageToken: 1, open: true, location: { hash: "#current" }, variant: () => ({ key: "ch0200" }),
        call: (fn) => fn(), ctx: { invalidateRoster: () => { invalidations++; } }, reload: async () => { refreshes++; },
        ModAdd: { add: async (...args) => {
          assert.deepEqual(args, [null, "ch0200"]);
          if (navigate) env.location.hash = "#other";
          return report;
        } },
      };
      await new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${add}; return addMods();`)(env);
      assert.equal(invalidations, Number(changed));
      assert.equal(refreshes, Number(changed && !navigate));
    }
  }
});

test("drop callers accept report objects for new mods, duplicates and adoption without an empty-drop hint", async () => {
  const main = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
  const drop = main.slice(main.indexOf('  on("drop",'), main.indexOf('  $("top-option").addEventListener'));
  for (const report of [{ added: [portrait] }, { duplicates: [portrait] }, { installed: [portrait] }]) {
    let handler, refreshes = 0, invalidations = 0;
    const env = { on: (_name, fn) => { handler = fn; }, Detail: { currentVariant: () => "base" },
      ctx: { invalidateRoster: () => { invalidations++; } }, route: () => { refreshes++; },
      toast: () => assert.fail("a successful drop has no hint or error"), T: (key) => key,
      ModAdd: { add: async (...args) => { assert.deepEqual(args, [["mod.bundle"], "base"]); return report; } },
    };
    new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${drop}`)(env);
    await handler({ paths: ["mod.bundle"] });
    assert.equal(invalidations, 1);
    assert.equal(refreshes, 1);
  }
});
