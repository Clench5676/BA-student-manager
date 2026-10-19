// Tests for web/js/linear.js (the lobby's linear-light drawing) against a recording stand-in for WebGL2: what a player
// gets on attach is freed again on detach. Run by tests/test_lobby_linear.py with Node's test runner.
import assert from "node:assert/strict";
import { test } from "node:test";

// a WebGL2 context that records every call; create* return fresh objects, constants are their names
class FakeGL {}
globalThis.WebGL2RenderingContext = FakeGL;
function fakeGL() {
  const calls = [], live = new Set();
  let n = 0;
  const target = Object.assign(new FakeGL(), { calls, live, drawingBufferWidth: 64, drawingBufferHeight: 32 });
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      return (...args) => {
        calls.push([name, ...args]);
        if (name.startsWith("create")) { const o = { kind: name.slice(6), id: ++n }; live.add(o); return o; }
        if (name.startsWith("delete")) { live.delete(args[0]); return undefined; }
        if (name === "getShaderParameter" || name === "getProgramParameter") return true;
        if (name === "checkFramebufferStatus") return "FRAMEBUFFER_COMPLETE";
        if (name === "isContextLost") return false;
        return null;
      };
    },
  });
}

class Texture { update() { this.updated = (this.updated || 0) + 1; } getImage() { return {}; } }
class Batcher { setBlendMode() { return "spine"; } }
globalThis.spine = { BlendMode: { Normal: 0, Additive: 1 },
  PolygonBatcher: { blendModesGL: [{ srcRgb: 1, srcRgbPma: 1, dstRgb: 2, srcAlpha: 1 }, { srcRgb: 1, srcRgbPma: 1, dstRgb: 1, srcAlpha: 1 }] } };

const Linear = await import("../../src/ba_modding_toolkit/web/js/linear.js");

function player(gl) {
  const page = Object.assign(new Texture(), { texture: {}, useMipMaps: false });
  const restorables = [];
  return {
    page, restorables,
    context: { gl, addRestorable: (r) => restorables.push(r), removeRestorable: (r) => restorables.splice(restorables.indexOf(r), 1) },
    skeleton: { data: { skins: [{ getAttachments: () => [{ attachment: { region: { texture: page } } }] }] } },
    sceneRenderer: { batcher: new Batcher() },
  };
}

test("detach frees the framebuffer, its texture, the program and the triangle, and restores the hooks", () => {
  const gl = fakeGL(), p = player(gl);
  assert.equal(Linear.attach(p), true);
  assert.equal(p.restorables.length, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(p.page, "update"));
  assert.notEqual(p.sceneRenderer.batcher.setBlendMode, Batcher.prototype.setBlendMode);
  Linear.begin(p); // sizes the sRGB texture to the drawing buffer and binds the framebuffer
  Linear.end(p);
  // the shaders went with the program at once; what is left: program, vertex array, buffer, framebuffer, texture
  assert.deepEqual([...gl.live].map((o) => o.kind).sort(), ["Buffer", "Framebuffer", "Program", "Texture", "VertexArray"]);

  Linear.detach(p);
  assert.equal(gl.live.size, 0, `still alive: ${JSON.stringify([...gl.live])}`);
  assert.equal(p.restorables.length, 0);
  assert.ok(!Object.prototype.hasOwnProperty.call(p.page, "update"));
  assert.equal(p.sceneRenderer.batcher.setBlendMode, Batcher.prototype.setBlendMode);
  assert.equal(Linear.active(p), false);
  // the player's hooks are no-ops from now on, and a second detach is harmless
  const before = gl.calls.length;
  Linear.begin(p);
  Linear.tint(p);
  Linear.end(p);
  Linear.detach(p);
  assert.equal(gl.calls.length, before);
});

test("a lost context is not asked to delete anything", () => {
  const gl = fakeGL(), p = player(gl);
  Linear.attach(p);
  gl.isContextLost = () => true;
  const before = gl.calls.length;
  Linear.detach(p);
  assert.equal(gl.calls.filter(([name], i) => i >= before && name.startsWith("delete")).length, 0);
  assert.equal(p.restorables.length, 0);
});
