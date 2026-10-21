import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { jobProgress, progressName } from "../../src/ba_modding_toolkit/web/js/job-progress.js";
import { NAME_LANG, setStrings, T } from "../../src/ba_modding_toolkit/web/js/i18n.js";

globalThis.document = { documentElement: {} };
const locales = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"];
const catalog = JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/catalog/data/catalog.json", import.meta.url)));
function catalogVariant(key) {
  const entry = catalog.variants[key], student = catalog.students[entry.student_id];
  return { key, names: entry.names, family: { key: student.base, base: student.names } };
}
const flat = (data, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object") flat(value, `${prefix}${key}.`, out); else out[prefix + key] = value;
  } return out;
};
for (const locale of locales) test(`student job identities use one bracket and omit repeated steps in ${locale}`, () => {
  setStrings(locale, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)))));
  const names = { full: "Yoshimi (Band)", short: "Band" }, variant = { key: "ch0220", names: { en: names }, family: { key: "yoshimi", base: { en: "Yoshimi" } } }, kind = T("tab.lobby");
  const name = progressName(variant, kind);
  assert.equal(name, T("progress.subject", { name: "Yoshimi", parts: ["Band", kind].join(T("progress.comma")) }));
  assert.equal([...name.matchAll(/[（(]/g)].length, 1);
  const base = progressName({ key: "azusa", names: { en: { full: "Azusa", short: "Original" } }, family: { key: "azusa", base: { en: "Azusa" } } }, kind);
  assert.equal(base, T("progress.subject", { name: "Azusa", parts: kind }));
  for (const [base, full, short] of [["Shiroko", "Shiroko*Terror", "Terror"], ["Arona", "Arona - Tasks - Daytime", "Tasks - Daytime"]]) {
    const family = { key: base, base: { en: base } }, v = { key: full, names: { en: { full, short } }, family };
    assert.equal(progressName(v, kind), T("progress.subject", { name: base, parts: [short, kind].join(T("progress.comma")) }));
    family.custom = ["Custom"];
    assert.equal(progressName(v, kind), T("progress.subject", { name: "Custom", parts: [short, kind].join(T("progress.comma")) }));
  }
  const line = jobProgress({ action: "import.phase.add", name, current: 2, total: 3, step: "import.step.add" });
  assert.ok(!line.includes(" - "));
  assert.ok(!jobProgress({ action: "progress.actionExtract", name, step: "import.step.extract" }).includes(" - "));
  assert.ok(line.includes("2 / 3")); assert.ok(line.includes(name));
  assert.ok(jobProgress({ action: "import.phase.update", name, step: "import.step.crc" }).endsWith(T("progress.step", { step: T("import.step.crc") })));
});

for (const locale of locales) {
  for (const key of ["ch9996", "ch9997", "ch9998", "ch9999"]) test(`catalog base ${key} omits Original in ${locale}`, () => {
    setStrings(locale, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)))));
    const variant = catalogVariant(key), family = variant.family, base = family.base[NAME_LANG[locale]];
    assert.equal(variant.key, family.key);
    for (const kind of [T("tab.portrait"), T("tab.lobby"), T("tab.model")]) {
      const expected = T("progress.subject", { name: base, parts: kind });
      assert.equal(progressName({ ...variant, family: { key: family.key, names: family.base } }, kind), expected);
      assert.equal(progressName(variant, kind), expected);
      assert.equal(progressName({ ...variant, family: family.key }, kind, "", family), expected);
      assert.equal(progressName(variant, ""), base);
      family.custom = ["Custom"];
      assert.equal(progressName(variant, kind), T("progress.subject", { name: "Custom", parts: kind }));
      delete family.custom;
    }
  });
  test(`catalog variants retain their labels in ${locale}`, () => {
    setStrings(locale, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)))));
    for (const key of ["ch0220", "ch0263", "np0168", "np0169", "np0170"]) {
      const variant = catalogVariant(key), lang = NAME_LANG[locale], kind = T("tab.lobby");
      assert.notEqual(variant.key, variant.family.key);
      assert.equal(progressName(variant, kind), T("progress.subject", {
        name: variant.family.base[lang], parts: [variant.names[lang].short, kind].join(T("progress.comma")),
      }));
    }
  });
}
