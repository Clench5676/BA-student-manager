import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { setStrings } from "../../src/ba_modding_toolkit/web/js/i18n.js";

globalThis.document = { documentElement: {}, createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 0 }) }) }),
  getElementById: () => null, querySelector: () => null, addEventListener() {} };
globalThis.window = new EventTarget();
globalThis.addEventListener = () => {};
const { kindLabel, entryBase, promptEntries } = await import("../../src/ba_modding_toolkit/web/js/prompts.js");

const flat = (obj, path = "", out = {}) => {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object") flat(value, `${path}${key}.`, out);
    else out[`${path}${key}`] = value;
  }
  return out;
};
setStrings("en-US", flat(JSON.parse(readFileSync(new URL("../../src/ba_modding_toolkit/locales/en-US.json", import.meta.url), "utf8"))));

test("model entries retain their kind in untracked and drift prompts without requesting a Spine preview", () => {
  const model = { kind: "model", core: "hoshino_original", install: "game", state: "untracked" };
  assert.equal(kindLabel(model), "3D Model");
  assert.equal(entryBase(model, { current: "game" }), null);
  assert.deepEqual(promptEntries([model], "untracked").listed, [model]);
  const reset = { ...model, state: "reset" };
  assert.deepEqual(promptEntries([reset], "drift").listed, [reset]);
});
