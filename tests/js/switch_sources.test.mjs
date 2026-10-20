// Tests for web/js/switch-sources.js (what the detail screen's switch cards offer and what the game shows), run by
// tests/test_switch_sources.py with Node's test runner: node --test tests/js/switch_sources.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  appliedKey, appliedOf, candidates, configuredKey, coreOf, overwrittenOf, partsOf, popupMode, previewBase, previewChanged, previewKey, sourceOf, switchKindOf,
} from "../../src/ba_modding_toolkit/web/js/switch-sources.js";

const part = (kind, applied, extra = {}) => ({ file: `/game/${kind}-${applied}.bundle`, kind, applied, crc: "ok", ...extra });
const mod = (id, target, kind) => ({ id, target, kind, label: id, file: `/library/mods/${id}/${id}.bundle`, fresh: false });
// hoshino: a portrait and a lobby; swimsuit: a portrait and a lobby of its own; np: a portrait only; shared: the same
// lobby core as hoshino
const family = () => ({
  key: "hoshino",
  variants: [
    { key: "hoshino", spr: "hoshino_spr", lobby: "hoshino_home",
      state: { files: [part("spr", "official"), part("lobby", "mod:l1")] },
      modList: [mod("p1", "hoshino", "spr"), mod("l1", "hoshino", "lobby")] },
    { key: "hoshino_swimsuit", spr: "hoshino_swimsuit_spr", lobby: "hoshino_swimsuit_home",
      state: { files: [part("spr", "variant:hoshino"), part("lobby", "official")] },
      modList: [mod("p2", "hoshino_swimsuit", "spr"), mod("l2", "hoshino_swimsuit", "lobby")] },
    { key: "np0045", spr: "np0045_spr", lobby: null, state: { files: [part("spr", "official")] }, modList: [] },
    { key: "hoshino_shared", spr: "hoshino_shared_spr", lobby: "hoshino_home", state: { files: [] }, modList: [] },
  ],
});

test("candidates of the portrait: own, own mods, other variants, their mods", () => {
  const fam = family();
  const list = candidates(fam, fam.variants[0], "spr");
  assert.deepEqual(list.map((c) => c.key), ["self", "m:p1", "v:hoshino_swimsuit", "v:np0045", "v:hoshino_shared", "m:p2"]);
  assert.equal(list[0].core, "hoshino_spr");
  assert.equal(list[2].core, "hoshino_swimsuit_spr");
  assert.equal(list.at(-1).origin.key, "hoshino_swimsuit");
});

test("candidates of the memorial lobby: the variant's own lobby and its lobby mods only", () => {
  const fam = family();
  const list = candidates(fam, fam.variants[0], "lobby");
  // no portrait mods, and neither another variant's lobby nor its lobby mods (untested under this variant's prefab)
  assert.deepEqual(list.map((c) => c.key), ["self", "m:l1"]);
  assert.equal(list[0].core, "hoshino_home");
  assert.ok(list.every((c) => c.kind !== "mod" || c.mod.kind === "lobby"));
  assert.deepEqual(candidates(fam, fam.variants[1], "lobby").map((c) => c.key), ["self", "m:l2"]);
  assert.deepEqual(candidates(fam, fam.variants[2], "lobby").map((c) => c.key), ["self"]);
});

test("what the game shows, per kind", () => {
  const [hoshino, swimsuit, np] = family().variants;
  assert.equal(appliedOf(hoshino, "spr"), "official");
  assert.equal(appliedKey(hoshino, "spr"), "self");
  assert.equal(appliedKey(hoshino, "lobby"), "m:l1");
  assert.equal(appliedKey(swimsuit, "spr"), "v:hoshino");
  assert.equal(appliedKey(swimsuit, "lobby"), "self");
  assert.equal(appliedKey(np, "lobby"), "self"); // no lobby files: nothing replaced
});

test("parts with several sources, or changed outside the library, are unknown", () => {
  const v = { state: { files: [part("spr", "mod:a"), part("spr", "mod:b")] } };
  assert.equal(appliedOf(v), "unknown");
  assert.equal(appliedKey(v), "unknown");
  const outside = { state: { files: [part("lobby", "unknown"), part("lobby", "official")] } };
  assert.equal(appliedKey(outside, "lobby"), "unknown");
  // one modded part among official ones: the mod
  assert.equal(appliedKey({ state: { files: [part("spr", "official"), part("spr", "mod:a")] } }), "m:a");
});

test("sources for actions.apply", () => {
  assert.equal(sourceOf("self"), "official");
  assert.equal(sourceOf("m:abc"), "mod:abc");
  assert.equal(sourceOf("v:hoshino_swimsuit"), "variant:hoshino_swimsuit");
});

