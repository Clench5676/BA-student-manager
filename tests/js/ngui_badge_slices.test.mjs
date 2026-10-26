// Exercise the shared NGUI raster path with synthetic images only; record draw geometry, never game pixels.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectedFrame, SELECTION_SLOT } from '../../src/ba_modding_toolkit/web/js/selected-frames.js';
import { selectionPrefab } from './selection_prefabs.mjs';

const encoded = [];
class Element {
  style = {}; dataset = {}; children = []; draws = [];
  appendChild(el) { this.children.push(el); }
  getContext() {
    return { drawImage: (...args) => this.draws.push(args), measureText: text => ({ width: text.length * 20 }) };
  }
  toBlob(done) { encoded.push(this); done(null); }
  toDataURL() { return this.url = `data:image/png;base64,synthetic${encoded.length}`; }
}
globalThis.document = { createElement: () => new Element(), documentElement: { lang: 'en-US' } };
globalThis.Image = class {
  naturalWidth = 64; naturalHeight = 69;
  set src(value) { this.url = value; queueMicrotask(() => this.onload?.()); }
  decode() { return Promise.resolve(); }
};
const meta = { width: 64, height: 69, borderLeft: 0, borderRight: 0, borderTop: 0, borderBottom: 0 };
globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('atlases') ? { Common: {
  Common_Icon_Mulligan_1: { ...meta }, Common_Icon_Mulligan_2: { ...meta },
} } : {} });
const NGUI = await import('../../src/ba_modding_toolkit/web/js/ngui.js');
const slot = () => NGUI.find(selectionPrefab(), SELECTION_SLOT);
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

for (const applied of [true, false]) test(`${applied ? 'yellow' : 'blue'} badge uses one baked image with fixed native end pieces`, async () => {
  for (const stageWidth of [960, 1600, 2560]) for (const displayDensity of [1, 2, 3]) {
    const scale = stageWidth / 2960, density = Math.max(2, displayDensity);
    const renders = [];
    for (const width of [76, 242]) {
      const frame = selectedFrame(slot(), { w: 250, h: 250 }, applied, !applied,
        { text: applied ? 'Applied' : 'Selected', fontSize: 42, badgeWidth: width, labelWidth: width - 50 * 76 / 64 });
      const badge = frame.children.find(n => n.name.endsWith('Badge'));
      const count = encoded.length;
      const view = await NGUI.render(badge, new Element(), { scale, origin: [0, 0], rasterDensity: displayDensity });
      assert.ok(encoded.length <= count + 1, 'three tiles are baked into one image, reused at matching density');
      const el = view.nodes.get(badge.name).els[0];
      const image = encoded.find(c => el.style.backgroundImage === `url("${c.url}")`);
      assert.ok(image, 'the badge draws the single baked image');
      assert.equal(image.draws.length, 3, 'horizontal slicing only');
      assert.equal(image.width, Math.round(width * scale * density));
      assert.equal(image.height, Math.round(74 * scale * density));
      const right = image.draws[2], source = right[0].draws[0];
      assert.deepEqual(source.slice(1), [28, 0, 36, 69, 0, 0, 36, 69], 'the entire check/right end is one untouched tile');
      assert.equal(right[5] + right[7], image.width, 'right end lands on the unchanged right edge');
      assert.equal(right[7], Math.round(36 * 76 / 64 * scale * density));
      assert.equal(right[8], image.height, 'native prefab height, no vertical cuts');
      near(right[7] / density, 36 * 76 / 64 * scale, .5 / density);
      near(right[8] / density, 74 * scale, .5 / density);
      assert.deepEqual(image.draws[0][0].draws[0].slice(1), [0, 0, 14, 69, 0, 0, 14, 69]);
      assert.deepEqual(image.draws[1][0].draws[0].slice(1), [14, 0, 14, 69, 0, 0, 14, 69], 'only the verified uniform run stretches');
      renders.push({ right, edge: parseFloat(el.style.left) + parseFloat(el.style.width), top: el.style.top, height: el.style.height });
    }
    assert.deepEqual(renders[0].right.slice(6), renders[1].right.slice(6), 'growing the fill never resizes the check piece');
    near(renders[0].edge, renders[1].edge, .011);
    assert.equal(renders[0].top, renders[1].top); assert.equal(renders[0].height, renders[1].height);
  }
  assert.deepEqual(NGUI.atlasIndex().Common.Common_Icon_Mulligan_1, meta, 'runtime cuts do not mutate the atlas');
  assert.deepEqual(NGUI.atlasIndex().Common.Common_Icon_Mulligan_2, meta);
});
