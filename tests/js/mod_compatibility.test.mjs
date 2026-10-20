// Structural comparisons use the bundled Spine reader, synthetic assets and no WebGL or game files.
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
const inputs = (data = fixture.official) => ({ skeletons: { "test.skel": encoded(data) },
  atlases: { "test.atlas": "page.png\nsize: 64,64\nfilter: Linear,Linear\nrepeat: none\n" }, textures: { page: [64, 64] } });
const report = () => ({ official: inputs(), mod: inputs() });
let sequence = 0;
async function harness(locale = "en-US", button = "cancel") {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui;
  const calls = [], popups = [];
  let nextReport = report(), rebuilt = null;
  const comparisons = [];
  globalThis.compatibilityDeps = {
    language: () => locale,
    T: (key, vars = {}) => key.split(".").reduce((o, k) => o?.[k], strings)?.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") || key,
    rpc: async (method, params) => { calls.push([method, params]); return method; },
    waitJob: async (id) => id === "actions.remap" ? rebuilt : nextReport,
    Loading: { task: (fn) => fn(() => {}) },
    Popup: { message: async (options) => { popups.push(options); return { button }; } },
    Compare: { show: async (...args) => comparisons.push(args) },
  };
  const code = `const { T, language, rpc, waitJob, Loading, Popup, Compare } = globalThis.compatibilityDeps;\n${source.replace(/^import .*;$/gm, "")}\n// ${sequence++}`;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return { mod, calls, popups, comparisons, use: (value) => { nextReport = value; }, build: (value) => { rebuilt = value; } };
}

test("the mismatched skeleton names missing animations, slots, attachments and bone counts", async () => {
  const { mod } = await harness();
  const r = report(); r.mod = inputs(fixture.mod);
  const compared = mod.compare(r);
  assert.deepEqual(compared.issues, [
    { key: "animations", params: { name: "test.skel", missing: "Talk_01", added: "—" } },
    { key: "slots", params: { name: "test.skel", missing: "face", added: "body" } },
    { key: "attachments", params: { name: "test.skel", missing: "face/smile", added: "body/coat" } },
    { key: "bones", params: { name: "test.skel", mod: 1, official: 2 } },
  ]);
  assert.equal(compared.author, true);
  assert.equal(compared.update, false);
});

test("real binary skeleton metadata agrees with JSON without loading textures", async () => {
  const { mod } = await harness();
  const binary = readFileSync(new URL("../assets/integrity/synthetic42.skel", import.meta.url));
  const r = report(); r.mod.skeletons["test.skel"] = { version: "4.2.33", data: binary.toString("base64") };
  assert.deepEqual(mod.compare(r).issues, []);
  const parsed = mod.readSkeleton(r.mod.skeletons["test.skel"]);
  assert.equal(parsed.bones.length, 2);
  assert.deepEqual(Array.from(parsed.animations, (a) => a.name), ["Idle_01", "Talk_01"]);
  assert.deepEqual(Array.from(parsed.attachments), ["face/smile"]);
});

test("legacy JSON skins, leading whitespace, extra animations and version differences are checked", async () => {
  const { mod } = await harness();
  const r = report(), data = structuredClone(fixture.official);
  data.skeleton.spine = "3.8.99";
  data.skins = { default: data.skins[0].attachments };
  data.animations.Extra = {};
  r.mod.skeletons["test.skel"] = { version: "3.8.99", data: Buffer.from(`\ufeff \n${JSON.stringify(data)}`).toString("base64") };
  const result = mod.compare(r);
  assert.deepEqual(result.issues.map((i) => i.key), ["version", "animations"]);
  assert.equal(result.issues[1].params.added, "Extra");
  assert.equal(result.update, true);
});

test("atlas pages, declared sizes and current official texture sizes are compared", async () => {
  const { mod } = await harness();
  const r = report();
  r.mod.atlases["test.atlas"] += "\nextra.png\nsize: 16,16\nfilter: Linear,Linear\nrepeat: none\n";
  r.mod.textures.page = [32, 32];
  r.mod.textures.extra = [16, 16];
  const result = mod.compare(r);
  assert.deepEqual(result.issues.map((i) => i.key), ["pages", "atlasSize", "textureSize"]);
  assert.equal(result.issues[0].params.added, "extra.png");
  assert.equal(result.author, true);
});

test("unreadable skeletons, atlases and unavailable originals never report a match", async () => {
  const { mod } = await harness();
  for (const version of ["3.8.99", "4.2.33", null]) {
    const r = report(); r.unavailable = true;
    r.mod.skeletons["test.skel"] = { version, data: Buffer.from("broken").toString("base64") };
    r.mod.atlases["test.atlas"] = "";
    const keys = mod.compare(r).issues.map((i) => i.key);
    assert.ok(keys.includes("unavailable") && keys.includes("unreadable") && keys.includes("atlasUnreadable"));
  }
  const r = report(); delete r.mod.skeletons["test.skel"];
  assert.equal(mod.compare(r).issues[0].key, "skeletons");
});

test("on-demand checks stay read-only until Update is chosen, then compare again", async () => {
  const h = await harness();
  const r = report(); r.outdated = true; h.use(r);
  await h.mod.check("m1", "Example");
  assert.deepEqual(h.calls, [["actions.compatibility", { mod: "m1" }]]);
  assert.equal(h.popups[0].ok, "Update");
  let updates = 0;
  await h.mod.show(r, { onUpdate: () => { updates++; } });
  assert.equal(updates, 0);
  const accepted = await harness("en-US", "ok");
  let changed = 0;
  accepted.use(r);
  await accepted.mod.check("m1", "Example", () => { changed++; accepted.use(report()); });
  assert.deepEqual(accepted.calls.map(([method]) => method), ["actions.compatibility", "actions.update", "actions.compatibility"]);
  assert.equal(changed, 1);
});

