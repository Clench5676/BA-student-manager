import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = (name) => readFileSync(new URL(`../../src/ba_modding_toolkit/web/js/${name}.js`, import.meta.url), "utf8");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a cold student pencil waits visibly for the popup frame before using it", async () => {
  const gate = deferred(); let waiting = false, built = false;
  const text = source("detail"), code = text.slice(text.indexOf("async function openAliases("), text.indexOf("  const popup = find(t, \"Popup\");", text.indexOf("async function openAliases(")));
  const env = { customAliases: () => [], variantKey: "student", $: () => ({}), ALIAS_MAX: 8, FRAME_Y: 0,
    AL: { top: 10, pitch: 10, bottom: 10 }, T: String, frameReady: () => gate.promise,
    Loading: { wait: async (p) => { waiting = true; try { return await p; } finally { waiting = false; } } },
    popupFrame: () => { built = true; return {}; } };
  const open = new Function("env", `const { ${Object.keys(env)} } = env; let aliasToken = 0, open = true; ${code}\n} return openAliases;`)(env);
  const done = open(); await flush();
  assert.equal(built, false); assert.equal(waiting, true);
  gate.resolve(); await done; assert.equal(built, true); assert.equal(waiting, false);
});

test("a cold Mod pencil needs only the frame, and shows loading while it arrives", async () => {
  const gate = deferred(); let waiting = false, built = false;
  const text = source("mod-alias"), code = text.slice(text.indexOf("export async function open("), text.indexOf('  const host = $("dialog")')).replace("export ", "");
  const env = { close() {}, frameReady: () => gate.promise, ready: () => new Promise(() => {}),
    Loading: { wait: async (p) => { waiting = true; await p; waiting = false; } } };
  const open = new Function("env", `const { ${Object.keys(env)} } = env; let token = 0; ${code}\nbuilt(); } return open;` .replace("built();", "env.built();"))({ ...env, built: () => { built = true; } });
  const done = open({ mod: {} }); await flush();
  assert.equal(waiting, true); gate.resolve(); await done; assert.equal(built, true);
});
