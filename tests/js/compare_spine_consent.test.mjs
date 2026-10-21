import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/mod-compare.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("function previewPlayer("));
class El {
  children = []; listeners = {};
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; this.textContent = ""; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness(allowed = false) {
  const host = new El(), consentHost = {}, players = [], prompts = [];
  let decision = false, permission = allowed;
  const env = {
    skinPrimary: (button, caption) => { button.textContent = caption; },
    ensureSpine: async () => permission,
    confirmLicence: async (host, options) => { prompts.push([host, options]); permission = decision; return decision; },
    $: () => consentHost, T: (key) => key,
    document: { createElement: () => new El() },
    spine: {
      Downloader: class {}, TextureAtlas: class { pages = []; },
      SpinePlayer: class { constructor() { players.push(this); } dispose() { this.disposed = true; } },
    },
    loadPlayer: (create, config) => { const player = create(config); return { ready: Promise.resolve(player), dispose: () => player.dispose() }; },
  };
  const previewPlayer = new Function("env", `const { ${Object.keys(env).join(", ")} } = env; ${code}; return previewPlayer;`)(env);
  return { host, players, prompts, consentHost, confirm: (value) => { decision = value; },
    start: () => previewPlayer(host, { skeleton: "AA==", atlas: "", json: false }, "original", []) };
}

test("compare previews show a licence action without constructing readers or players", async () => {
  const h = harness(), handle = h.start(); await flush();
  assert.equal(h.host.textContent, "spine.license.required");
  assert.equal(h.host.children[0].textContent, "spine.license.confirm");
  assert.deepEqual(h.players, []);
  await Promise.all([h.host.children[0].listeners.click(), h.host.children[0].listeners.click()]); await flush();
  assert.equal(h.prompts.length, 1, "repeated clicks share one confirmation attempt");
  assert.equal(h.prompts[0][0], h.consentHost);
  assert.deepEqual(h.prompts[0][1], { over: true });
  assert.deepEqual(h.players, []);
  h.confirm(true);
  await h.host.children[0].listeners.click(); await flush();
  assert.equal(h.players.length, 1);
  handle.dispose();
  assert.equal(h.players[0].disposed, true);
});

test("closing compare before its licence gate settles prevents late players", async () => {
  const h = harness(true), handle = h.start();
  handle.dispose(); await flush();
  assert.deepEqual(h.players, []);
  assert.equal(h.host.children.length, 0);
});
