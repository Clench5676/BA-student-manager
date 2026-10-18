// Tests for web/js/roster-order.js (the student list's cards and their order), run by tests/test_roster_order.py
// with Node's test runner: node --test tests/js/roster_order.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_VIEW, FILTERS, NATURAL, SORTS, arrange, filtering, fold, neighbour, normalizeView, order,
} from "../../src/ba_modding_toolkit/web/js/roster-order.js";

const v = (key, extra = {}) => ({
  key, fileId: key.toUpperCase(), names: { "zh-CN": { full: key }, en: { full: key } }, spr: `${key}_spr`,
  playable: true, recruitable: true, favorite: false, mods: 0, recent: null, replaced: null, lobby: null, model: null,
  added: null, ...extra,
});
// three families in catalog order: hoshino (three variants), aru, citizen (an NPC without Idle_01)
const data = () => ({
  families: [
    { key: "hoshino", base: { "zh-CN": "\u661f\u91ce", en: "Hoshino", ja: "\u30db\u30b7\u30ce" }, variants: [
      v("hoshino", { names: { "zh-CN": { full: "\u661f\u91ce" }, en: { full: "Hoshino" }, ja: { full: "\u30db\u30b7\u30ce" } }, recent: 2, lobby: "hoshino_home" }),
      v("hoshino_swimsuit", { names: { "zh-CN": { full: "\u661f\u91ce\uff08\u6cf3\u88c5\uff09" }, en: { full: "Hoshino (Swimsuit)" } }, mods: 2, added: "2026-10-01T10:00:00+00:00" }),
      v("np0045", { names: { "zh-CN": { full: "\u661f\u91ce\uff08\u5236\u670d\uff09" } }, playable: false, recruitable: false }),
    ] },
    { key: "aru", base: { "zh-CN": "\u4e9a\u7559", en: "Aru" }, variants: [
      v("aru", { names: { "zh-CN": { full: "\u4e9a\u7559" }, en: { full: "Aru" } }, favorite: true, recent: 0, mods: 1, added: "2026-10-05T10:00:00+00:00", model: "aru_original" }),
    ] },
    { key: "citizen", base: { "zh-CN": "\u8d44\u672c\u673a\u5668\u4eba" }, variants: [
      v("citizen_borot2", { playable: false, recruitable: false, recent: 1, replaced: "variant:x" }),
    ] },
  ],
});
const label = (x) => x?.["zh-CN"] ?? x?.en;
const keys = (list) => list.map((c) => c.key);
const view = (extra = {}) => ({ ...normalizeView(DEFAULT_VIEW), ...extra });

test("the view is normalised like the server does", () => {
  assert.deepEqual(normalizeView(null), { merged: false, mods: "all", recruit: "all", sort: "recent", order: "desc", filters: {} });
  const n = normalizeView({ merged: true, mods: "x", sort: "name", filters: { lobby: ["no", "maybe"], kind: [], bogus: ["yes"] } });
  assert.equal(n.merged, true);
  assert.equal(n.mods, "all");
  assert.equal(n.order, NATURAL.name);
  assert.deepEqual(n.filters, { lobby: ["no"] });
  assert.ok(SORTS.every((k) => k in NATURAL));
  assert.equal(filtering({ lobby: ["yes", "no"] }), false); // every option on: nothing narrowed
  assert.equal(filtering({ lobby: ["yes"] }), true);
  assert.ok(Object.values(FILTERS).every((o) => o.length >= 2));
});

test("cards with mods come first, favourites lead each group, recent views next", () => {
  const { groups } = arrange(data(), view(), { label });
  assert.deepEqual(groups.map((g) => g.id), ["mods", "none"]);
  assert.deepEqual(keys(groups[0].items), ["aru", "hoshino_swimsuit"]);
  // recently viewed first (index 1 before 2), never viewed last in catalog order
  assert.deepEqual(keys(groups[1].items), ["citizen_borot2", "hoshino", "np0045"]);
});

