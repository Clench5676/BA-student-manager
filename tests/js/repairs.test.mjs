// Tests for web/js/repairs.js (the Overwritten message's repair lines), with the en-US strings. Run by
// tests/test_repairs.py with Node's test runner: node --test tests/js/repairs.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "en-US" } };
const flat = (o, p = "", out = {}) => { for (const [k, v] of Object.entries(o)) { if (v && typeof v === "object") flat(v, `${p}${k}.`, out); else out[`${p}${k}`] = v; } return out; };
const strings = flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8")));
const I18n = await import("../../src/ba_modding_toolkit/web/js/i18n.js");
I18n.setStrings("en-US", strings);
const T = I18n.T;
const S = (key) => strings[`webui.${key}`];
const Repairs = await import("../../src/ba_modding_toolkit/web/js/repairs.js");

const STEAM = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\BlueArchive";

test("a Steam install is one inside a Steam library's steamapps/common, whatever the separators", () => {
  assert.equal(Repairs.isSteam(STEAM), true);
  assert.equal(Repairs.isSteam("/Users/me/Library/Application Support/Steam/steamapps/common/BlueArchive/BlueArchive_Data/StreamingAssets/PUB/Resource"), true);
  assert.equal(Repairs.isSteam("D:/SteamLibrary/SteamApps/Common/BlueArchive"), true, "any case");
  assert.equal(Repairs.isSteam("D:/Games/BlueArchive"), false);
  assert.equal(Repairs.isSteam("/x/steamapps/commonplace/BA"), false);
  assert.equal(Repairs.isSteam(null), false);
});

test("the repair lines: Steam's verify for a Steam install, then start this app again; none elsewhere", () => {
  assert.deepEqual(Repairs.repairLines([{ folder: STEAM }], T), [S("mods.repairSteam"), S("mods.repairThen")]);
  assert.deepEqual(Repairs.repairLines([STEAM], T), [S("mods.repairSteam"), S("mods.repairThen")], "a path alone");
  assert.deepEqual(Repairs.repairLines([{ folder: "D:/Games/BlueArchive" }, { folder: STEAM }], T), [S("mods.repairSteam"), S("mods.repairThen")]);
  assert.deepEqual(Repairs.repairLines([{ folder: "D:/Games/BlueArchive" }], T), []);
  assert.deepEqual(Repairs.repairLines([], T), []);
});

test("the Overwritten message: the entries, no official copy left, then the repair lines or the library's line", () => {
  assert.deepEqual(Repairs.overwrittenLines({ names: ["Airi, Portrait"], installs: [{ folder: STEAM }] }, T),
    ["Airi, Portrait", S("mods.overwrittenNone"), S("mods.repairSteam"), S("mods.repairThen")]);
  // no verified route (decision 24): "No official copy left" and "Mods stay in the mod library"
  assert.deepEqual(Repairs.overwrittenLines({ installs: [{ folder: "D:/Games/BlueArchive" }] }, T), [S("mods.overwrittenNone"), S("mods.helpKept")]);
  // lines only: the app starts no repair (decision 9)
  for (const line of Repairs.overwrittenLines({ installs: [{ folder: STEAM }] }, T)) assert.equal(typeof line, "string");
});
