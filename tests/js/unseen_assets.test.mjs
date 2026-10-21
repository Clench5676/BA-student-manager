import assert from "node:assert/strict";
import { test } from "node:test";
import { clearUnseen, hasUnseen, shownUnseen, switchUnseen } from "../../src/ba_modding_toolkit/web/js/unseen-assets.js";
import { DEFAULT_VIEW, normalizeView, order } from "../../src/ba_modding_toolkit/web/js/roster-order.js";

const mod = (id, target, kind) => ({ id, target, kind, fresh: true });
const variant = (key, mods = []) => ({ key, spr: `${key}_spr`, lobby: `${key}_home`, model: `${key}_model`,
  names: { en: { full: key } }, fresh: mods.length > 0, modList: mods, state: { files: [] } });
const family = (...variants) => ({ key: "student", base: { en: "Student" }, variants });
const shownIds = (...args) => shownUnseen(...args).map((entry) => entry.id);

for (const kind of ["spr", "lobby", "model"]) for (const enabled of [true, false]) {
  test(`${kind} marks the ${enabled ? "applied" : "configured"} asset on its tab, and offers the rest on the switch`, () => {
    const v = variant("a", [mod("current", "a", kind), mod("other", "a", kind)]), f = family(v);
    v.state.files = [{ kind, applied: enabled ? "mod:current" : "official", official: !enabled }];
    v.configured = { [kind]: "mod:current" };
    assert.ok(hasUnseen(v, kind));
    assert.deepEqual(shownIds(f, v, kind, enabled), ["current"]);
    assert.equal(switchUnseen(f, v, kind, enabled), true);
    clearUnseen(f, ["other"]);
    assert.equal(switchUnseen(f, v, kind, enabled), false, "the configured asset has no switch-card dot");
    assert.ok(hasUnseen(v, kind), "its tab stays marked until shown");
    clearUnseen(f, shownIds(f, v, kind, enabled));
    assert.equal(hasUnseen(v, kind), false);
    assert.equal(v.fresh, false);
  });
}

test("showing a portrait worn across variants clears the asset's owning variant", () => {
  const a = variant("a"), b = variant("b", [mod("dress", "b", "spr")]), f = family(a, b);
  a.state.files = [{ kind: "spr", applied: "mod:dress", official: false }];
  assert.deepEqual(shownIds(f, a, "spr"), ["dress"]);
  assert.equal(switchUnseen(f, a, "spr"), false);
  clearUnseen(f, shownIds(f, a, "spr"));
  assert.equal(b.fresh, false);
});

test("showing a repaired import clears its original asset's dot", () => {
  const original = { ...mod("original", "a", "lobby"), repaired_id: "fixed" };
  const repaired = { ...mod("fixed", "a", "lobby"), repaired_from: "original", fresh: false };
  const a = variant("a", [original, repaired]), f = family(a);
  a.state.files = [{ kind: "lobby", applied: "mod:fixed", official: false }];
  assert.deepEqual(shownIds(f, a, "lobby"), ["original"]);
  assert.equal(switchUnseen(f, a, "lobby"), false);
  clearUnseen(f, shownIds(f, a, "lobby"));
  assert.equal(a.fresh, false);
});

test("a configured alternate lobby core is seen even when it is not offered by the switch", () => {
  const a = variant("a", [{ ...mod("global", "a", "lobby"), core: "a_home_gl" }]), f = family(a);
  a.configured = { lobby: "mod:global" };
  assert.deepEqual(shownIds(f, a, "lobby", false), ["global"]);
  clearUnseen(f, shownIds(f, a, "lobby", false));
  assert.equal(a.fresh, false);
});

test("viewing the only imported lobby clears both separate and merged roster marks", () => {
  const a = variant("a"), b = variant("b", [mod("lobby", "b", "lobby")]), f = family(a, b);
  b.state.files = [{ kind: "lobby", applied: "mod:lobby", official: false }];
  const marks = (merged) => order({ families: [f] }, normalizeView({ ...DEFAULT_VIEW, merged }), { label: (names) => names?.en }).map((card) => !!card.fresh);
  assert.deepEqual(marks(false), [false, true]);
  assert.deepEqual(marks(true), [true]);
  clearUnseen(f, shownIds(f, b, "lobby"));
  assert.deepEqual(marks(false), [false, false]);
  assert.deepEqual(marks(true), [false]);
});

test("clearing one kind preserves the other tab and the merged roster dot", () => {
  const a = variant("a", [mod("portrait", "a", "spr"), mod("lobby", "a", "lobby")]), f = family(a);
  clearUnseen(f, ["lobby"]);
  assert.equal(hasUnseen(a, "lobby"), false);
  assert.equal(hasUnseen(a, "spr"), true);
  assert.equal(a.fresh, true);
});

test("unapplied assets stay unseen on tab visits and clear only when their switch popup offers them", () => {
  const a = variant("a", [mod("portrait", "a", "spr"), mod("lobby", "a", "lobby")]), f = family(a);
  assert.deepEqual(shownIds(f, a, "spr"), []);
  assert.deepEqual(shownIds(f, a, "lobby"), []);
  assert.equal(switchUnseen(f, a, "spr"), true);
  assert.equal(switchUnseen(f, a, "lobby"), true);
  clearUnseen(f, ["lobby"]);
  assert.equal(switchUnseen(f, a, "lobby"), false);
  assert.equal(a.fresh, true);
});