test("the order button flips the sort but not the favourites first", () => {
  const asc = order(data(), view({ order: "asc" }), { label });
  assert.deepEqual(keys(asc), ["aru", "hoshino_swimsuit", "np0045", "hoshino", "citizen_borot2"]);
  const added = order(data(), view({ sort: "added", order: "desc", mods: "mods" }), { label });
  assert.deepEqual(keys(added), ["aru", "hoshino_swimsuit"]);
  const mods = order(data(), view({ sort: "mods", order: "desc", mods: "mods" }), { label });
  assert.deepEqual(keys(mods), ["aru", "hoshino_swimsuit"]); // aru is a favourite
});

test("name sort uses the collator of the UI language", () => {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const en = (x) => x?.en ?? x?.["zh-CN"];
  const list = order(data(), view({ sort: "name", order: "asc", mods: "none" }), { label: en, collator });
  // "citizen_borot2" and "Hoshino" (case does not count), then np0045's name, which has no English one
  assert.deepEqual(keys(list), ["citizen_borot2", "hoshino", "np0045"]);
  assert.deepEqual(keys(order(data(), view({ sort: "name", order: "desc", mods: "none" }), { label: en, collator })),
    ["np0045", "hoshino", "citizen_borot2"]);
});

test("segment and display filters narrow the cards", () => {
  assert.deepEqual(keys(order(data(), view({ recruit: "no" }), { label })), ["citizen_borot2", "np0045"]);
  assert.deepEqual(keys(order(data(), view({ mods: "none", filters: { kind: ["npc"] } }), { label })), ["citizen_borot2", "np0045"]);
  assert.deepEqual(keys(order(data(), view({ filters: { portrait: ["replaced"] } }), { label })), ["citizen_borot2"]);
  assert.deepEqual(keys(order(data(), view({ filters: { lobby: ["yes"] } }), { label })), ["hoshino"]);
  assert.deepEqual(keys(order(data(), view({ filters: { favorite: ["no"], model: ["yes"] } }), { label })), []);
  // both options of a group: no narrowing
  assert.equal(order(data(), view({ filters: { favorite: ["yes", "no"] } }), { label }).length, 5);
});

test("the search folds case, width, kana and separators across name languages and file ids", () => {
  const find = (q, extra = {}) => keys(order(data(), view(extra), { label, query: q }));
  assert.deepEqual(find("HOSHINO"), ["hoshino_swimsuit", "hoshino", "np0045"]); // np0045 by its family's name
  assert.ok(find("\u307b\u3057\u306e").includes("hoshino"));        // hiragana finds the katakana name
  assert.deepEqual(find("\u6cf3\u88c5"), ["hoshino_swimsuit"]);       // part of a variant name
  assert.deepEqual(find("\uff2e\uff30\uff10\uff10\uff14\uff15"), ["np0045"]); // full-width file id
  assert.deepEqual(find("hoshino (swimsuit)"), ["hoshino_swimsuit"]);   // every word must match
  assert.deepEqual(find("zzz"), []);
  assert.equal(fold("\u661f\u91ce\uff08\u6cf3\u88c5\uff09"), "\u661f\u91ce\u6cf3\u88c5");
});