test("parts and cores of a kind", () => {
  const v = { spr: "a_spr", lobby: null, modelFiles: [{ file: "m" }], state: { files: [part("spr", "official"), part("lobby", "official")] } };
  assert.equal(partsOf(v, "spr").length, 1);
  assert.equal(partsOf(v, "model")[0].file, "m");
  assert.equal(coreOf(v, "spr"), "a_spr");
  assert.equal(coreOf(v, "lobby"), null);
});

test("the switch card's kind per tab: none on the 3D tab, whose card stays inert", () => {
  assert.equal(switchKindOf("portrait"), "spr");
  assert.equal(switchKindOf("lobby"), "lobby");
  assert.equal(switchKindOf("model"), null);
});

test("what the game shows follows the library's source rule, part by part", () => {
  const url = new URL("../data/source_rule_cases.json", import.meta.url);
  const { cases } = JSON.parse(readFileSync(url, "utf-8"));
  assert.ok(cases.some((c) => c.parts.some((p) => p.applied === "unknown" && p.crc === "ok")));
  for (const c of cases) {
    const v = { state: { files: c.parts.map((p) => ({ ...p, kind: "spr", file: "/game/x.bundle" })) } };
    assert.equal(appliedOf(v), c.carried, c.name);
  }
});

test("a part's official verdict wins over its applied source; without one, its applied decides", () => {
  // a mod's part it left official, recorded under the mod, and a file of another size than the official one
  const left = { state: { files: [part("spr", "mod:a", { official: true }), part("spr", "official", { official: true })] } };
  assert.equal(appliedOf(left), "official");
  const other = { state: { files: [part("spr", "unknown", { crc: "ok", official: false })] } };
  assert.equal(appliedKey(other), "unknown");
  assert.equal(appliedOf({ state: { files: [part("spr", "mod:a")] } }), "mod:a"); // an older server: no verdict
});

// --- overwritten kinds, alternate lobby cores and the popup while mods are off ---

// a part of another tool's mod with no official copy anywhere (family.get: restorable false)
const overwrittenPart = (kind) => part(kind, "unknown", { official: false, copy: null, restorable: false });

test("candidates carry restorable; on an overwritten kind every card but the one in use is greyed", () => {
  const fam = family();
  for (const c of candidates(fam, fam.variants[0], "spr")) {
    assert.equal(c.restorable, true, c.key);
    assert.equal(c.greyed, false, c.key);
  }
  // hoshino's portrait overwritten by a mod outside the library: nothing in use among the cards, all greyed
  fam.variants[0].state.files = [overwrittenPart("spr")];
  assert.equal(overwrittenOf(fam.variants[0], "spr"), true);
  assert.ok(candidates(fam, fam.variants[0], "spr").every((c) => c.greyed));
  assert.equal(candidates(fam, fam.variants[0], "spr")[0].restorable, false);
  // adopted: the library's mod is in use; it stays, the others are greyed
  fam.variants[0].state.files = [part("spr", "mod:p1", { official: false, copy: null, restorable: false })];
  const list = candidates(fam, fam.variants[0], "spr");
  assert.deepEqual(list.filter((c) => !c.greyed).map((c) => c.key), ["m:p1"]);
  // the popup never starts on a greyed card: on the one in use
  assert.equal(popupMode(fam, fam.variants[0], "spr", true).start, "m:p1");
  assert.equal(popupMode(fam, fam.variants[0], "spr", false).start, "m:p1");
  // the lobby is not overwritten: its cards are not greyed
  assert.ok(candidates(fam, fam.variants[0], "lobby").every((c) => !c.greyed));
});

test("another variant's card is greyed on every other popup when its files of that kind are overwritten", () => {
  const fam = family();
  fam.variants[2].state.files = [overwrittenPart("spr")]; // np0045's portrait: no official copy to adapt from
  for (const v of [fam.variants[0], fam.variants[1]]) {
    const card = candidates(fam, v, "spr").find((c) => c.key === "v:np0045");
    assert.equal(card.greyed, true, v.key);
    assert.equal(card.restorable, false, v.key);
    assert.ok(candidates(fam, v, "spr").filter((c) => c.key !== "v:np0045").every((c) => !c.greyed), v.key);
  }
  // a part that is not official but has an official copy (kept, a backup, another folder) greys nothing
  fam.variants[2].state.files = [part("spr", "unknown", { official: false, copy: "backup", restorable: true })];
  assert.equal(candidates(fam, fam.variants[0], "spr").find((c) => c.key === "v:np0045").greyed, false);
  // a part without restorable (an older server) is never taken for overwritten
  assert.equal(overwrittenOf({ state: { files: [part("spr", "unknown")] } }, "spr"), false);
});

test("a lobby popup lists only the lobby mods of its own core", () => {
  const fam = family();
  fam.variants[0].modList.push(
    { ...mod("gl", "hoshino", "lobby"), core: "hoshino_home_gl" },
    { ...mod("own", "hoshino", "lobby"), core: "hoshino_home" });
  const keys = candidates(fam, fam.variants[0], "lobby").map((c) => c.key);
  assert.deepEqual(keys, ["self", "m:l1", "m:own"], "a mod without core is matched by its target, an alternate core's is not offered");
});

