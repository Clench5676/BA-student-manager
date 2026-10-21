import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { L, setStrings } from "../../src/ba_modding_toolkit/web/js/i18n.js";
import { studentName } from "../../src/ba_modding_toolkit/web/js/names.js";

globalThis.document = { documentElement: {}, createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 0 }) }) }),
  getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.window = new EventTarget();
globalThis.addEventListener = () => {};
const Prompts = await import("../../src/ba_modding_toolkit/web/js/prompts.js");
const ModAdd = await import("../../src/ba_modding_toolkit/web/js/mod-add.js");
const ModSwitch = await import("../../src/ba_modding_toolkit/web/js/mod-switch.js");
const main = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/main.js", import.meta.url), "utf8");
const code = main.slice(main.indexOf("async function variantNames()"), main.indexOf("// --- library.changed"));
const flatten = (obj, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") flatten(value, `${prefix}${key}.`, out);
    else out[`${prefix}${key}`] = value;
  }
  return out;
};

test("main's shared resolver supplies variant aliases to global prompts, Mod Add and Mod Switch in every locale", async () => {
  const names = Object.fromEntries(["en", "zh-CN", "zh-TW", "ja", "ko", "th"].map((lang) => [lang, { full: `Original ${lang}` }]));
  const variants = [{ key: "base", custom: ["Base alias"], names }, { key: "skin", custom: ["Skin alias"], names },
    { key: "plain", custom: [], names }];
  const data = { families: [{ variants }] };
  for (const lang of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) {
    setStrings(lang, flatten(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${lang}.json`, import.meta.url), "utf8"))));
    for (const cached of [false, true]) {
      const resolver = new Function("roster", "rosterData", "L", "studentName", `${code}; return variantNames;`)(
        cached ? async () => { throw new Error("offline"); } : async () => data, data, L, studentName);
      const nameOf = await resolver();
      for (const [key, expected] of [["base", "Base alias"], ["skin", "Skin alias"], ["plain", L(names).full]]) {
        const entry = { variant: key, core: `${key}_spr`, kind: "spr", state: "untracked" };
        assert.equal(nameOf(entry), expected);
        assert.equal(Prompts.card(entry, { nameOf }).full, expected);
        assert.ok(ModAdd.resultLines([{ target: key, kind: "spr" }], nameOf)[0].text.includes(expected));
        assert.ok(ModSwitch.entryLabel(entry, nameOf).includes(expected));
      }
      assert.equal(nameOf({ names }), L(names).full, "unknown variants retain shipped names");
      assert.equal(nameOf({ core: "unknown_spr" }), "unknown_spr");
    }
  }
});