test("the marks inside official names are separators: found when typed without them", () => {
  const d = { families: [
    { key: "shiroko_terror", base: { en: "Shiroko*Terror", ja: "\u30b7\u30ed\u30b3\uff0a\u30c6\u30e9\u30fc", "zh-CN": "\u767d\u5b50*\u6050\u6016" }, variants: [
      v("ch0209", { names: { en: { full: "Shiroko*Terror" }, ja: { full: "\u30b7\u30ed\u30b3\uff0a\u30c6\u30e9\u30fc" } } }),
    ] },
    { key: "golconde", base: { en: "Golconde&Decalcomania", ja: "\u30b4\u30eb\u30b3\u30f3\u30c0\uff06\u30c7\u30ab\u30eb\u30b3\u30de\u30cb\u30fc" }, variants: [
      v("golconde", { names: { en: { full: "Golconde&Decalcomania" } } }),
    ] },
    { key: "president", base: { "zh-CN": "\u8054\u90a6\u5b66\u751f\u4f1a\u957f\uff1f" }, variants: [v("president")] },
  ] };
  const find = (q) => keys(order(d, view(), { label, query: q }));
  assert.deepEqual(find("\u30b7\u30ed\u30b3\u30c6\u30e9\u30fc"), ["ch0209"]); // the IME's katakana, no asterisk
  assert.deepEqual(find("\u3057\u308d\u3053\u3066\u3089\u30fc"), ["ch0209"]); // hiragana
  assert.deepEqual(find("shirokoterror"), ["ch0209"]);
  assert.deepEqual(find("\u767d\u5b50\u6050\u6016"), ["ch0209"]);
  assert.deepEqual(find("Shiroko*Terror"), ["ch0209"]);                       // typed with it still works
  assert.deepEqual(find("\u30b4\u30eb\u30b3\u30f3\u30c0\u30c7\u30ab\u30eb\u30b3\u30de\u30cb\u30fc"), ["golconde"]);
  assert.deepEqual(find("golcondedecalcomania"), ["golconde"]);
  assert.deepEqual(find("\u8054\u90a6\u5b66\u751f\u4f1a\u957f"), ["president"]);
  assert.equal(fold("\u30b7\u30ed\u30b3\uff0a\u30c6\u30e9\u30fc"), "\u30b7\u30ed\u30b3\u30c6\u30e9\u30fc");
});

test("merged, a family is one card shown by its first variant or the first one the search found", () => {
  const all = order(data(), view({ merged: true }), { label });
  assert.deepEqual(all.map((c) => c.family), ["aru", "hoshino", "citizen"]);
  assert.equal(all.find((c) => c.family === "hoshino").key, "hoshino");
  assert.equal(all.find((c) => c.family === "hoshino").mods, 2);
  const swim = order(data(), view({ merged: true }), { label, query: "\u6cf3\u88c5" });
  assert.deepEqual(swim.map((c) => [c.family, c.key]), [["hoshino", "hoshino_swimsuit"]]);
  // family attributes are any of its variants': hoshino has a recruitable variant, citizen has none
  assert.deepEqual(order(data(), view({ merged: true, recruit: "no" }), { label }).map((c) => c.family), ["citizen"]);
});

test("the arrows step through the shown cards in order and wrap", () => {
  const d = data();
  const list = order(d, view({ recruit: "yes" }), { label });
  assert.deepEqual(keys(list), ["aru", "hoshino_swimsuit", "hoshino"]);
  const full = () => order(d, view(), { label, unfiltered: true });
  const at = (variant, family) => ({ variant, family, merged: false });
  assert.equal(neighbour(list, full, at("hoshino_swimsuit", "hoshino"), 1).key, "hoshino");
  assert.equal(neighbour(list, full, at("hoshino", "hoshino"), 1).key, "aru");      // wraps
  assert.equal(neighbour(list, full, at("aru", "aru"), -1).key, "hoshino");        // wraps back
  // a variant the list hides steps from its place in the whole roster: np0045 comes after hoshino there
  assert.equal(neighbour(list, full, at("np0045", "hoshino"), 1).key, "aru");
  assert.equal(neighbour(list, full, at("np0045", "hoshino"), -1).key, "hoshino");
  // the only card: nowhere to go
  assert.equal(neighbour(list.slice(0, 1), full, at("aru", "aru"), 1), null);
  // merged: families
  const merged = order(d, view({ merged: true }), { label });
  assert.equal(neighbour(merged, null, { family: "hoshino", variant: "np0045", merged: true }, 1).family, "citizen");
  assert.equal(neighbour([], full, at("aru", "aru"), 1), null);
});
