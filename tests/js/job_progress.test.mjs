import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { jobProgress, progressName } from "../../src/ba_modding_toolkit/web/js/job-progress.js";
import { setStrings, T } from "../../src/ba_modding_toolkit/web/js/i18n.js";

globalThis.document = { documentElement: {} };
const flat = (data, prefix = "", out = {}) => {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object") flat(value, `${prefix}${key}.`, out); else out[prefix + key] = value;
  } return out;
};
for (const locale of ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "th-TH"]) test(`student job identities use one bracket and omit repeated steps in ${locale}`, () => {
  setStrings(locale, flat(JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url)))));
  const names = { full: "Yoshimi (Band)", short: "Band" }, variant = { names: { en: names }, family: {} }, kind = T("tab.lobby");
  const name = progressName(variant, kind);
  assert.equal(name, T("progress.subject", { name: "Yoshimi", parts: ["Band", kind].join(T("progress.comma")) }));
  assert.equal([...name.matchAll(/[（(]/g)].length, 1);
  const base = progressName({ names: { en: { full: "Azusa", short: "Original" } } }, kind);
  assert.equal(base, T("progress.subject", { name: "Azusa", parts: kind }));
  const line = jobProgress({ action: "import.phase.add", name, current: 2, total: 3, step: "import.step.add" });
  assert.ok(!line.includes(" - "));
  assert.ok(!jobProgress({ action: "progress.actionExtract", name, step: "import.step.extract" }).includes(" - "));
  assert.ok(line.includes("2 / 3")); assert.ok(line.includes(name));
  assert.ok(jobProgress({ action: "import.phase.update", name, step: "import.step.crc" }).endsWith(T("progress.step", { step: T("import.step.crc") })));
});
