// Tests for web/js/switch-sources.js (what the detail screen's switch cards offer and what the game shows), run by
// tests/test_switch_sources.py with Node's test runner: node --test tests/js/switch_sources.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { appliedKey, appliedOf, candidates, coreOf, partsOf, sourceOf, switchKindOf } from "../../src/ba_modding_toolkit/web/js/switch-sources.js";

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
