import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectedFrame, sourceCardState, SELECTION_SLOT } from '../../src/ba_modding_toolkit/web/js/selected-frames.js';
import { frameMesh } from '../../src/ba_modding_toolkit/web/js/ngui-frame-fx.js';
import { selectionPrefab } from './selection_prefabs.mjs';
const at = (tree, path) => path.split('/').reduce((n, part) => n.children.find(c => c.name === part), tree);
const slot = () => at(selectionPrefab(), SELECTION_SLOT);
const walk = n => [n, ...(n.children || []).flatMap(walk)];
const sprite = n => n.widgets.find(w => 'sprite' in w);

for (const [applied, previewed, state] of [[false, false, null], [false, true, 'preview'], [true, false, 'applied'], [true, true, 'applied']]) {
  test(`source state applied=${applied} previewed=${previewed}`, () => {
    assert.equal(sourceCardState(applied, previewed), state);
    const frame = selectedFrame(slot(), { w: 312, h: 480 }, applied, previewed);
    if (!state) { assert.equal(frame, null); return; }
    assert.equal(sprite(frame).color, applied ? '#ffe900/1.00' : '#0db4ff/1.00');
    assert.equal(frame.children.some(n => n.name === 'AppliedBadge'), applied);
    assert.ok(frame.children.every(n => n.name !== 'Check'), 'the badge sprite draws the only check');
    assert.ok(walk(frame).every(n => !n.widgets.some(w => 'text' in w)), 'no caption without one given');
    const caption = { text: 'Selected', fontSize: 14 };
    const captioned = selectedFrame(slot(), { w: 312, h: 480 }, applied, previewed, caption);
    assert.equal(captioned.children.some(n => n.name === 'AppliedLabel'), applied, 'only the yellow state has a label');
    assert.deepEqual(walk(captioned).filter(n => n.widgets.some(w => 'text' in w)).map(n => n.name), applied ? ['AppliedLabel'] : []);
  });
}

test('exactly the prefab badge and its number label remain, and no second check sprite is cloned', () => {
  const frame = selectedFrame(slot(), { w: 312, h: 480 }, true, false, { text: 'Selected', fontSize: 14 });
  assert.deepEqual(frame.children.map(n => n.name), ['AppliedBadge', 'AppliedLabel', 'FrameEffect']);
  const sprites = walk(frame).flatMap(n => n.widgets.filter(w => 'sprite' in w).map(w => w.sprite));
  assert.deepEqual(sprites, ['Common_Bg_Raius10px_Select', 'Common_Icon_Mulligan_1']);
  assert.ok(!sprites.some(name => name.includes('Check')));
  const before = slot();
  selectedFrame(before, { w: 312, h: 480 }, true, false, { text: 'Selected', fontSize: 14 });
  assert.deepEqual(before, slot(), 'the shared prefab is immutable');
});

for (const card of [{ w: 312, h: 480 }, { w: 320, h: 704 }, { w: 790, h: 444.375 }, { w: 360, h: 360 }, { w: 250, h: 250 }]) {
  test(`prefab corner geometry for ${card.w}x${card.h}`, () => {
    const source = slot(), before = structuredClone(source), frame = selectedFrame(source, card, true, true, { text: 'Selected', fontSize: 14 });
    assert.deepEqual(source, before, 'the shared prefab is immutable');
    const fw = sprite(frame);
    assert.deepEqual(frame.pos, [0, 7]);
    assert.equal(fw.w_, card.w - 14); assert.equal(fw.h_, card.h - 14);
    assert.equal(fw.type, 1); assert.equal(fw.pivot, 4); assert.equal(fw.incline, 10); assert.ok(fw.prefabMarker);
    const badge = frame.children.find(n => n.name === 'AppliedBadge'), name = frame.children.find(n => n.name === 'AppliedLabel');
    assert.equal(sprite(badge).sprite, 'Common_Icon_Mulligan_1');
    assert.deepEqual([sprite(badge).w_, sprite(badge).h_], [76, 74]);
    const lean = Math.tan(Math.PI / 18);
    assert.ok(Math.abs((badge.pos[0] - (badge.pos[1] + 7) * lean) - (card.w / 2 - 36)) < 1e-9);
    assert.ok(Math.abs(badge.pos[1] + 7 - (card.h / 2 - 27)) < 1e-9);
    // the prefab's number label keeps its place in the badge (3 below its centre), size, colour and depth above the badge
    const text = name.widgets.find(w => 'text' in w);
    assert.equal(text.text, 'Selected'); assert.equal(text.fontSize, 14);
    assert.deepEqual([text.w_, text.h_, text.pivot, text.depth, text.color], [70, 52, 4, 51, '#7a4800/1.00']);
    assert.ok(Math.abs((name.pos[0] - (name.pos[1] + 7) * lean) - (card.w / 2 - 36)) < 1e-9);
    assert.ok(Math.abs(name.pos[1] - badge.pos[1] + 3) < 1e-9);
    assert.ok(text.depth > sprite(badge).depth, 'the label stays visible over the badge body');
    const effect = frame.children.find(n => n.name === 'FrameEffect').frameEffect;
    assert.deepEqual(effect.uvScale, [.96, .975]);
    for (const density of [1, 2, 3]) for (const scale of [.5, 1920 / 2960, 1, 2]) {
      const mesh = frameMesh(effect);
      assert.equal(mesh.length, 24);
      const expectedY = -2 * 115 * .975 - (fw.h_ - 466) / 2;
      assert.ok(Math.abs(mesh[1] * scale * density - expectedY * scale * density) < .0002);
      assert.equal(mesh[2], 0); assert.equal(mesh[3], 0);
    }
  });
}

test('frame animation uses the prefab particle timing and scrolling material, without replacement tweens', () => {
  for (const applied of [false, true]) {
    const frame = selectedFrame(slot(), { w: 312, h: 480 }, applied, true);
    const fx = frame.children.find(n => n.name === 'FrameEffect').frameEffect;
    assert.equal(fx.system.main.duration, 1.5); assert.equal(fx.system.main.life, 1.5);
    assert.equal(fx.system.main.delay, 0); assert.equal(fx.system.main.ring, 1);
    assert.equal(fx.material.shader, 'DSFX/FX_SHADER_AlphaBlend_Add_Mask_0_NGUIClip');
    assert.equal(fx.material.floats._Main_Speed_X, -.75);
    assert.equal(fx.material.floats._Main_Speed_Y, 0);
    assert.equal(Math.abs(1 / fx.material.floats._Main_Speed_X), 4 / 3);
  }
});

test('all six locales retain their existing Applied labels for accessibility', () => {
  for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH']) {
    const ui = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url))).webui;
    assert.ok(ui.status.applied); assert.ok(ui.photo.applied);
  }
});
