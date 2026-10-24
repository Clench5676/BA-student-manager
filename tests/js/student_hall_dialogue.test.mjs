import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { spriteBorders, sliceAxis, slicePoint } from "../../src/ba_modding_toolkit/web/js/sprite-slices.js";

class Element {
  constructor() { this.style = {}; this.children = []; this.attrs = {}; }
  setAttribute(key, value) { this.attrs[key] = value; }
  replaceChildren(...children) { this.children.forEach((child) => { child.parent = null; }); this.children = children; children.forEach((child) => { child.parent = this; }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
}
globalThis.document = { createElement: () => new Element() };
let timers = new Map(), timerDelays = new Map(), nextTimer = 0, revoked = [];
const fireTimer = (delay) => {
  const id = [...timers.keys()].find((key) => timerDelays.get(key) === delay);
  assert.ok(id, `Expected ${delay} ms timer`);
  const callback = timers.get(id); timers.delete(id); timerDelays.delete(id); callback();
};
const pendingTimers = () => [...timers.keys()].filter((id) => timerDelays.get(id) !== 25000);
globalThis.hallDialogueHarness = {
  spriteBorders, sliceAxis, slicePoint, NGUI: {}, defaultRpc: () => {}, language: () => "zh-TW", S: 1920 / 2960, talkExpression: () => {},
  setTimeout: (callback, delay) => { timers.set(++nextTimer, callback); timerDelays.set(nextTimer, delay); return nextTimer; },
  clearTimeout: (id) => { timers.delete(id); timerDelays.delete(id); },
  URL: { createObjectURL: () => `blob:voice-${nextTimer}`, revokeObjectURL: (url) => revoked.push(url) },
};
let source = await readFile(new URL("../../src/ba_modding_toolkit/web/js/student-hall-dialogue.js", import.meta.url), "utf8");
source = source.replace(/^import .*;$/gm, "");
source = `const {NGUI, defaultRpc, language, S, talkExpression, setTimeout, clearTimeout, URL, spriteBorders, sliceAxis, slicePoint} = globalThis.hallDialogueHarness;\n${source}`;
const { createDialogue, memoryMemo, prepareBalloon, balloonPosition, balloonBody, wrapDialogue } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const template = () => ({ name: "Talk", pos: [0, 0], scale: [1, 1], widgets: [], children: [
  { name: "Sprite", pos: [0, 0], widgets: [{ cls: "UISprite", sprite: "Lobby_balloon", atlas: "Common", type: 1,
    flip: 0, w_: 228, h_: 201, pivot: 0, depth: 7, color: "#ffffff/1.00" }], children: [] },
  { name: "Label", pos: [79, -45], widgets: [{ cls: "UILabel", text: "text\ntext", fontSize: 52, w_: 90, h_: 112,
    pivot: 0, depth: 22, color: "#3e444a/1.00", align: 1, spacingX: -2 }], children: [] },
] });
const find = (tree, path) => path.split("/").reduce((node, key) => node.children.find((child) => child.name === key), tree);
const entry = (id = "one", variant = "hoshino") => ({ id, variant, x: 600, y: 1120, scale: 1 });
function fixture(extra = {}) {
  timers = new Map(); timerDelays = new Map(); revoked = [];
  const host = new Element(), calls = [], players = [], talking = [], rendered = [], errors = [], diagnostics = [];
  const settings = { voiceVolume: 35, voiceMuted: false }, signal = new AbortController();
  const ui = { find, init: async () => {}, glyphWidth: (text, size) => [...text].length * size,
    render: async (tree, target, opts) => { rendered.push({ tree, target, opts }); if (extra.render) await extra.render(); } };
  const call = async (method, params = {}, options = {}) => {
    calls.push({ method, params, signal: options.signal });
    if (extra.call) { const result = extra.call(method, params, options); if (result !== undefined) return result; }
    if (method === "hall.dialogueLayout") return template();
    if (method === "hall.lines") return { lines: { hoshino_lobby_1: { "zh-TW": "\u6700\u8fd1\u5728\u70ba\u4e86\u63d0\u5347\u7bc0\u594f\u800c\u7df4\u7fd2\u3002", voice: true } } };
    if (method === "hall.voice") return { audio: btoa("original audio"), mime: "audio/ogg" };
    assert.fail(method);
  };
  const controller = createDialogue({ host, ui, call, signal: signal.signal, prefs: () => settings,
    actorOf: (value) => ({ actor: value.id, rect: { x: value.x - 150, y: 120, width: 300, height: 800 } }),
    expressions: (actor, on, expression) => talking.push([actor, on, expression]), onError: (error) => errors.push(error),
    onDiagnostic: (error) => diagnostics.push(error),
    audioFactory: (url) => {
      const player = { url, volume: 0, played: 0, paused: 0, pause() { this.paused++; },
        async play() { this.played++; if (extra.play) return extra.play(); } };
      players.push(player); return player;
    }, currentLanguage: () => extra.language?.() || "zh-TW" });
  return { controller, host, calls, players, talking, rendered, errors, diagnostics, settings, signal };
}

test("actual Lobby balloon keeps native font, sliced sprite and spacing while wrapping all text", () => {
  const ui = { find, glyphWidth: (text, size) => [...text].length * size };
  const saved = template(), text = "\u6700\u8fd1\u5728\u70ba\u4e86\u63d0\u5347\u7bc0\u594f\u800c\u7df4\u7fd2\u3002";
  const result = prepareBalloon(saved, text, { x: 500, y: 100, width: 300, height: 800 }, { ui, lang: "zh-TW" });
  const label = find(result.tree, "Label").widgets[0], sprite = find(result.tree, "Sprite").widgets[0];
  assert.equal(sprite.sprite, "Lobby_balloon"); assert.equal(sprite.atlas, "Common"); assert.equal(sprite.type, 1);
  assert.equal(label.fontSize, 52); assert.equal(label.color, "#3e444a/1.00"); assert.equal(label.spacingX, -2);
  assert.equal(label.text.replaceAll("\n", ""), text); assert.equal(label.text.split("\n").length, 2);
  const body = balloonBody(sprite), pos = find(result.tree, "Label").pos;
  assert.equal(label.pivot, 4); assert.equal(label.align, 2);
  assert.equal(pos[0], (body.left + body.right) / 2);
  assert.equal(-pos[1], (body.top + body.bottom) / 2);
  assert.ok(-pos[1] < sprite.h_ / 2, "The body excludes the larger bottom shadow");
  assert.deepEqual(saved, template());
});

test("edge placement flips the native tail and keeps full balloon on stage", () => {
  const position = balloonPosition({ x: 1650, y: 900, width: 200, height: 700 }, { width: 500, height: 250 });
  assert.equal(position.flip, true); assert.ok(position.x >= 24 && position.x + 500 <= 1896);
  assert.ok(position.y >= 36 && position.y + 250 <= 1044);
  const lines = wrapDialogue("AReallyLongUnbrokenWordAndMoreLetters", 52, 200, (text, fs) => text.length * fs);
  assert.equal(lines.join(""), "AReallyLongUnbrokenWordAndMoreLetters");
});

test("repeated clicks are ignored during audio and the next finished turn reuses the memory cache", async () => {
  const h = fixture();
  await h.controller.play(entry()); assert.equal(h.players[0].volume, .35); assert.equal(h.host.children.length, 1);
  await h.controller.play(entry());
  assert.equal(h.players.length, 1); assert.equal(h.players[0].paused, 0); assert.equal(h.rendered.length, 1);
  h.players[0].onended(); await h.controller.play(entry());
  assert.equal(h.players[1].played, 1);
  assert.equal(h.calls.filter((call) => call.method === "hall.lines").length, 1);
  assert.equal(h.calls.filter((call) => call.method === "hall.voice").length, 1);
  assert.equal(h.calls.filter((call) => call.method === "hall.dialogueLayout").length, 1);
  assert.equal(h.rendered[0].tree.children[1].widgets[0].text, h.rendered[1].tree.children[1].widgets[0].text);
  h.controller.dispose(); assert.equal(h.host.children.length, 0); assert.ok(revoked.length >= 2);
});

test("duplicate actors keep independent dialogue turns", async () => {
  const h = fixture({ call: (method) => method === "hall.lines" ? { lines: {
    hoshino_lobby_1: { ja: "First", voice: false }, hoshino_lobby_2: { ja: "Second", voice: false },
  } } : undefined });
  await h.controller.play(entry("one")); fireTimer(5000);
  await h.controller.play(entry("one")); fireTimer(5000); await h.controller.play(entry("two"));
  assert.deepEqual(h.rendered.map(({ tree }) => find(tree, "Label").widgets[0].text), ["First", "Second", "First"]);
  h.controller.dispose();
});

test("the first pending text request owns the turn and ignored clicks never fetch or advance", async () => {
  const first = deferred();
  const h = fixture({ call: (method, params) => method === "hall.lines" && params.variant === "old" ? first.promise : undefined });
  const old = h.controller.play(entry("old", "old")); await flush();
  const signal = h.calls[0].signal;
  await h.controller.play(entry("new")); assert.equal(signal.aborted, false);
  assert.equal(h.calls.length, 1);
  first.resolve({ lines: { old_lobby_1: { ja: "First", voice: true }, old_lobby_2: { ja: "Second", voice: true } } }); await old;
  assert.equal(h.players.length, 1); assert.equal(h.host.children[0].attrs["aria-label"], "First");
  await h.controller.play(entry("old", "old")); assert.equal(h.players.length, 1);
  h.players[0].onended(); await h.controller.play(entry("old", "old"));
  assert.equal(h.host.children[0].attrs["aria-label"], "Second"); h.controller.dispose();
});

test("page exit aborts pending voice fetch and cannot start late audio", async () => {
  const voice = deferred(); const h = fixture({ call: (method) => method === "hall.voice" ? voice.promise : undefined });
  const pending = h.controller.play(entry()); await flush();
  const request = h.calls.find((call) => call.method === "hall.voice"); assert.ok(request);
  h.signal.abort(); assert.equal(request.signal.aborted, true);
  voice.resolve({ audio: btoa("late"), mime: "audio/ogg" }); await pending;
  assert.equal(h.players.length, 0); assert.equal(h.host.children.length, 0);
});

test("a late audio play promise cannot restart the old actor expression", async () => {
  const playing = deferred(); const h = fixture({ play: () => playing.promise });
  const pending = h.controller.play(entry()); await flush(); await flush();
  assert.equal(h.players.length, 1); h.controller.stop();
  playing.resolve(); await pending;
  assert.equal(h.talking.some(([, on]) => on), false);
  assert.ok(h.players[0].paused); assert.equal(h.host.children.length, 0); h.controller.dispose();
});

test("cancelled staged rendering cannot append an old balloon", async () => {
  const drawing = deferred(); const h = fixture({ render: () => drawing.promise });
  const pending = h.controller.play(entry()); await flush(); h.controller.stop(); drawing.resolve(); await pending;
  assert.equal(h.host.children.length, 0); assert.equal(h.players.length, 0); h.controller.dispose();
});

test("voice failure keeps readable text and ends its expression without an error popup", async () => {
  const h = fixture({ call: (method) => method === "hall.voice" ? Promise.reject(new Error("offline")) : undefined });
  await h.controller.play(entry()); assert.equal(h.host.children.length, 1); assert.equal(h.errors.length, 0);
  assert.equal(h.talking.at(-1)[1], false); assert.equal(pendingTimers().length, 1);
  fireTimer(Math.min(...[...timers.keys()].map((id) => timerDelays.get(id)))); assert.equal(h.host.children.length, 0); h.controller.dispose();
});

test("mute blocks audio and muting an active stream leaves a bounded text-only lifetime", async () => {
  const h = fixture(); h.settings.voiceMuted = true;
  await h.controller.play(entry()); assert.equal(h.players.length, 0);
  assert.equal(h.calls.some((call) => call.method === "hall.voice"), false);
  h.settings.voiceMuted = false; fireTimer(5000); await h.controller.play(entry());
  h.settings.voiceMuted = true; h.controller.preferencesChanged();
  assert.ok(h.players[0].paused); assert.equal(pendingTimers().length, 1); assert.equal(h.host.children.length, 1);
  fireTimer(Math.min(...[...timers.keys()].map((id) => timerDelays.get(id)))); assert.equal(h.host.children.length, 0); h.controller.dispose();
});

test("failed balloon metadata is retried on the next click", async () => {
  let reads = 0;
  const h = fixture({ call: (method) => method === "hall.dialogueLayout" && ++reads === 1 ? Promise.reject(new Error("temporary")) : undefined });
  await h.controller.play(entry()); assert.equal(h.errors.length, 1);
  await h.controller.play(entry()); assert.equal(h.host.children.length, 1); assert.equal(reads, 2); h.controller.dispose();
});

test("memory cache coalesces in-flight requests and enforces byte and entry budgets", async () => {
  const memo = memoryMemo(10, 2), read = deferred(); let count = 0;
  const one = memo.get("one", () => { count++; return read.promise; }, (value) => value.length);
  const two = memo.get("one", () => { count++; return read.promise; }, (value) => value.length);
  read.resolve("1234"); assert.equal(await one, "1234"); assert.equal(await two, "1234"); assert.equal(count, 1);
  await memo.get("two", () => "1234", (value) => value.length); await memo.get("three", () => "1234", (value) => value.length);
  assert.equal(memo.size(), 8);
  await memo.get("one", () => { count++; return "1234"; }, (value) => value.length); assert.equal(count, 2);
  memo.clear(); assert.equal(memo.size(), 0);
});

test("an aborted same-key flight cannot poison its replacement cache entry", async () => {
  const memo = memoryMemo(), old = deferred(), first = new AbortController(), second = new AbortController();
  const pending = memo.get("student", () => old.promise, undefined, first.signal); await flush(); first.abort();
  assert.equal(await memo.get("student", () => "new", undefined, second.signal), "new");
  old.resolve("old"); await pending;
  assert.equal(await memo.get("student", () => assert.fail("Cached replacement should be reused")), "new");
  memo.clear();
});

test("a pending first click retries automatically and eventually displays and plays its first clip", async () => {
  let reads = 0;
  const h = fixture({ call: (method) => method === "hall.lines" ? ++reads === 1 ? { lines: {}, pending: true } : {
    lines: { hoshino_lobby_1: { ja: "First", voice: true }, hoshino_lobby_2: { ja: "Second", voice: true } }, pending: false,
  } : undefined });
  const pending = h.controller.play(entry()); await flush();
  assert.equal(h.host.children.length, 0); assert.equal(pendingTimers().length, 1);
  fireTimer(Math.min(...[...timers.keys()].map((id) => timerDelays.get(id)))); await pending;
  assert.equal(reads, 2); assert.equal(h.host.children[0].attrs["aria-label"], "First"); assert.equal(h.players.length, 1);
  const requests = h.calls.filter((call) => call.method === "hall.lines");
  assert.equal(requests[0].signal, requests[1].signal);
  h.players[0].onended(); await h.controller.play(entry());
  assert.equal(h.host.children[0].attrs["aria-label"], "Second");
  assert.deepEqual(h.calls.filter((call) => call.method === "hall.voice").map((call) => call.params.clip), ["hoshino_lobby_1", "hoshino_lobby_2"]);
  h.controller.dispose();
});

test("pending voice metadata preserves immediate text and attaches voice to the same clip without another turn", async () => {
  let reads = 0;
  const h = fixture({ call: (method) => method === "hall.lines" ? { lines: {
    hoshino_lobby_1: { ja: "First", voice: ++reads > 1 }, hoshino_lobby_2: { ja: "Second", voice: reads > 1 },
  }, pending: reads === 1 } : undefined });
  const pending = h.controller.play(entry()); await flush(); await flush();
  assert.equal(h.host.children[0].attrs["aria-label"], "First"); assert.equal(h.players.length, 0);
  assert.equal(pendingTimers().length, 1); fireTimer(Math.min(...[...timers.keys()].map((id) => timerDelays.get(id)))); await pending;
  assert.equal(h.players.length, 1); assert.equal(h.rendered.length, 1, "Voice-only metadata changes keep the displayed native balloon");
  assert.equal(h.calls.find((call) => call.method === "hall.voice").params.clip, "hoshino_lobby_1");
  h.players[0].onended(); await h.controller.play(entry()); assert.equal(h.host.children[0].attrs["aria-label"], "Second"); h.controller.dispose();
});

test("cancelling a pending metadata retry clears its delay and issues no follow-up request", async () => {
  const h = fixture({ call: (method) => method === "hall.lines" ? { lines: {}, pending: true } : undefined });
  const pending = h.controller.play(entry()); await flush(); assert.equal(pendingTimers().length, 1);
  const request = h.calls[0]; h.controller.stop(); await pending;
  assert.equal(request.signal.aborted, true); assert.equal(timers.size, 0);
  assert.equal(h.calls.filter((call) => call.method === "hall.lines").length, 1);
  assert.equal(h.host.children.length, 0); assert.equal(h.players.length, 0); h.controller.dispose();
});

test("pending retries are bounded and a later metadata failure keeps the existing text", async () => {
  let reads = 0;
  const h = fixture({ call: (method) => method === "hall.lines" ? ++reads === 1
    ? { lines: { hoshino_lobby_1: { ja: "Readable", voice: false } }, pending: true }
    : Promise.reject(new Error("metadata unavailable")) : undefined });
  const pending = h.controller.play(entry()); await flush(); await flush();
  fireTimer(Math.min(...[...timers.keys()].map((id) => timerDelays.get(id)))); await pending;
  assert.equal(h.host.children[0].attrs["aria-label"], "Readable"); assert.equal(h.errors.length, 0); h.controller.dispose();
  const forever = fixture({ call: (method) => method === "hall.lines" ? { lines: {}, pending: true } : undefined });
  const waiting = forever.controller.play(entry());
  for (let i = 0; i < 4; i++) { await flush(); assert.equal(pendingTimers().length, 1); fireTimer(Math.min(...[...timers.keys()].map((id) => timerDelays.get(id)))); }
  await waiting;
  assert.equal(forever.calls.filter((call) => call.method === "hall.lines").length, 5);
  assert.equal(timers.size, 0); assert.equal(forever.errors.length, 0); forever.controller.dispose();
});

test("a pending voice download blocks all portraits without interrupting the current balloon", async () => {
  const voice = deferred();
  const h = fixture({ call: (method) => method === "hall.voice" ? voice.promise : undefined });
  const playing = h.controller.play(entry()); await flush();
  const firstBubble = h.host.children[0], request = h.calls.find(({ method }) => method === "hall.voice");
  await h.controller.play(entry("two", "other"));
  assert.equal(request.signal.aborted, false); assert.equal(h.host.children[0], firstBubble);
  assert.equal(h.calls.filter(({ method }) => method === "hall.lines").length, 1);
  voice.resolve({ audio: btoa("voice"), mime: "audio/ogg" }); await playing;
  await h.controller.play(entry("two", "other")); assert.equal(h.players.length, 1);
  assert.equal(h.players[0].paused, 0); assert.equal(timers.size, 0, "Started audio owns its entire natural duration");
  h.players[0].onended(); await h.controller.play(entry("two", "other"));
  assert.equal(h.players.length, 2); assert.equal(h.calls.at(-1).params.variant, "other"); h.controller.dispose();
});

test("autoplay rejection keeps one bounded caption and then accepts another portrait", async () => {
  const h = fixture({ play: () => Promise.reject(new Error("NotAllowedError")) });
  await h.controller.play(entry());
  assert.equal(h.players[0].paused, 1); assert.equal(h.host.children.length, 1); assert.equal(h.errors.length, 0);
  await h.controller.play(entry("two")); assert.equal(h.players.length, 1); assert.equal(h.rendered.length, 1);
  fireTimer(5000); await h.controller.play(entry("two"));
  assert.equal(h.players.length, 2); assert.equal(h.rendered.length, 2); h.controller.dispose();
});

test("an audio error cannot allow a second bubble until its text fallback expires", async () => {
  const h = fixture(); await h.controller.play(entry());
  const failed = h.players[0].onerror, ended = h.players[0].onended;
  failed(); assert.equal(h.host.children.length, 1); assert.equal(h.players[0].paused, 1);
  await h.controller.play(entry("two")); assert.equal(h.players.length, 1);
  ended(); assert.equal(h.host.children.length, 1, "A queued old end event cannot clear the fallback");
  fireTimer(5000); await h.controller.play(entry("two"));
  failed(); assert.equal(h.players[1].paused, 0, "A queued old error cannot cancel the next speaker"); h.controller.dispose();
});

test("stalled setup expires with no caption and a late completion cannot steal the next turn", async () => {
  const stalled = deferred();
  const h = fixture({ call: (method, params) => method === "hall.lines" && params.variant === "stalled" ? stalled.promise : undefined });
  const pending = h.controller.play(entry("one", "stalled")); await flush();
  fireTimer(25000); assert.equal(h.errors.length, 0); assert.equal(h.diagnostics[0].code, "lines_unavailable"); assert.equal(h.calls[0].signal.aborted, true);
  await h.controller.play(entry("two"));
  stalled.resolve({ lines: { stalled_lobby_1: { ja: "Late", voice: true } } }); await pending;
  assert.equal(h.players.length, 1); assert.equal(h.rendered.length, 1); h.controller.dispose();
});

test("stalled voice or autoplay setup preserves the obtained caption for exactly one fallback period", async () => {
  for (const stage of ["voice", "play"]) {
    const stalled = deferred();
    const h = fixture(stage === "voice" ? { call: (method) => method === "hall.voice" ? stalled.promise : undefined }
      : { play: () => stalled.promise });
    const pending = h.controller.play(entry()); await flush();
    fireTimer(25000); assert.equal(h.host.children.length, 1); assert.equal(h.errors.length, 0);
    await h.controller.play(entry("two")); assert.equal(h.rendered.length, 1);
    fireTimer(5000); assert.equal(h.host.children.length, 0);
    stalled.resolve({ audio: btoa("late"), mime: "audio/ogg" }); await pending;
    assert.equal(h.talking.some(([, on]) => on), false); assert.equal(h.host.children.length, 0);
    h.controller.dispose();
  }
});

test("zero volume during voice download cancels late sound and retains one bounded readable caption", async () => {
  const voice = deferred();
  const h = fixture({ call: (method) => method === "hall.voice" ? voice.promise : undefined });
  const pending = h.controller.play(entry()); await flush();
  h.settings.voiceVolume = 0; h.controller.preferencesChanged();
  await h.controller.play(entry("two")); assert.equal(h.rendered.length, 1);
  voice.resolve({ audio: btoa("late"), mime: "audio/ogg" }); await pending;
  assert.equal(h.players.length, 0); assert.equal(h.host.children.length, 1);
  fireTimer(5000); h.settings.voiceVolume = 50; await h.controller.play(entry("two"));
  assert.equal(h.players[0].volume, .5); h.controller.dispose();
});

test("native body geometry mirrors around the tail while all line boxes remain vertically centred", () => {
  const ui = { find, glyphWidth: (text, size) => [...text].length * size, fontSizeFor: (_, size) => size };
  for (const text of ["One", "First\nSecond", "First\nSecond\nThird\nFourth"]) {
    const normal = prepareBalloon(template(), text, { x: 500, y: 100, width: 100, height: 800 }, { ui });
    const flipped = prepareBalloon(template(), text, { x: 1650, y: 100, width: 200, height: 800 }, { ui });
    const sprite = find(normal.tree, "Sprite").widgets[0], a = find(normal.tree, "Label"), b = find(flipped.tree, "Label");
    const body = balloonBody(sprite);
    assert.equal(flipped.flip, true); assert.equal(a.pos[1], b.pos[1]);
    assert.ok(Math.abs(a.pos[0] + b.pos[0] - sprite.w_) < 1e-6);
    assert.equal(-a.pos[1], (body.top + body.bottom) / 2);
    assert.ok(-a.pos[1] - a.widgets[0].h_ / 2 > body.top);
    assert.ok(-a.pos[1] + a.widgets[0].h_ / 2 < body.bottom);
    assert.equal(a.widgets[0].text, text);
  }
});

test("disposing a text-only fallback also aborts its in-flight translation request", async () => {
  let language = "zh-TW"; const translation = deferred();
  const h = fixture({ language: () => language, call: (method, params) => method === "hall.lines"
    ? params.lang === "en" ? translation.promise : { lines: { hoshino_lobby_1: { ja: "Original", voice: false } } }
    : undefined });
  await h.controller.play(entry()); language = "en-US";
  const relabel = h.controller.relabel(); await flush();
  const request = h.calls.at(-1); assert.equal(request.params.lang, "en"); assert.equal(request.signal.aborted, false);
  h.controller.dispose(); assert.equal(request.signal.aborted, true);
  translation.resolve({ lines: { hoshino_lobby_1: { en: "Late translation", voice: false } } }); await relabel;
  assert.equal(h.host.children.length, 0); assert.equal(timers.size, 0);
});

test("ordinary dialogue absence and missing catalog mappings are silent, throttled and release the global turn", async () => {
  for (const response of [{ lines: {}, unavailable: true }, { lines: { missing_lobby_1: { voice: false } } },
    Object.assign(new Error("missing"), { code: "lines_unavailable" }),
    Object.assign(new Error("missing"), { code: "catalog_variant_not_found" })]) {
    const h = fixture({ call: (method, params) => method === "hall.lines" && params.variant === "missing"
      ? response instanceof Error ? Promise.reject(response) : response : undefined });
    await h.controller.play(entry("one", "missing"));
    await h.controller.play(entry("one", "missing"));
    assert.equal(h.calls.length, 1); assert.equal(h.errors.length, 0); assert.equal(h.host.children.length, 0);
    assert.equal(timers.size, 0); await h.controller.play(entry("two")); assert.equal(h.players.length, 1);
    h.controller.dispose();
  }
});

test("unexpected dialogue failures retain their diagnostic error path", async () => {
  const fault = new TypeError("broken metadata adapter");
  const h = fixture({ call: (method) => method === "hall.lines" ? Promise.reject(fault) : undefined });
  await h.controller.play(entry()); assert.equal(h.errors[0], fault); assert.equal(timers.size, 0); h.controller.dispose();
});

test("late exact expression metadata enriches the active voice without another bubble or dialogue turn", async () => {
  let reads = 0;
  const h = fixture({ language: () => "zh-CN", call: (method) => method === "hall.lines" ? {
    lines: { hoshino_lobby_1: { "zh-CN": "Original caption", voice: true, ...(++reads > 1 ? {
      expression: "02", expressionCues: [{ time: 0, expression: "02" }, { time: 2.5, expression: "14" }],
    } : {}) }, hoshino_lobby_2: { "zh-CN": "Second", voice: true, expression: "10" } },
    pending: reads === 1, animationPending: reads === 1,
  } : undefined });
  await h.controller.play(entry()); const player = h.players[0], bubble = h.host.children[0];
  assert.equal(player.played, 1); assert.equal(h.talking.some(([, on]) => on), false);
  player.currentTime = 3; fireTimer(500); await flush();
  assert.deepEqual(h.talking.at(-1), ["one", true, "14"]);
  assert.equal(h.host.children[0], bubble); assert.equal(h.rendered.length, 1); assert.equal(player.played, 1);
  await h.controller.play(entry("two")); assert.equal(h.players.length, 1); assert.equal(timers.size, 0);
  player.onended(); await h.controller.play(entry());
  assert.equal(h.host.children[0].attrs["aria-label"], "Second"); h.controller.dispose();
});

test("authored expression cues follow audio time, and late metadata cannot touch a finished voice", async () => {
  const h = fixture({ call: (method) => method === "hall.lines" ? { lines: { hoshino_lobby_1: {
    ja: "Caption", voice: true, expression: "02", expressionCues: [{ time: 0, expression: "02" }, { time: 2.5, expression: "04" }],
  } } } : undefined });
  await h.controller.play(entry()); const player = h.players[0];
  assert.deepEqual(h.talking.at(-1), ["one", true, "02"]);
  player.currentTime = 2.4; player.ontimeupdate(); assert.equal(h.talking.length, 1);
  player.currentTime = 2.5; player.ontimeupdate(); assert.deepEqual(h.talking.at(-1), ["one", true, "04"]);
  player.currentTime = 1; player.onseeked(); assert.deepEqual(h.talking.at(-1), ["one", true, "02"]);
  player.onended(); assert.equal(h.talking.at(-1)[1], false); assert.equal(player.ontimeupdate, null); h.controller.dispose();
  const late = deferred(); let reads = 0;
  const stopped = fixture({ call: (method) => method === "hall.lines" ? ++reads === 1 ? {
    lines: { hoshino_lobby_1: { ja: "Caption", voice: true } }, pending: true, animationPending: true,
  } : late.promise : undefined });
  await stopped.controller.play(entry()); fireTimer(500); await flush(); stopped.players[0].onended();
  late.resolve({ lines: { hoshino_lobby_1: { ja: "Late", voice: true, expression: "14" } }, animationPending: false }); await flush();
  assert.equal(stopped.talking.some(([, on]) => on), false); assert.equal(stopped.host.children.length, 0); stopped.controller.dispose();
});
