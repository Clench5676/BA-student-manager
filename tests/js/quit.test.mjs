// Tests for web/js/quit.js (the student list's quit: Escape's rule and the prompt's outcome), without a DOM.
// Run by tests/test_quit.py with Node's test runner: node --test tests/js/quit.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONFIRM_KEYS, HOSTS, confirmQuit, quitKey } from "../../src/ba_modding_toolkit/web/js/quit.js";

// the page: the student list shown, every popup host hidden, unless said otherwise
function page({ roster = true, open = [] } = {}) {
  const els = { "screen-roster": { hidden: !roster } };
  for (const id of HOSTS) els[id] = { hidden: !open.includes(id) };
  return (id) => els[id] || null;
}
const esc = (extra = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, keyCode: 27, repeat: false, ...extra });

test("Escape on the student list opens the quit prompt", () => {
  assert.equal(quitKey(esc(), { byId: page() }), true);
});

test("Escape is left alone when another handler took it, an input method composes or the key repeats", () => {
  const byId = page();
  assert.equal(quitKey(esc({ defaultPrevented: true }), { byId }), false, "the search box, the display settings");
  assert.equal(quitKey(esc({ isComposing: true }), { byId }), false);
  assert.equal(quitKey(esc({ keyCode: 229 }), { byId }), false, "WebKit's key that ends a conversion");
  assert.equal(quitKey(esc({ repeat: true }), { byId }), false, "a held key");
  for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) assert.equal(quitKey(esc({ [mod]: true }), { byId }), false, mod);
  assert.equal(quitKey(esc({ key: "Enter" }), { byId }), false);
  assert.equal(quitKey(null, { byId }), false);
});

test("Escape is left alone while any popup host is open, behind the loading screen, or off the student list", () => {
  for (const id of ["consent", "display", "settings", "dialog", "prompt", "popup", "picker"]) {
    assert.equal(quitKey(esc(), { byId: page({ open: [id] }) }), false, id);
  }
  assert.equal(quitKey(esc(), { byId: page(), covering: true }), false, "the loading screen");
  assert.equal(quitKey(esc(), { byId: page({ roster: false }) }), false, "the detail screen or the no-game screen");
  assert.equal(quitKey(esc(), { byId: () => null }), false, "no student list in the page");
});

// the prompt and the quit, with the page's parts as stand-ins
function deps({ button = "ok", refuse = null, native = false } = {}) {
  const log = [];
  return {
    log,
    message: async (opts) => { log.push(["message", opts]); return { button, checked: null }; },
    rpc: async (method) => { log.push(["rpc", method]); if (refuse) { const err = new Error(refuse); err.code = refuse; err.params = {}; throw err; } return null; },
    T: (key) => `<${key}>`,
    notify: (text, opts) => log.push(["notify", text, opts?.kind]),
    native,
    closed: () => log.push(["closed"]),
  };
}

test("the quit prompt: the game's words, Cancel and Confirm, Enter and Space confirm as in the PC client", async () => {
  const d = deps({ button: "cancel" });
  assert.equal(await confirmQuit(d), "cancel");
  const [, opts] = d.log[0];
  assert.equal(opts.title, "<quit.title>");
  assert.deepEqual(opts.lines, ["<quit.ask>"]);
  assert.equal(opts.ok, "<picker.ok>");
  assert.equal(opts.cancel, "<popup.cancel>");
  assert.deepEqual(opts.confirmKeys, ["Enter", " "]);
  assert.deepEqual(CONFIRM_KEYS, ["Enter", " "]);
  assert.equal(d.log.length, 1, "Cancel quits nothing");
  // Escape, the backdrop or the close button: the same
  const closedByEscape = deps({ button: null });
  assert.equal(await confirmQuit(closedByEscape), "cancel");
  assert.equal(closedByEscape.log.length, 1);
});

test("Confirm quits: the window closes itself, browser mode says Closed, a refusal is a notify", async () => {
  const win = deps({ native: true });
  assert.equal(await confirmQuit(win), "quit");
  assert.deepEqual(win.log.slice(1), [["rpc", "app.quit"]], "the window closes; nothing else to show");

  const browser = deps();
  assert.equal(await confirmQuit(browser), "quit");
  assert.deepEqual(browser.log.slice(1), [["rpc", "app.quit"], ["closed"]]);

  const busy = deps({ refuse: "busy", native: true });
  assert.equal(await confirmQuit(busy), "busy");
  assert.deepEqual(busy.log.slice(1), [["rpc", "app.quit"], ["notify", "<error.busy>", "error"]]);

  const serve = deps({ refuse: "native_unavailable" });
  assert.equal(await confirmQuit(serve), "native_unavailable");
  assert.deepEqual(serve.log.at(-1), ["notify", "<error.native_unavailable>", "error"]);
  assert.equal(serve.log.some(([k]) => k === "closed"), false);
});

test("one quit prompt at a time", async () => {
  let release;
  const d = deps();
  d.message = (opts) => { d.log.push(["message", opts]); return new Promise((resolve) => { release = () => resolve({ button: "cancel", checked: null }); }); };
  const first = confirmQuit(d);
  assert.equal(await confirmQuit(d), "cancel", "a second Escape while the prompt is up opens no other");
  assert.equal(d.log.filter(([k]) => k === "message").length, 1);
  release();
  assert.equal(await first, "cancel");
  // and once it is closed, the next one opens
  d.message = async (opts) => { d.log.push(["message", opts]); return { button: "cancel" }; };
  await confirmQuit(d);
  assert.equal(d.log.filter(([k]) => k === "message").length, 2);
});
