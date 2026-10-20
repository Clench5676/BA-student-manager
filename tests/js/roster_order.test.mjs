// Tests for web/js/roster-order.js (the student list's cards and their order), run by tests/test_roster_order.py
// with Node's test runner: node --test tests/js/roster_order.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_VIEW, FILTERS, NATURAL, RECENT_MAX, SORTS, arrange, filtering, fold, neighbour, normalizeView, order, visit,
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

test("roster cards keep unseen mod marks per variant and across a merged family until all are seen", () => {
  const d = data(), variants = d.families[0].variants;
  variants[0].fresh = true; variants[1].fresh = true;
  const marks = (merged) => order(d, view({ merged }), { label }).filter((c) => c.family === "hoshino").map((c) => !!c.fresh);
  assert.deepEqual(marks(false), [true, true, false]);
  assert.deepEqual(marks(true), [true]);
  variants[0].fresh = false;
  assert.deepEqual(marks(true), [true]);
  variants[1].fresh = false;
  assert.deepEqual(marks(false), [false, false, false]);
  assert.deepEqual(marks(true), [false]);
});

test("separate library counts sum across a family and the matched variant keeps its configured preview", () => {
  const d = { families: [{ key: "f", base: { en: "Family" }, variants: [
    v("a", { mods: 3, modCounts: { spr: 3, lobby: 0 }, configured: { spr: "mod:a" } }),
    v("b", { mods: 1, modCounts: { spr: 0, lobby: 1 }, configured: { spr: "mod:b" } }),
  ] }] };
  const separate = order(d, view(), { label });
  assert.deepEqual(separate.map((c) => c.modCounts), [{ spr: 3, lobby: 0 }, { spr: 0, lobby: 1 }]);
  const merged = order(d, view({ merged: true }), { label, query: "b" })[0];
  assert.equal(merged.key, "b");
  assert.equal(merged.mods, 4);
  assert.deepEqual(merged.modCounts, { spr: 3, lobby: 1 });
  assert.deepEqual(merged.configured, { spr: "mod:b" });
});

test("special backgrounds remain reachable and merged search keeps the matching scene's preview", () => {
  const day = v("special:arona_workpage_daytime", { spr: null, lobby: "arona_workpage_daytime", spineCategory: "spinebackground",
    names: { en: { full: "Arona - Daytime" } }, configured: { lobby: "mod:day" }, state: { files: [] } });
  const night = { ...day, key: "special:arona_workpage_night", lobby: "arona_workpage_night",
    names: { en: { full: "Arona - Night" } }, configured: { lobby: "mod:night" }, state: { files: [{ kind: "lobby", applied: "mod:night" }] } };
  const d = { families: [{ key: "arona", base: { en: "Arona" }, variants: [v("arona"), day, night] }] };
  const separate = order(d, view(), { label });
  const next = neighbour(separate, separate, { family: "arona", variant: "arona", merged: false }, 1);
  assert.equal(next.key, day.key);
  const merged = order(d, view({ merged: true }), { label, query: "night" })[0];
  assert.equal(merged.key, night.key);
  assert.equal(merged.spr, null);
  assert.equal(merged.lobby, night.lobby);
  assert.equal(merged.spineCategory, "spinebackground");
  assert.deepEqual(merged.configured, night.configured);
  assert.deepEqual(merged.state, night.state);
});

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

test("a visit moves the variant to the front of the recently viewed, like the server records it", () => {
  const d = data();
  visit(d, "np0045"); // never viewed: first, the others one down
  assert.deepEqual(keys(order(d, view({ mods: "none" }), { label })), ["np0045", "citizen_borot2", "hoshino"]);
  visit(d, "hoshino"); // viewed before: first, only the ones before it move
  const recent = Object.fromEntries(d.families.flatMap((f) => f.variants).map((x) => [x.key, x.recent]));
  assert.deepEqual(recent, { hoshino: 0, hoshino_swimsuit: null, np0045: 1, aru: 2, citizen_borot2: 3 });
  assert.deepEqual(keys(order(d, view({ mods: "none" }), { label })), ["hoshino", "np0045", "citizen_borot2"]);
  // merged: a family is as recent as its most recent variant
  visit(d, "citizen_borot2");
  assert.equal(order(d, view({ merged: true }), { label }).find((c) => c.family === "hoshino").recent, 1);
  // the indexes the server gives after UiState.visit ([key, *others][:RECENT_MAX]), with keys of another install
  // (not in this roster) among them; a variant viewed for the first time pushes the last one out
  const server = Array.from({ length: RECENT_MAX }, (_, i) => `k${i}`);
  const many = { families: [{ key: "f", base: {}, variants: [
    ...server.filter((_, i) => i % 3).map((k) => v(k, { recent: server.indexOf(k) })), v("x1"), v("x2")] }] };
  for (const key of ["k20", "k7", "x1", "k47", "k49", "x2", "k1"]) {
    server.splice(0, server.length, ...[key, ...server.filter((k) => k !== key)].slice(0, RECENT_MAX));
    visit(many, key);
    for (const x of many.families[0].variants) assert.equal(x.recent, server.includes(x.key) ? server.indexOf(x.key) : null, `${key}: ${x.key}`);
  }
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
  assert.deepEqual(keys(order(data(), view({ filters: { portrait: ["replaced"] } }), { label })), ["citizen_borot2"]);
  assert.deepEqual(keys(order(data(), view({ filters: { lobby: ["yes"] } }), { label })), ["hoshino"]);
  assert.deepEqual(keys(order(data(), view({ filters: { favorite: ["no"], model: ["yes"] } }), { label })), []);
  // both options of a group: no narrowing
  assert.equal(order(data(), view({ filters: { favorite: ["yes", "no"] } }), { label }).length, 5);
});