test("all five locales show compatibility findings and actions with no unresolved text", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness(locale), r = report();
    r.mod = inputs(fixture.mod); r.outdated = true;
    await h.mod.show(r, { label: "Example", onUpdate() { assert.fail("dismissed"); } });
    const popup = h.popups[0];
    assert.ok(popup.lines.every((line) => !/[{}]/.test(line) && !line.startsWith("compatibility.")));
    assert.ok(popup.lines.includes(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url), "utf8")).webui.compatibility.authorHint));
    assert.notEqual(popup.ok, "act.update");
  }
});

test("changed bones with the same count and mesh UVs with the same names are reported", async () => {
  const { mod } = await harness();
  const r = report(), skeleton = structuredClone(fixture.official);
  skeleton.bones[1].x = 10;
  r.mod = inputs(skeleton);
  assert.ok(mod.compare(r).issues.some(({ key }) => key === "rig"));
  const mesh = { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], vertices: [0, 0, 10, 0, 10, 10], triangles: [0, 1, 2] };
  skeleton.skins[0].attachments.face.smile = mesh;
  r.official = inputs(skeleton);
  for (const mutation of [
    (m) => { m.uvs[0] = 0.25; },
    (m) => { m.vertices[0] = 5; },
    (m) => { m.uvs.push(0, 1); m.vertices.push(0, 10); },
  ]) {
    const changed = structuredClone(skeleton);
    mutation(changed.skins[0].attachments.face.smile);
    r.mod = inputs(changed);
    assert.ok(mod.compare(r).issues.some(({ key }) => key === "geometry"));
    assert.equal(mod.compare(r).author, true);
  }
});

test("atlas layout findings expose Remap and dismissing stays read-only", async () => {
  const h = await harness(), r = report();
  r.atlasLayout = ["test.atlas"]; r.remappable = true;
  h.use(r);
  await h.mod.check("layout-mod", "Example");
  assert.deepEqual(h.calls, [["actions.compatibility", { mod: "layout-mod" }]]);
  assert.equal(h.mod.canRemap("layout-mod"), true);
  assert.equal(h.mod.canRemap("another"), false);
  assert.ok(h.popups[0].lines.includes("test.atlas, atlas layout differs"));
  assert.equal(h.popups[0].ok, "Remap to current version");
  r.remappable = false;
  await h.mod.check("layout-mod");
  assert.equal(h.mod.canRemap("layout-mod"), false);
});

test("Remap creates a new mod, reports a partial fix and opens the source comparison", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness(locale, "ok"), r = report();
    r.atlasLayout = ["test.atlas"]; r.remappable = true; r.outdated = true;
    const built = { mod: { id: "new-mod", label: "Repacked" }, compare: { mod_id: "new-mod", assets: [] },
      report: { partial: true, moved: ["body"], added: ["halo"], dropped: ["old"],
        upscaled: [{ page: "one", w: 4096, h: 4096 }, { page: "two", w: 4096, h: 4096 }],
        warnings: [{ key: "rig", name: "test.skel" }, { key: "version", name: "test.skel" }] } };
    h.use(r); h.build(built);
    let changed;
    await h.mod.check("old-mod", "Painted", () => assert.fail("Update is not used"), (result) => { changed = result; });
    assert.equal(changed, built);
    assert.deepEqual(h.calls.map(([method]) => method), ["actions.compatibility", "actions.remap"]);
    assert.deepEqual(h.comparisons, [[built.compare, "Painted - Repacked", "dialog"]]);
    const popup = h.popups[1];
    assert.ok(popup.lines.every((line) => !/[{}]/.test(line) && !line.startsWith("remap.")));
    assert.ok(popup.lines.some((line) => line.includes("old")));
    assert.equal(popup.lines.filter((line) => line.includes("test.skel")).length, 2);
    assert.equal(popup.lines.filter((line) => line.includes("4096 × 4096")).length, 1);
  }
});

test("long name lists show three names and a count, with complete scrollable details in every locale", async () => {
  for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"]) {
    const h = await harness(locale), r = report();
    const skeleton = structuredClone(fixture.official);
    const names = Array.from({ length: 50 }, (_, i) => `Intro_Shoulder_L/Intro_Shoulder_L_${String(i).padStart(2, "0")}`);
    skeleton.animations = Object.fromEntries(names.map((name) => [name, {}]));
    r.official = inputs(skeleton);
    r.mod = inputs({ ...skeleton, animations: {} });
    r.remappable = true;
    await h.mod.show(r, { onRemap: () => assert.fail("dismissed") });
    const popup = h.popups[0], row = popup.lines.find((line) => line.button);
    assert.equal(popup.scroll, true);
    assert.ok(row.text.includes(names[0]) && row.text.includes(names[2]) && row.text.includes("+47"));
    assert.ok(!row.text.includes(names[3]));
    if (locale === "zh-CN") {
      assert.equal(row.button.label, "\u8be6\u60c5");
      assert.ok(popup.lines.every((line) => !/,(?!\s)/.test(typeof line === "string" ? line : line.text)));
    }
    await row.button.fn();
    assert.equal(h.popups[1].scroll, true);
    for (const name of names) assert.ok(h.popups[1].lines[0].includes(name));
    assert.ok(popup.cancel && popup.ok);
    assert.equal(h.calls.length, 0);
  }
});
