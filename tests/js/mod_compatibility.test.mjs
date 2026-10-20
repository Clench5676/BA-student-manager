// Drawing checks use the bundled Spine reader and synthetic assets, without WebGL or game files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const context = vm.createContext({ console, TextDecoder, TextEncoder, Float32Array, Uint8Array, Uint16Array, Int16Array, Int32Array, ArrayBuffer, DataView });
vm.runInContext(readFileSync(new URL("../../src/ba_modding_toolkit/web/vendor/spine-player-4.2.120/spine-player.min.js", import.meta.url), "utf8"), context);
globalThis.spine = context.spine;
const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-compatibility.js", import.meta.url), "utf8");
const fixture = JSON.parse(readFileSync(new URL("../assets/integrity/mismatched_skeleton.json", import.meta.url), "utf8"));
const encoded = (data) => ({ version: data.skeleton.spine, data: Buffer.from(JSON.stringify(data)).toString("base64") });
const atlas = (x = 1, name = "smile", size = 64) => `page.png\nsize: ${size},${size}\n${name}\n bounds: ${x},1,8,8\n`;
const inputs = (data = fixture.official) => ({ skeletons: { "test.skel": encoded(data) }, atlases: { "test.atlas": atlas() }, textures: { page: [64, 64] } });
const report = () => ({ official: inputs(), mod: inputs(), remappable: true });
const layoutReport = () => { const r = report(); r.mod.atlases["test.atlas"] = atlas(20); return r; };
let sequence = 0;
async function harness(locale = "en-US", button = "cancel", accept = false) {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
  const calls = [], popups = [], comparisons = [], covers = [];
  let nextReport = report(), rebuilt = null, held = false, covered = false;
  const saved = { mod: { id: "new-mod", repaired_from: "old-mod" } };
  globalThis.compatibilityDeps = {
    language: () => locale,
    T: (key, vars = {}) => key.split(".").reduce((o, k) => o?.[k], strings)?.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") || key,
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (["actions.remap", "actions.acceptRemap"].includes(method)) assert.ok(held && covered);
      return method;
    },
    waitJob: async (id) => id === "actions.remap" ? rebuilt : id === "actions.acceptRemap" ? saved : nextReport,
    Loading: { task: (fn) => fn(() => {}),
      hold: async (fn, opts) => { assert.equal(opts.all, true); held = true; try { return await fn(); } finally { held = false; } },
      scene: async (fn) => { covered = true; covers.push(true); try { return await fn(); } finally { covered = false; } },
    },
    Popup: { message: async (options) => { assert.equal(held, false); popups.push(options); return { button }; } },
    Compare: { show: async (...args) => { assert.equal(held, false); comparisons.push(args); return accept; } },
  };
  const code = `const { T, language, rpc, waitJob, Loading, Popup, Compare } = globalThis.compatibilityDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${sequence++}`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return { mod, calls, popups, comparisons, covers, strings, saved, use: (value) => { nextReport = value; }, build: (value) => { rebuilt = value; } };
}

test("valid custom skeletons, old bundle dates and patch versions do not report drawing failures", async () => {
  const { mod } = await harness();
  const r = report();
  r.outdated = true;
  r.mod = inputs(fixture.mod);
  r.mod.atlases["test.atlas"] = atlas(1, "coat");
  r.mod.skeletons["test.skel"].version = "4.2.120";
  assert.deepEqual(mod.compare(r).issues, []);
  assert.equal(mod.compare(r).remap, false);
});

test("binary and JSON readers identify the actual attachment paths without textures", async () => {
  const { mod } = await harness();
  const binary = readFileSync(new URL("../assets/integrity/synthetic42.skel", import.meta.url));
  const input = { version: "4.2.33", data: binary.toString("base64") };
  assert.deepEqual(Array.from(mod.readSkeleton(input).regions), ["smile"]);
  const r = report(); r.mod.skeletons["test.skel"] = input;
  assert.deepEqual(mod.compare(r).issues, []);
  const data = structuredClone(fixture.official);
  data.skins[0].attachments.face.smile.path = "face/paint";
  assert.deepEqual(mod.readSkeleton(encoded(data)).regions, ["face/paint"]);
});

test("only used region rectangles, missing regions and nonuniform page scales are findings", async () => {
  const { mod } = await harness();
  const r = report();
  r.mod.textures.page = [32, 32];
  r.mod.atlases["test.atlas"] += "unused\n bounds: 40,40,2,2\n";
  r.atlasLayout = ["test.atlas"];
  assert.deepEqual(mod.compare(r).issues, []);
  r.mod.textures.page = [32, 24];
  assert.deepEqual(mod.compare(r).issues.map((i) => i.key), ["atlasSize"]);
  r.mod = inputs();
  r.mod.atlases["test.atlas"] = atlas(1, "unused");
  assert.deepEqual(mod.compare(r).issues.map((i) => i.key), ["regions", "atlasLayout"]);
  assert.deepEqual(mod.compare(layoutReport()).issues.map((i) => i.key), ["atlasLayout"]);
  r.mod.atlases["test.atlas"] = atlas().replace("64,64", "128,128").replace("1,1,8,8", "2,2,16,16");
  r.mod.textures.page = [128, 128];
  assert.deepEqual(mod.compare(r).issues, []);
});

test("unreadable skeletons and atlases and unavailable originals never report a match", async () => {
  const { mod } = await harness();
  const r = report(); r.unavailable = true;
  r.mod.skeletons["test.skel"] = { version: "4.2.33", data: Buffer.from("broken").toString("base64") };
  r.mod.atlases["test.atlas"] = "";
  assert.deepEqual(mod.compare(r).issues.map((i) => i.key), ["unavailable", "unreadable", "atlasUnreadable"]);
});