test("retired type selections cannot hide cards or conflict with release filters after loading a saved view", () => {
  const d = data();
  d.families[0].variants.push(v("not_on_global", { playable: true, recruitable: false }));
  assert.equal(Object.hasOwn(FILTERS, "kind"), false);
  for (const merged of [false, true]) {
    const expected = merged
      ? { all: ["hoshino", "aru", "citizen_borot2"], yes: ["hoshino", "aru"], no: ["citizen_borot2"] }
      : { all: ["hoshino", "hoshino_swimsuit", "np0045", "not_on_global", "aru", "citizen_borot2"],
        yes: ["hoshino", "hoshino_swimsuit", "aru"], no: ["np0045", "not_on_global", "citizen_borot2"] };
    for (const kind of [["student"], ["npc"], ["student", "npc"]]) {
      for (const recruit of ["all", "yes", "no"]) {
        const saved = { merged, recruit, sort: "default", order: "asc", filters: { kind } };
        const loaded = normalizeView(saved);
        assert.deepEqual(loaded.filters, {});
        assert.equal(filtering(saved.filters), false);
        const listed = order(d, loaded, { label, unfiltered: true });
        // Mod bands and favorites have their own order; compare membership in catalog order.
        const actual = order(d, loaded, { label }).sort((a, b) => a.n - b.n);
        assert.deepEqual(keys(actual), expected[recruit]);
        assert.deepEqual(keys(listed.sort((a, b) => a.n - b.n)), expected.all);
        assert.deepEqual(saved.filters, { kind });
      }
    }
  }
});

