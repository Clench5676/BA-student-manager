// Tests for web/js/i18n.js: the name language of each UI language and what stands in for a missing name. Run by
// tests/test_i18n.py with Node's test runner: node --test tests/js/i18n.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.document = { documentElement: { lang: "" } };
const { L, NAME_LANG, T, language, nameKeys, setStrings } = await import("../../src/ba_modding_toolkit/web/js/i18n.js");

const names = { "zh-CN": "星野", "zh-TW": "星野", en: "Hoshino", ja: "ホシノ", ko: "호시노" };

test("every UI language has its name language", () => {
  assert.deepEqual(NAME_LANG, { "zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja", "ko-KR": "ko", "th-TH": "th" });
  for (const [ui, key] of Object.entries(NAME_LANG)) {
    setStrings(ui, {});
    assert.equal(language(), ui);
    assert.equal(document.documentElement.lang, ui); // the page's lang picks the font stack (app.css :lang)
    assert.equal(L(names), names[key] ?? names.en, ui);
  }
});

test("a missing name falls back to English, Simplified Chinese only for Simplified Chinese", () => {
  const noOwn = (drop) => Object.fromEntries(Object.entries(names).filter(([k]) => k !== drop));
  setStrings("ko-KR", {});
  assert.equal(L(noOwn("ko")), "Hoshino");
  setStrings("zh-TW", {});
  assert.equal(L(noOwn("zh-TW")), "Hoshino"); // never the Simplified name in a Traditional screen
  setStrings("ja-JP", {});
  assert.equal(L(noOwn("ja")), "Hoshino");
  setStrings("zh-CN", {});
  assert.equal(L(noOwn("zh-CN")), "Hoshino");
  assert.equal(L({ ko: "호시노" }), "호시노"); // whatever there is, last
  assert.equal(L("plain"), "plain");
  assert.deepEqual(nameKeys("zh-SG"), ["zh-SG", "zh-CN", "en"]);
  assert.deepEqual(nameKeys("zh-Hant-HK"), ["zh-Hant-HK", "en", "zh-CN"]);
  assert.deepEqual(nameKeys("ko-KR"), ["ko", "en", "zh-CN"]);
});

test("Thai student and variant names use English until Thai source values exist", () => {
  setStrings("th-TH", {});
  assert.deepEqual(nameKeys("th-TH"), ["th", "en", "zh-CN"]);
  assert.equal(L(names), "Hoshino");
  assert.equal(L({ en: "Swimsuit", "zh-CN": "\u6cf3\u88c5" }), "Swimsuit");
  assert.equal(L({ ...names, th: "โฮชิโนะ" }), "โฮชิโนะ");
});

test("strings are looked up with their variables", () => {
  setStrings("ko-KR", { "webui.hello": "{name} 안녕" });
  assert.equal(T("hello", { name: "호시노" }), "호시노 안녕");
  assert.equal(T("missing"), "missing");
});