test("while mods are off: Save, starting on the configured card, chipped Set", () => {
  const fam = family();
  const v = fam.variants[0];
  // mods on: Apply, from what the game shows
  assert.deepEqual(popupMode(fam, v, "spr", true), { start: "self", button: "popup.apply", set: null });
  assert.deepEqual(popupMode(fam, v, "lobby", true), { start: "m:l1", button: "popup.apply", set: null });
  // off, with a configured mod: the files are official, the popup starts on the configured card and saves
  v.configured = { spr: "mod:p1", lobby: "variant:hoshino_swimsuit" };
  v.state.files = [part("spr", "official"), part("lobby", "official")];
  assert.equal(configuredKey(v, "spr"), "m:p1");
  assert.deepEqual(popupMode(fam, v, "spr", false), { start: "m:p1", button: "popup.save", set: "m:p1" });
  // a configured source the popup does not offer (another variant's lobby): it starts on the own files
  assert.equal(configuredKey(v, "lobby"), "v:hoshino_swimsuit");
  assert.equal(popupMode(fam, v, "lobby", false).start, "self");
  // nothing configured: the own files, and no Set chip
  v.configured = { spr: null, lobby: null };
  assert.deepEqual(popupMode(fam, v, "spr", false), { start: "self", button: "popup.save", set: null });
  assert.equal(configuredKey({ configured: { spr: "official" } }, "spr"), null);
  assert.equal(configuredKey({}, "spr"), null);
});

test("previews keep both configured kinds while the game files are official", () => {
  const fam = family(), v = fam.variants[0];
  v.configured = { spr: "mod:p1", lobby: "mod:l1" };
  v.state.files = [part("spr", "official"), part("lobby", "official")];
  for (const [kind, id] of [["spr", "p1"], ["lobby", "l1"]]) {
    assert.equal(previewKey(v, kind, false), `m:${id}`);
    assert.equal(previewBase(v, kind, false, fam.variants), `/asset/spine/mod/${id}/skeleton`);
    assert.equal(appliedKey(v, kind), "self", "file status remains independent of the preview");
    assert.equal(previewKey(v, kind, true), "self", "turning mods on follows the carried source again");
    const marked = candidates(fam, v, kind).filter((c) => c.key === previewKey(v, kind, false));
    assert.deepEqual(marked.map((c) => c.key), [`m:${id}`], "only the configured card matches the preview");
  }
  v.configured.spr = "variant:hoshino_swimsuit";
  assert.equal(previewKey(v, "spr", false), "v:hoshino_swimsuit");
  assert.equal(previewBase(v, "spr", false, fam.variants), "/asset/spine/official/hoshino_swimsuit_spr/skeleton");
  assert.equal(previewBase(v, "spr", true, fam.variants), "/asset/spine/spr/hoshino_spr/skeleton");
});

test("a configured variant previews its official copy even when its live files still carry a mod", () => {
  const fam = family(), [v, source] = fam.variants;
  v.configured = { spr: `variant:${source.key}` };
  source.state.files = [part("spr", "mod:leftover", { official: false, restorable: true })];
  assert.equal(appliedKey(source), "m:leftover");
  assert.equal(previewBase(v, "spr", false, fam.variants), "/asset/spine/official/hoshino_swimsuit_spr/skeleton");
  assert.equal(previewBase(source, "spr", true, fam.variants), "/asset/spine/spr/hoshino_swimsuit_spr/skeleton");
});

test("off previews use the configuration even if an unswitched game file still carries a different mod", () => {
  const v = family().variants[0];
  v.configured = { spr: "mod:configured" };
  v.state.files = [part("spr", "mod:carried")];
  assert.equal(previewBase(v, "spr", false), "/asset/spine/mod/configured/skeleton");
  assert.equal(previewKey(v, "spr", true), "m:carried");
  for (const source of [null, "official", "unknown"]) {
    v.configured.spr = source;
    assert.equal(previewKey(v, "spr", false), "self");
  }
  delete v.configured;
  assert.equal(previewKey(v, "spr", false), "self");
});

test("a saved or removed configuration refreshes the preview without any change to the game files", () => {
  const before = family().variants[0];
  before.configured = { spr: "mod:p1", lobby: "mod:l1" };
  const after = structuredClone(before);
  after.configured.spr = "mod:p2";
  assert.equal(previewChanged(before, after, "spr", false, false), true);
  assert.equal(previewChanged(before, after, "lobby", false, false), false);
  after.configured.spr = null;
  assert.equal(previewChanged(before, after, "spr", false, false), true, "removing the configured mod reloads the player");
  assert.equal(previewChanged(before, before, "spr", true, false), true, "a toggle refreshes even an unswitched entry");
  assert.equal(previewChanged(before, after, "spr", true, true), false, "with mods on the game files decide");
});
