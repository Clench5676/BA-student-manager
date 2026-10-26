import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { selectedFrame, selectionArtWindow, sourceCardState, SELECTION_SLOT } from '../../src/ba_modding_toolkit/web/js/selected-frames.js';
import { frameMesh } from '../../src/ba_modding_toolkit/web/js/ngui-frame-fx.js';
import { frameOutline } from '../../src/ba_modding_toolkit/web/js/row-thumbnail.js';
import { sliceAxis, slicePoint } from '../../src/ba_modding_toolkit/web/js/sprite-slices.js';
import { selectionPrefab, selectionSprite, selectionFramePixels } from './selection_prefabs.mjs';
const at = (tree, path) => path.split('/').reduce((n, part) => n.children.find(c => c.name === part), tree);
const slot = () => at(selectionPrefab(), SELECTION_SLOT);
const walk = n => [n, ...(n.children || []).flatMap(walk)];
const sprite = n => n.widgets.find(w => 'sprite' in w);

for (const applied of [false, true]) test(`the prefab opening is covered at both left corners, applied=${applied}`, () => {
  const outline = frameOutline(selectionFramePixels()), lean = Math.tan(Math.PI / 18);
  assert.deepEqual(outline.insets, [8, 8, 8, 8]);
  assert.equal(selectionSprite.borderLeft, 14, 'slice cuts are not painted stroke widths');
  for (const card of [{ w: 312, h: 480 }, { w: 320, h: 704 }, { w: 790, h: 444.375 }, { w: 360, h: 360 }, { w: 250, h: 250 }, { w: 250, h: 226 }]) {
    const frame = selectedFrame(slot(), card, applied, true), fw = sprite(frame);
    const art = selectionArtWindow(frame, selectionSprite, outline);
    assert.equal(art.radius, 0, 'only the prefab stroke shapes the visible opening');
    assert.ok(!art.clipPolygon, 'a second rounded clip cannot cut into the frame opening');
    assert.equal(art.incline, fw.incline);
    for (const density of [1, 2, 3]) for (const scale of [960 / 2960, 1600 / 2960, 2560 / 2960, .59]) {
      const ax = sliceAxis(30, 14, 14, fw.w_ * scale, scale, Math.max(2, density));
      const ay = sliceAxis(30, 14, 14, fw.h_ * scale, scale, Math.max(2, density));
      // The complete bounding box of the actual opening, hence every curved corner and straight span inside it.
      for (const u of [8, 15, 22]) for (const v of [8, 15, 22]) {
        const y = frame.pos[1] + fw.h_ / 2 - slicePoint(v, ay) / scale;
        const x = frame.pos[0] + slicePoint(u, ax) / scale - fw.w_ / 2 + (y - frame.pos[1]) * lean;
        const localX = x - art.x - (y - art.y) * lean, localY = y - art.y;
        assert.ok(Math.abs(localX) < art.width / 2 && Math.abs(localY) < art.height / 2,
          `${card.w}x${card.h}, ${scale} at ${density}x, opening (${u},${v}) is painted`);
      }
    }
    if (card.w === 312) {
      assert.deepEqual([art.x, art.y, art.width, art.height], [0, 7, 284, 452]);
      // The old window is centred at (1,4), 296x454, radius 18. These points are inside the frame opening.
      const inOldArt = (qx, y) => {
        const x = qx - (1 - 4 * lean), dy = y - 4;
        const cx = Math.max(-148 + 18, Math.min(148 - 18, x));
        const cy = Math.max(-227 + 18, Math.min(227 - 18, dy));
        return Math.abs(x) <= 148 && Math.abs(dy) <= 227 && (x - cx) ** 2 + (dy - cy) ** 2 <= 18 ** 2;
      };
      assert.equal(inOldArt(-135 - 7 * lean, 231.5), false, 'old top-left clipping exposes the base');
      assert.equal(inOldArt(-141 - 7 * lean, -218), false, 'old bottom-left clipping exposes the base');
    }
  }
});

for (const [applied, previewed, state] of [[false, false, null], [false, true, 'preview'], [true, false, 'applied'], [true, true, 'applied']]) {
  test(`source state applied=${applied} previewed=${previewed}`, () => {
    assert.equal(sourceCardState(applied, previewed), state);
    const frame = selectedFrame(slot(), { w: 312, h: 480 }, applied, previewed);
    if (!state) { assert.equal(frame, null); return; }
    assert.equal(sprite(frame).color, applied ? '#ffe900/1.00' : '#0db4ff/1.00');
    assert.equal(frame.children.some(n => n.name === 'AppliedBadge'), applied);
    assert.equal(frame.children.some(n => n.name === 'PreviewBadge'), !applied);
    assert.ok(frame.children.every(n => n.name !== 'Check'), 'the badge sprite draws the only check');
    assert.ok(walk(frame).every(n => !n.widgets.some(w => 'text' in w)), 'no caption without one given');
    const caption = { text: applied ? 'Applied' : 'Selected', fontSize: 14, badgeWidth: 160, labelWidth: 100.625 };
    const captioned = selectedFrame(slot(), { w: 312, h: 480 }, applied, previewed, caption);
    assert.deepEqual(walk(captioned).filter(n => n.widgets.some(w => 'text' in w)).map(n => n.name),
      [applied ? 'AppliedLabel' : 'PreviewLabel']);
  });
}