test("the card's on-demand check is read only and never offers an in-place Update", async () => {
  const h = await harness("en-US", "ok");
  const r = report(); r.outdated = true; h.use(r);
  await h.mod.check("old-mod", "Painted", () => assert.fail("no in-place update"));
  assert.deepEqual(h.calls, [["actions.compatibility", { mod: "old-mod" }]]);
  assert.equal(h.popups[0].ok, h.strings.picker.ok);
  assert.equal(h.mod.canRemap("old-mod"), false);
});

test("dismissing a layout report never prepares a repair", async () => {
  const h = await harness(); h.use(layoutReport());
  await h.mod.check("old-mod");
  assert.equal(h.mod.canRemap("old-mod"), true);
  assert.deepEqual(h.calls, [["actions.compatibility", { mod: "old-mod" }]]);
});

const prepared = () => ({ preview: "review", pages: [{ name: "page", original: "before", repaired: "after" }], compare: { assets: [] },
  report: { partial: true, moved: ["body"], added: ["halo"], dropped: ["old"],
    upscaled: [{ w: 4096, h: 4096 }], warnings: [{ key: "rig", name: "test.skel" }] } });

test("repair previews ask first in every locale; only Accept saves and refreshes", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) for (const accept of [false, true]) {
    const h = await harness(locale, "ok", accept), preview = prepared();
    h.build(preview); h.use(layoutReport());
    let changed = 0;
    await h.mod.check("old-mod", "Painted", (result) => { assert.equal(result, h.saved); changed++; });
    assert.equal(changed, Number(accept));
    assert.deepEqual(h.calls.map(([method]) => method), ["actions.compatibility", "actions.remap", ...(accept ? ["actions.acceptRemap"] : []), "actions.discardRemap"]);
    const [data, title, host, options] = h.comparisons[0];
    assert.deepEqual(data.pages, preview.pages);
    assert.equal(title, "Painted"); assert.equal(host, "dialog");
    assert.equal(options.accept, h.strings.remap.accept);
    assert.equal(options.discard, h.strings.remap.discard);
    assert.equal(options.partial, true);
    assert.ok(options.lines.some((line) => line.includes("test.skel")));
    assert.ok(options.lines.every((line) => !/[{}]/.test(line) && !line.startsWith("remap.")));
    assert.equal(h.covers.length, accept ? 2 : 1);
    if (accept) {
      assert.equal(h.mod.canRemap("old-mod"), false);
      assert.equal(h.mod.canRemap("new-mod"), false);
    }
  }
});

test("an unchanged preview says no repair needed and creates no comparison or mod", async () => {
  const h = await harness(); h.build({ unchanged: true });
  await h.mod.remap("old-mod", () => assert.fail("unchanged"));
  assert.deepEqual(h.calls.map(([m]) => m), ["actions.remap"]);
  assert.equal(h.popups[0].lines[0], h.strings.remap.unneeded);
  assert.equal(h.comparisons.length, 0);
});

test("persisted repair markers suppress both original and repaired actions after a fresh check", async () => {
  for (const marker of [{ repaired_from: "original" }, { repaired_id: "repaired" }]) {
    const h = await harness(), r = { ...layoutReport(), ...marker };
    h.use(r); await h.mod.check("stored");
    assert.equal(h.mod.canRemap("stored"), false);
    assert.equal(h.mod.compare(r).remap, false);
    assert.equal(h.mod.eligible(marker), false);
  }
});

test("long missing-region lists keep complete scrollable details in every locale", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness(locale), r = report(), skeleton = structuredClone(fixture.official);
    const names = Array.from({ length: 50 }, (_, i) => `Intro_Shoulder_L/Intro_Shoulder_L_${String(i).padStart(2, "0")}`);
    skeleton.skins[0].attachments.face = Object.fromEntries(names.map((name) => [name, { width: 2, height: 2 }]));
    r.mod = inputs(skeleton);
    await h.mod.show(r, { onRemap: () => assert.fail("dismissed") });
    const popup = h.popups[0], row = popup.lines.find((line) => line.button);
    assert.equal(popup.scroll, true);
    assert.ok(row.text.includes(names[0]) && row.text.includes(names[2]) && row.text.includes("+47"));
    assert.ok(!row.text.includes(names[3]));
    await row.button.fn();
    assert.equal(h.popups[1].scroll, true);
    for (const name of names) assert.ok(h.popups[1].lines[0].includes(name));
  }
});

test("region references belong to their skeleton's atlas even when names repeat elsewhere", async () => {
  const { mod } = await harness(), r = report();
  const other = structuredClone(fixture.official);
  other.skins[0].attachments.face.smile.path = "coat";
  for (const input of [r.mod, r.official]) {
    input.skeletons["other.skel"] = encoded(other);
    input.atlases["other.atlas"] = atlas(1, "coat") + "smile\n bounds: 40,40,2,2\n";
    input.atlases["test.atlas"] += "coat\n bounds: 20,20,2,2\n";
  }
  r.mod.atlases["other.atlas"] = r.mod.atlases["other.atlas"].replace("40,40,2,2", "50,50,2,2");
  assert.deepEqual(mod.compare(r).issues, []);
  r.mod.atlases["other.atlas"] = r.mod.atlases["other.atlas"].replace("coat\n bounds: 1,1,8,8\n", "");
  assert.ok(mod.compare(r).issues.some(({ key, params }) => key === "regions" && params.names === "coat"));
});
