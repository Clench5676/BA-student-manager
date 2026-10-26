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
const { FRAME_OUTPUT, frameBlend, frameMesh, frameOver, renderFrameEffect } = await import('../../src/ba_modding_toolkit/web/js/ngui-frame-fx.js');
const { toLinear, toSrgb } = await import('../../src/ba_modding_toolkit/web/js/touch-fx.js');
const slot = SELECTION_SLOT.split('/').reduce((n, part) => n.children.find(c => c.name === part), selectionPrefab());
const effect = selectedFrame(slot, { w: 312, h: 480 }, true, true).children.find(n => n.frameEffect).frameEffect;
function setup({ connected = true, glAvailable = true } = {}) {
  const uniforms = [], deleted = [], sources = [], calls = [], contexts = [];
  const gl = new Proxy({ getUniformLocation: (_program, name) => name,
    getAttribLocation: (_program, name) => ({ a_pos: 0, a_uv: 1, a_color: 2 }[name]),
    getShaderParameter: () => true, getProgramParameter: () => true,
    shaderSource: (_shader, source) => sources.push(source),
    uniform1f: (name, value) => uniforms.push([name, value]),
    deleteProgram: value => deleted.push(value),
  }, { get: (target, key) => key in target ? target[key] : key.toUpperCase() === key ? 1 : (...args) => { calls.push([key, args]); return {}; } });
  const canvas = { style: {}, isConnected: connected, closest: () => null, getContext: (...args) => { contexts.push(args); return glAvailable ? gl : null; } };
  globalThis.document = { documentElement: {}, createElement: () => canvas };
  const host = { appendChild(el) { assert.equal(el, canvas); } };
  const urls = [];
  return { canvas, uniforms, deleted, sources, calls, contexts, render: () => renderFrameEffect(effect, host, {
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

// --- the page's composite against the game's blend ---------------------------------------------------------------------------
// The game blends One / OneMinusSrcAlpha in linear light over the card: result = light + behind * (1 - alpha), the light being
// the shader's colour (HDR, 44 and 1084 in linear light), the alpha only the mask. The values below are the material's own.
const rings = [['yellow (applied)', selectedFrame(slot, { w: 312, h: 480 }, true, false)], ['blue (previewed)', selectedFrame(slot, { w: 312, h: 480 }, false, true)]]
  .map(([name, frame]) => [name, frame.children.find(n => n.frameEffect).frameEffect]);
// the mask program's output for a texel of the ring's gradient (FX_TEX_Bulletline_03 is grey: red = green = blue = g, decoded
// from sRGB; the mask texture is white; _RGBRGBA is 0): rgb = g * g * vertex colour * _Color, alpha = g
function shaderOut(effect, g) {
  assert.equal(effect.material.floats._RGBRGBA, 0); assert.equal(effect.material.tex._Tex_Mask.default, 'white');
  const tint = effect.system.main.color.col, color = toLinear(effect.material.colors._Color[0]);
  return { light: tint.slice(0, 3).map(c => g * g * c * color), alpha: Math.min(1, g * tint[3] * tint[3] * effect.material.colors._Color[3]) };
}
const gameOver = (light, alpha, behind) => toSrgb(light + toLinear(behind) * (1 - alpha)); // the blend, then the display encoding
// what the canvas used to be: the straight colour light / alpha, clamped, over the card by alpha (the page's blend)
const straightOver = (light, alpha, behind) => alpha <= 0 ? behind : toSrgb(Math.min(1, light / alpha)) * alpha + behind * (1 - alpha);
const texels = Array.from({ length: 256 }, (_, i) => toLinear(i / 255)); // every level of the 8-bit grey texture
const sweep = Array.from({ length: 1000 }, (_, i) => (i + 1) / 1000);   // and the bilinear levels between them
const backdrops = Array.from({ length: 51 }, (_, i) => i / 50);          // black, the card's greys, white
const over = (layer, channel, behind) => frameOver({ color: layer.color[channel], alpha: layer.alpha }, behind);

for (const [name, fx] of rings) {
  test(`${name}: the ring's light never darkens the card more than the game's blend does, at any texel the corners visit`, () => {
    const worst = { darker: 0, brighter: 0 };
    for (const g of [...texels, ...sweep]) {
      const { light, alpha } = shaderOut(fx, g), layer = frameBlend(light, alpha);
      for (const behind of backdrops) for (let c = 0; c < 3; c++) {
        const d = over(layer, c, behind) - gameOver(light[c], alpha, behind);
        worst.darker = Math.min(worst.darker, d); worst.brighter = Math.max(worst.brighter, d);
      }
    }
    assert.ok(worst.darker > -1e-9, `${name}: ${worst.darker} darker than the game`);
    assert.ok(worst.brighter < 0.33, `${name}: ${worst.brighter} brighter than the game`); // partly lit channels only, measured 0.316
  });

  test(`${name}: over black the light is the game's, and a lit channel the mask does not cover stays the game's over white`, () => {
    for (const g of sweep) {
      const { light, alpha } = shaderOut(fx, g), layer = frameBlend(light, alpha);
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(over(layer, c, 0) - gameOver(light[c], alpha, 0)) < 1e-9, `${name} g=${g} over black`);
        if (light[c] === 0 || light[c] >= 1) assert.ok(Math.abs(over(layer, c, 1) - gameOver(light[c], alpha, 1)) < 1e-9, `${name} g=${g} c=${c} over white`);
      }
    }
  });

  test(`${name}: texels where the mask is dark but not zero keep the card at least as bright as the game would`, () => {
    for (const g of [0.0001, 0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2]) {
      const { light, alpha } = shaderOut(fx, g), layer = frameBlend(light, alpha);
      for (const behind of backdrops) for (let c = 0; c < 3; c++) {
        assert.ok(over(layer, c, behind) >= gameOver(light[c], alpha, behind) - 1e-9, `${name} g=${g} c=${c} behind=${behind}`);
        // and the card is dimmed by at most what the game's blend leaves of it, (1 - alpha) in linear light
        assert.ok(over(layer, c, behind) >= toSrgb(toLinear(behind) * (1 - alpha)) - 1e-9);
      }
    }
  });
}

test('the old straight-alpha canvas lost the light the game adds: its measured deficits are what the premultiplied canvas now carries', () => {
  // yellow, mask 0.151: red is 1.00 in the game over black, the straight canvas weighted it by the mask: 0.151
  const [, yellow] = rings[0], [, blue] = rings[1];
  let { light, alpha } = shaderOut(yellow, 0.151), layer = frameBlend(light, alpha);
  assert.ok(gameOver(light[0], alpha, 0) > 0.999);
  assert.ok(straightOver(light[0], alpha, 0) < 0.16, 'the old composite, 0.151 over black');
  assert.ok(over(layer, 0, 0) > 0.999, 'the new one');
  // blue, mask 0.031: blue is 1.00 in the game over black; 0.031 in the old composite
  ({ light, alpha } = shaderOut(blue, 0.031)); layer = frameBlend(light, alpha);
  assert.ok(gameOver(light[2], alpha, 0) > 0.999 && straightOver(light[2], alpha, 0) < 0.04 && over(layer, 2, 0) > 0.999);
  // over the card (white) the old composite also dimmed the zero-light channel by (1 - alpha) in sRGB values, not in linear light
  ({ light, alpha } = shaderOut(yellow, 0.5)); layer = frameBlend(light, alpha);
  assert.equal(light[2], 0);
  assert.ok(Math.abs(straightOver(light[2], alpha, 1) - 0.5) < 1e-9 && Math.abs(gameOver(light[2], alpha, 1) - toSrgb(0.5)) < 1e-9);
  assert.ok(Math.abs(over(layer, 2, 1) - toSrgb(0.5)) < 1e-9, 'the premultiplied canvas leaves what the game leaves');
});

test('no mask, no change: the canvas draws nothing there, so the card keeps its own pixels (the frame interior is untouched)', () => {
  const layer = frameBlend([0, 0, 0], 0);
  assert.deepEqual(layer, { color: [0, 0, 0], alpha: 0 });
  for (const behind of backdrops) for (let c = 0; c < 3; c++) assert.equal(over(layer, c, behind), behind);
  // the light is clamped to what the page can show and the alpha to coverage, whatever the shader sends
  assert.deepEqual(frameBlend([5, -1, 0.5], 2), { color: [1, 0, toSrgb(0.5)], alpha: 1 });
});

test('the premultiplied canvas: the fragment shader writes light and cover, and only the mesh is drawn', async () => {
  const h = setup(); await h.render();
  assert.deepEqual(h.contexts, [['webgl2', { alpha: true, premultipliedAlpha: true, antialias: true }]]);
  assert.ok(h.sources[1].endsWith(FRAME_OUTPUT), 'the ported program, then the output stage');
  assert.ok(h.sources[1].includes('void frameMain()') && !h.sources[1].includes('o.rgb/max(o.a'), 'no un-premultiplying division');
  assert.ok(FRAME_OUTPUT.includes('displayColor(clamp(o.rgb,vec3(0.),vec3(1.)))'), 'the light, clamped and sRGB-encoded');
  assert.ok(FRAME_OUTPUT.includes('1.-displayColor(vec3(1.-clamp(o.a,0.,1.))).x'), 'the cover: what the blend takes of what is behind, encoded');
  assert.ok(FRAME_OUTPUT.includes('o=vec4(light,cover)'));
  const clear = h.calls.filter(([key]) => key === 'clearColor'), draws = h.calls.filter(([key]) => key === 'drawArrays');
  assert.deepEqual(clear.map(([, args]) => args), [[0, 0, 0, 0]], 'transparent where nothing is drawn');
  assert.deepEqual(draws.map(([, args]) => args), [[1, 0, 3]], 'the mesh\'s one triangle, no covering quad');
  assert.ok(!h.calls.some(([key]) => key === 'enable' || key === 'blendFunc'), 'no GL blending: the page composites the layer');
});

test('the canvas covers exactly the mesh\'s extents, as before', async () => {
  const h = setup(); await h.render();
  const data = frameMesh(effect), xs = [0, 1, 2].map(i => data[i * 8]), ys = [0, 1, 2].map(i => data[i * 8 + 1]);
  const halfW = Math.max(...xs.map(Math.abs)), halfH = Math.max(...ys.map(Math.abs));
  assert.equal(h.canvas.style.width, `${halfW * 2}px`); assert.equal(h.canvas.style.height, `${halfH * 2}px`);
  assert.equal(h.canvas.style.left, `${200 - halfW}px`); assert.equal(h.canvas.style.top, `${300 - halfH}px`);
  const density = Math.max(2, globalThis.devicePixelRatio || 1);
  assert.equal(h.canvas.width, Math.ceil(halfW * 2 * density)); assert.equal(h.canvas.height, Math.ceil(halfH * 2 * density));
  assert.ok(Math.abs(halfH - 2 * 115 * .975) < 1e-3 && Math.abs(halfW - (1 * 115 * .96 + halfH * Math.tan(Math.PI / 18))) < 1e-3, 'the authored extents and the 10 degree incline');
});