test("migrating a type selection preserves the other display and segment filters", () => {
  const loaded = normalizeView({ merged: false, mods: "none", recruit: "no", sort: "name", order: "asc",
    filters: { kind: ["student"], portrait: ["replaced"], favorite: ["no"] } });
  assert.deepEqual(loaded.filters, { favorite: ["no"], portrait: ["replaced"] });
  assert.equal(filtering(loaded.filters), true);
  assert.deepEqual(keys(order(data(), loaded, { label })), ["citizen_borot2"]);
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

test("the aliases (the CN server's names) are found but never shown", () => {
  const d = { families: [
    { key: "momoi", base: { "zh-CN": "\u6843\u4e95", en: "Momoi" }, aliases: ["\u6843"], variants: [
      v("momoi", { names: { "zh-CN": { full: "\u6843\u4e95" }, en: { full: "Momoi" } }, aliases: ["\u6843"] }),
      v("np0267", { names: { "zh-CN": { full: "\u6843\u4e95\uff08\u4e34\u6218\uff09" }, en: { full: "Momoi (Armed)" } },
        aliases: ["\u6843\uff08\u6b66\u88c5\uff09"], playable: false }),
    ] },
    { key: "kanna", base: { "zh-CN": "\u53f6\u6e1a", en: "Kanna" }, aliases: ["\u5eb7\u5a1c"], variants: [
      v("ch0170", { names: { "zh-CN": { full: "\u53f6\u6e1a" }, en: { full: "Kanna" } }, aliases: ["\u5eb7\u5a1c"] }),
      v("ch0260", { names: { "zh-CN": { full: "\u53f6\u6e1a\uff08\u6cf3\u88c5\uff09" }, en: { full: "Kanna (Swimsuit)" } } }),
    ] },
  ] };
  const find = (q, extra = {}) => order(d, view(extra), { label, query: q });
  // a variant's alias: the server's costume word, typed alone or with the name, brackets left out
  assert.deepEqual(keys(find("\u6b66\u88c5")), ["np0267"]);
  assert.deepEqual(keys(find("\u6843\u6b66\u88c5")), ["np0267"]);
  // the family's alias finds every variant, the ones whose own aliases do not repeat it too
  assert.deepEqual(keys(find("\u5eb7\u5a1c")), ["ch0170", "ch0260"]);
  assert.deepEqual(keys(find("\u5eb7\u5a1c \u6cf3\u88c5")), ["ch0260"]);
  // the cards keep their names; nothing of the alias shows
  assert.deepEqual(find("\u6b66\u88c5").map((c) => c.name), ["\u6843\u4e95\uff08\u4e34\u6218\uff09"]);
  // merged: the card is the variant the alias found
  assert.deepEqual(find("\u6b66\u88c5", { merged: true }).map((c) => [c.family, c.key, c.name]), [["momoi", "np0267", "\u6843\u4e95"]]);
  // the detail screen's arrows step through the same search
  const list = find("\u5eb7\u5a1c");
  assert.equal(neighbour(list, null, { family: "kanna", variant: "ch0170", merged: false }, 1).key, "ch0260");
  // malformed aliases (not strings) are ignored
  const bad = { families: [{ key: "x", base: {}, aliases: [null, 3], variants: [v("x", { aliases: [{}] })] }] };
  assert.deepEqual(keys(order(bad, view(), { label, query: "x" })), ["x"]);
});

test("the user's own aliases of a family find all of its variants, and an edit is found at once", () => {
  const d = data();
  const hoshino = d.families[0];
  const find = (q) => keys(order(d, view(), { label, query: q }));
  assert.deepEqual(find("ojisan"), []);
  hoshino.custom = ["Oji-san", "\u5927\u53d4"];
  assert.deepEqual(find("ojisan"), ["hoshino_swimsuit", "hoshino", "np0045"]); // separators folded like names
  assert.deepEqual(find("\u5927\u53d4 \u6cf3\u88c5"), ["hoshino_swimsuit"]);
  // an edit puts a new list in place: the old alias is gone, the new one is found
  hoshino.custom = ["\u5c0f\u661f"];
  assert.deepEqual(find("\u5927\u53d4"), []);
  assert.deepEqual(find("\u5c0f\u661f"), ["hoshino_swimsuit", "hoshino", "np0045"]);
  assert.ok(order(d, view(), { label, query: "\u5c0f\u661f" }).every((c) => c.name === "\u5c0f\u661f"));
});

test("the first own alias names variant and merged cards, drives name order and clears immediately", () => {
  const d = { families: [
    { key: "a", base: { en: "Alpha" }, custom: [null, "", "Zulu", "Other alias"], variants: [v("a"), v("dress")] },
    { key: "b", base: { en: "Beta" }, variants: [v("b")] },
  ] };
  const collator = new Intl.Collator("en", { numeric: true });
  for (const merged of [false, true]) {
    const find = (query = "", orderBy = "asc") => order(d, view({ merged, sort: "name", order: orderBy }), { label, collator, query });
    assert.deepEqual(find().map((c) => c.name), merged ? ["Beta", "Zulu"] : ["b", "Zulu", "Zulu"]);
    assert.equal(find("Other alias")[0].name, "Zulu");
    assert.equal(find("Alpha")[0].name, "Zulu", "the original family name still matches");
    assert.equal(find("dress")[0].name, "Zulu", "the variant id still matches");
    assert.equal(find("", "desc")[0].name, "Zulu");
  }
  d.families[0].custom = [];
  assert.deepEqual(order(d, view({ merged: true, sort: "name", order: "asc" }), { label, collator }).map((c) => c.name), ["Alpha", "Beta"]);
  assert.deepEqual(order(d, view(), { label, query: "Zulu" }), []);
  assert.equal(order(d, view(), { label, query: "dress" })[0].name, "dress");
});

test("mod aliases, original cores and file names find their variant and merged card after edits", () => {
  const d = data(), variant = d.families[0].variants[1];
  variant.modNames = ["Painted <summer>", "hoshino_swimsuit_spr", "2026-10-01_hoshino_swimsuit.bundle"];
  for (const merged of [false, true]) for (const query of ["painted", "hoshino swimsuit spr", "2026-10-01_hoshino_swimsuit.bundle"]) {
    assert.deepEqual(keys(order(d, view({ merged }), { label, query })), [variant.key]);
  }
  variant.modNames = ["Evening", ...variant.modNames.slice(1)];
  assert.deepEqual(keys(order(d, view(), { label, query: "painted" })), []);
  assert.deepEqual(keys(order(d, view(), { label, query: "evening" })), [variant.key]);
  variant.modNames = variant.modNames.slice(1);
  assert.deepEqual(keys(order(d, view(), { label, query: "evening" })), []);
  assert.deepEqual(keys(order(d, view(), { label, query: "hoshino swimsuit spr" })), [variant.key]);
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