for (const applied of [false, true]) test(`exactly one prefab badge and label remain for applied=${applied}`, () => {
  const caption = { text: applied ? 'Applied' : 'Selected', fontSize: 14, badgeWidth: 160, labelWidth: 100.625 };
  const frame = selectedFrame(slot(), { w: 312, h: 480 }, applied, true, caption);
  const prefix = applied ? 'Applied' : 'Preview';
  assert.deepEqual(frame.children.map(n => n.name), [`${prefix}Badge`, `${prefix}Label`, 'FrameEffect']);
  const sprites = walk(frame).flatMap(n => n.widgets.filter(w => 'sprite' in w).map(w => w.sprite));
  assert.deepEqual(sprites, ['Common_Bg_Raius10px_Select', applied ? 'Common_Icon_Mulligan_1' : 'Common_Icon_Mulligan_2']);
  assert.ok(!sprites.some(name => name.includes('Check')));
  const before = slot();
  selectedFrame(before, { w: 312, h: 480 }, applied, true, caption);
  assert.deepEqual(before, slot(), 'the shared prefab is immutable');
});

for (const card of [{ w: 312, h: 480 }, { w: 320, h: 704 }, { w: 790, h: 444.375 }, { w: 360, h: 360 }, { w: 250, h: 226 }]) {
  for (const [applied, previewed] of [[false, true], [true, false], [true, true]]) test(`prefab corner geometry for ${card.w}x${card.h}, applied=${applied} previewed=${previewed}`, () => {
    const source = slot(), before = structuredClone(source), caption = { text: applied ? 'Applied' : 'Selected', fontSize: 14, badgeWidth: 160, labelWidth: 100.625 };
    const frame = selectedFrame(source, card, applied, previewed, caption);
    assert.deepEqual(source, before, 'the shared prefab is immutable');
    const fw = sprite(frame);
    assert.deepEqual(frame.pos, [0, 7]);
    assert.equal(fw.w_, card.w - 14); assert.equal(fw.h_, card.h - 14);
    assert.equal(fw.type, 1); assert.equal(fw.pivot, 4); assert.equal(fw.incline, 10); assert.ok(fw.prefabMarker);
    const prefix = applied ? 'Applied' : 'Preview';
    const badge = frame.children.find(n => n.name === `${prefix}Badge`), name = frame.children.find(n => n.name === `${prefix}Label`);
    assert.equal(sprite(badge).sprite, applied ? 'Common_Icon_Mulligan_1' : 'Common_Icon_Mulligan_2');
    assert.deepEqual([sprite(badge).w_, sprite(badge).h_], [160, 74]);
    const lean = Math.tan(Math.PI / 18);
    assert.ok(Math.abs((badge.pos[0] - (badge.pos[1] + 7) * lean) - (card.w / 2 - 36 - 42)) < 1e-9);
    assert.ok(Math.abs(badge.pos[1] + 7 - (card.h / 2 - 27)) < 1e-9);
    // the prefab's number label is centred in the fill, preserving its font, height, ink and depth
    const text = name.widgets.find(w => 'text' in w);
    assert.equal(text.text, caption.text); assert.equal(text.fontSize, 14);
    assert.deepEqual([text.w_, text.h_, text.pivot, text.depth, text.color], [100.625, 52, 4, 51, '#7a4800/1.00']);
    assert.ok(Math.abs(name.pos[0] - badge.pos[0] - (14 - 36) * 76 / 64 / 2) < 1e-9);
    assert.ok(Math.abs(name.pos[1] - badge.pos[1]) < 1e-9);
    assert.ok(text.depth > sprite(badge).depth, 'the label stays visible over the badge body');
    const effect = frame.children.find(n => n.name === 'FrameEffect').frameEffect;
    assert.deepEqual(effect.uvScale, [.96, .975]);
    for (const density of [1, 2, 3]) for (const scale of [960 / 2960, 1600 / 2960, 2560 / 2960]) {
      const pixels = scale * density;
      assert.ok((Math.abs(name.pos[0] - badge.pos[0]) + text.w_ / 2) * pixels <= sprite(badge).w_ / 2 * pixels);
      assert.ok((Math.abs(name.pos[1] - badge.pos[1]) + text.h_ / 2) * pixels <= sprite(badge).h_ / 2 * pixels);
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
