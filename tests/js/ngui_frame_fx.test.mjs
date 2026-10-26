import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedFrame, SELECTION_SLOT } from '../../src/ba_modding_toolkit/web/js/selected-frames.js';
import { selectionPrefab } from './selection_prefabs.mjs';
const media = { matches: false, addEventListener(_type, fn) { this.change = fn; } };
globalThis.matchMedia = () => media;
let observe, serial = 0;
const frames = new Map();
globalThis.requestAnimationFrame = fn => { const id = ++serial; frames.set(id, fn); return id; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.MutationObserver = class { constructor(fn) { observe = fn; } observe() {} };
const { renderFrameEffect } = await import('../../src/ba_modding_toolkit/web/js/ngui-frame-fx.js');
const slot = SELECTION_SLOT.split('/').reduce((n, part) => n.children.find(c => c.name === part), selectionPrefab());
const effect = selectedFrame(slot, { w: 312, h: 480 }, true, true).children.find(n => n.frameEffect).frameEffect;
function setup({ connected = true, glAvailable = true } = {}) {
  const uniforms = [], deleted = [], sources = [], calls = [];
  const gl = new Proxy({ getUniformLocation: (_program, name) => name,
    getAttribLocation: (_program, name) => ({ a_pos: 0, a_uv: 1, a_color: 2 }[name]),
    getShaderParameter: () => true, getProgramParameter: () => true,
    shaderSource: (_shader, source) => sources.push(source),
    uniform1f: (name, value) => uniforms.push([name, value]),
    deleteProgram: value => deleted.push(value),
  }, { get: (target, key) => key in target ? target[key] : key.toUpperCase() === key ? 1 : (...args) => { calls.push([key, args]); return {}; } });
  const canvas = { style: {}, isConnected: connected, closest: () => null, getContext: () => glAvailable ? gl : null };
  globalThis.document = { documentElement: {}, createElement: () => canvas };
  const host = { appendChild(el) { assert.equal(el, canvas); } };
  const urls = [];
  return { canvas, uniforms, deleted, sources, calls, render: () => renderFrameEffect(effect, host, {
    x: 200, y: 300, sx: 1, sy: 1, z: 30, load: async url => { urls.push(url); return {}; },
  }), urls };
}
function tick(time) { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(time); }

test('frame renderer uses the material UV speed, freezes for reduced motion and frees removed frames', async () => {
  const h = setup(); await h.render();
  assert.equal(h.canvas.style.pointerEvents, 'none'); assert.equal(h.canvas.style.zIndex, '71');
  assert.ok(h.uniforms.some(([name, value]) => name === '_Main_Speed_X' && value === -.75));
  assert.ok(h.sources[1].includes('_TimeY * vec2(_Main_Speed_X, _Main_Speed_Y)'));
  assert.ok(h.urls[0].includes('/asset/ui/selection-frame/fake_texture.png'));
  assert.equal(frames.size, 1); tick(1000);
  assert.deepEqual(h.uniforms.at(-1), ['_TimeY', 1]);
  media.matches = true; media.change(); assert.equal(frames.size, 0);
  media.matches = false; media.change(); assert.equal(frames.size, 1);
  h.canvas.isConnected = false; observe([]); assert.equal(h.deleted.length, 1);
  tick(2000); assert.equal(frames.size, 0);
});

test('a staged frame starts only after publication and stays static when reduced motion is active', async () => {
  media.matches = true;
  const h = setup({ connected: false }); await h.render(); assert.equal(frames.size, 0);
  assert.deepEqual(h.uniforms.at(-1), ['_TimeY', 0]);
  h.canvas.isConnected = true; observe([{ addedNodes: [h.canvas] }]); assert.equal(frames.size, 0);
  media.matches = false; media.change(); assert.equal(frames.size, 1);
  h.canvas.isConnected = false; observe([]); tick(2000); assert.equal(frames.size, 0);
});

test('WebGL2 absence leaves the static prefab frame usable', async () => {
  const h = setup({ glAvailable: false }); await h.render(); assert.equal(h.urls.length, 0); assert.equal(frames.size, 0);
});
