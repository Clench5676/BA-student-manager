// Tests for api.js's skeleton URLs: spineBase (a skeleton's base path) and spinePrefix (what every URL of a core
// starts with, which the library.changed handler forgets the thumbnails under), and thumbs.js forget matching any
// case. Run by tests/test_spine_base.py with Node's test runner: node --test tests/js/spine_base.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { spineBase, spinePrefix } = await import("../../src/ba_modding_toolkit/web/js/api.js");

test("a core's skeleton base and its prefix", () => {
  assert.equal(spineBase("spr", "CH0164_spr"), "/asset/spine/spr/CH0164_spr/skeleton");
  assert.equal(spinePrefix("spr", "CH0164_spr"), "/asset/spine/spr/CH0164_spr");
  assert.equal(spineBase("lobby", "airi_home"), "/asset/spine/lobby/airi_home/skeleton");
  assert.equal(spinePrefix("mod", "a1b2"), "/asset/spine/mod/a1b2");
  // the base of the current install's core starts with the prefix the handler forgets
  for (const [kind, core] of [["spr", "airi_spr"], ["lobby", "ch0251_home"], ["spr", "odd core/name"]]) {
    assert.ok(spineBase(kind, core).startsWith(spinePrefix(kind, core)), core);
  }
  // escaped as one path segment
  assert.equal(spinePrefix("spr", "a/b"), "/asset/spine/spr/a%2Fb");
});

test("another install's entry reads its own files through <core>@<id>, under the same prefix", () => {
  assert.equal(spineBase("spr", "CH0164_spr", "a1b2c3d4e5f6"), "/asset/spine/spr/CH0164_spr@a1b2c3d4e5f6/skeleton");
  assert.equal(spineBase("lobby", "ch0251_home", null), "/asset/spine/lobby/ch0251_home/skeleton", "the current install's");
  assert.equal(spineBase("lobby", "ch0251_home", ""), spineBase("lobby", "ch0251_home"));
  // the library.changed handler's prefix covers both installs' bases, so neither shows the other's picture after a switch
  for (const id of [null, "a1b2c3d4e5f6"]) assert.ok(spineBase("spr", "CH0164_spr", id).startsWith(spinePrefix("spr", "CH0164_spr")), String(id));
  assert.notEqual(spineBase("spr", "CH0164_spr", "a1b2c3d4e5f6"), spineBase("spr", "CH0164_spr"));
});

test("forget drops the thumbnails under a prefix in any case (library.changed names cores in lower case)", async () => {
  const base = (kind, key) => spineBase(kind, key).replace("/skeleton", `/${"a".repeat(64)}/skeleton`);
  const el = () => ({ style: {}, className: "", appendChild() {}, remove() {} });
  globalThis.document = { body: el(), createElement: el };
  globalThis.URL.revokeObjectURL = () => {};
  const Thumbs = await import("../../src/ba_modding_toolkit/web/js/thumbs.js");
  // a thumbnail being rendered (here a player that never loads) is kept: asking again gives the same promise
  globalThis.spine = { SpinePlayer: class {} };
  const a = Thumbs.thumb(base("spr", "CH0164_spr"), "card");
  const other = Thumbs.thumb(base("spr", "CH0099_spr"), "card");
  assert.equal(Thumbs.thumb(base("spr", "CH0164_spr"), "card"), a);
  Thumbs.forget(spinePrefix("spr", "ch0164_spr"));
  assert.notEqual(Thumbs.thumb(base("spr", "CH0164_spr"), "card"), a, "forgotten: asked again");
  assert.equal(Thumbs.thumb(base("spr", "CH0099_spr"), "card"), other, "another core's stays");
});
