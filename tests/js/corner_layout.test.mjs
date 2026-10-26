import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CORNER_MARGIN, CORNER_UNITS, cornerBox, bindCorner, reflowCorners } from '../../src/ba_modding_toolkit/web/js/corner-layout.js';
import { headerGeometry } from '../../src/ba_modding_toolkit/web/js/window-layout.js';
import { topActionLayout, nativeRightClearance } from '../../src/ba_modding_toolkit/web/js/top-action-layout.js';
import { cornerPrefabs } from './corner_prefabs.mjs';

const S = 1920 / 2960, locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH'];
const home = cornerPrefabs.UICharacterDetail['Inventory_ListControl/NUITop_Scenes/Top/Right/Lobby'];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function geometry(width, height, platform, immersive) {
  const bounds = platform === 'darwin' ? { left: 12, top: 8, right: 80, bottom: 30 }
    : { left: width - 148, top: 8, right: width, bottom: 40 };
  const native = platform ? { active: true, platform, bounds } : null;
  const header = native ? headerGeometry(width, height, platform === 'win32' ? bounds.bottom : 0, immersive) : null;
  const scale = header?.contentScale ?? Math.min(width / 1920, height / 1080);
  const stage = { width: 1920 * scale, height: 1080 * scale,
    left: (width - 1920 * scale) / 2, top: (height - 1080 * scale + (header?.extra || 0)) / 2 };
  return { width, height, native, stage,
    barBottom: header?.rowHeight ?? 64 * scale, immersive, scale };
}

test('the shared margin is the detail Home sprite edge, in authored NGUI units', () => {
  assert.equal(home.pivot, 4);
  near(CORNER_UNITS, -home.pos[0] - home.size[0] / 2);
  near(CORNER_MARGIN, 67.8 * S);
});

test('native bounds cause a horizontal move only on a strict intersection', () => {
  const box = [0, 0, 110, 75], stage = { left: 0, top: 0, width: 960 }, margin = CORNER_MARGIN / 2;
  for (const corner of ['top-left', 'top-right']) {
    const options = { corner, width: 960, height: 540, stage };
    const original = cornerBox(box, options), x = original[0] / 2;
    const touching = [
      { left: x - 20, right: x, top: 0, bottom: 40 },
      { left: x, right: x + 55, top: 0, bottom: margin },
      { left: x, right: x + 55, top: margin + 37.5, bottom: margin + 50 },
    ];
    for (const bounds of touching) assert.deepEqual(cornerBox(box, { ...options, native: { active: true, bounds } }), original);
    const bounds = { left: x, right: x + 55, top: margin, bottom: margin + 37.5 };
    assert.deepEqual(cornerBox(box, { ...options, native: { active: false, bounds } }), original);
    const moved = cornerBox(box, { ...options, native: { active: true, bounds } });
    near(moved[1], original[1]);
    near(corner === 'top-left' ? moved[0] / 2 - bounds.right : bounds.left - (moved[0] + moved[2]) / 2, margin);
  }
});

// Source boxes retain prefab sizes. Sibling groups move together, preserving their original gaps.
const visual = [171 * S, 116 * S], hall = [156 * S, 104 * S];
const visualHit = [(171 - 228.83) * S / 2, (116 - 165) * S / 2, 228.83 * S, 165 * S];
const visualTop = [['top-left', [0, 0, ...visual], visualHit], ['top-right', [0, 0, ...visual], visualHit]];
const scenes = [
  ['Student Hall', false, [['top-right', [1875 - (4 * hall[0] + 60), 145 - hall[1] / 2, 4 * hall[0] + 60, hall[1]]]]],
  ['Student Hall fullscreen', true, [['top-right', [1875 - hall[0], 145 - hall[1] / 2, ...hall]]]],
  ['portrait fullscreen', true, [...visualTop, ['bottom-right', [0, 0, ...visual]]]],
  ['memorial lobby fullscreen', true, [...visualTop, ['bottom-right', [0, 0, ...visual]]]],
  ...['portrait camera', 'memorial lobby camera'].map(name => [name, true, [
    visualTop[0], ['top-right', [1352, 25, 538, 76]],
    ['bottom-left', [25, 950, 130, 82]], ['bottom-right', [1788 - 20 - 145 * 82 / 141, 950, 102 + 20 + 145 * 82 / 141, 82]],
  ]]),
];
for (const locale of locales) for (const platform of [null, 'darwin', 'win32']) {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url))).webui;
  for (const [scene, immersive, groups] of scenes) test(`${scene}, ${locale}, ${platform || 'no native chrome'}: shared edge margin`, () => {
    assert.ok(strings.lobby.exit && strings.row.switch.portrait && strings.row.switch.lobby && strings.photo.occlusion && strings.photo.gridOn);
    for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440], [2560, 1080], [960, 1200]]) for (const density of [1, 2, 3]) {
      const g = geometry(width, height, platform, immersive);
      const topEdges = [];
      for (const [corner, box, collisionBox = box] of groups) {
        const result = cornerBox(box, { ...g, corner, collisionBox });
        const rect = { left: g.stage.left + result[0] * g.scale, top: g.stage.top + result[1] * g.scale };
        rect.right = rect.left + result[2] * g.scale; rect.bottom = rect.top + result[3] * g.scale;
        const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
        const top = immersive ? 0 : g.barBottom, margin = CORNER_MARGIN * g.scale;
        const footprint = { left: rect.left + (collisionBox[0] - box[0]) * g.scale,
          top: rect.top + (collisionBox[1] - box[1]) * g.scale };
        footprint.right = footprint.left + collisionBox[2] * g.scale; footprint.bottom = footprint.top + collisionBox[3] * g.scale;
        const original = cornerBox(box, { ...g, native: null, corner });
        const candidate = { left: g.stage.left + (original[0] + collisionBox[0] - box[0]) * g.scale,
          top: footprint.top, bottom: footprint.bottom };
        candidate.right = candidate.left + collisionBox[2] * g.scale;
        const displaced = !bottom && g.native && overlap(candidate, g.native.bounds);
        near((displaced ? (right ? g.native.bounds.left - footprint.right : footprint.left - g.native.bounds.right)
          : (right ? width - rect.right : rect.left)) * density, margin * density);
        near((bottom ? height - rect.bottom : rect.top - top) * density, CORNER_MARGIN * g.scale * density);
        if (!bottom) topEdges.push(rect.top);
        near(result[2], box[2]); near(result[3], box[3]);
        assert.ok(rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= height);
        if (g.native) assert.ok(!overlap(footprint, g.native.bounds), 'The complete clickable control clears native controls');
      }
      topEdges.forEach(y => near(y, topEdges[0]));
    }
  });
  test(`detail and shared toolbar, ${locale}, ${platform || 'no native chrome'}: prefab side inset and native row`, () => {
    for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440], [2560, 1080], [960, 1200]]) {
      const g = geometry(width, height, platform, false), boxes = {
        home: [CORNER_MARGIN, 7, home.size[0] * S, home.size[1] * S],
        option: [CORNER_MARGIN + 175 * S, 7 + (.6 + (59 - 62) / 2) * S, 60 * S, 62 * S], line: [CORNER_MARGIN + 87.5 * S, 7, 4 * S, 49 * S],
      };
      const stage = { left: 0, top: 0, right: width, width };
      for (const hallHome of [false, true]) {
        const first = topActionLayout(boxes, hallHome);
        const clearance = nativeRightClearance(stage, platform === 'win32' ? g.native.bounds : null, first.option, g.scale);
        const row = topActionLayout(boxes, hallHome, clearance), outer = row[hallHome ? 'option' : 'home'];
        near(outer[0], Math.max(first[hallHome ? 'option' : 'home'][0], clearance));
        near(row.option[1] + row.option[3] / 2, boxes.home[1] + boxes.home[3] / 2 + (hallHome ? 0 : .6 * S));
      }
    }
  });
}

test('registered controls recalculate after stage fitting and native bounds change', () => {
  const old = Object.fromEntries(['document', 'innerWidth', 'innerHeight', 'bamtWindowChrome', 'bamtHeaderGeometry'].map(k => [k, globalThis[k]]));
  const control = { style: {}, isConnected: true };
  try {
    for (const [width, height, platform] of [[960, 540, 'darwin'], [2560, 1440, 'win32'], [1600, 900, null]]) {
      const g = geometry(width, height, platform, true);
      Object.assign(globalThis, { innerWidth: width, innerHeight: height, bamtWindowChrome: g.native, bamtHeaderGeometry: { rowHeight: 1000 },
        document: { getElementById: () => ({ getBoundingClientRect: () => g.stage }) } });
      if (!control.style.translate) bindCorner(control, [25, 20, ...visual], { corner: 'top-left' });
      else reflowCorners();
      const expected = cornerBox([25, 20, ...visual], { ...g, corner: 'top-left' });
      const [dx, dy] = control.style.translate.split(' ').map(parseFloat);
      near(25 + dx, expected[0]); near(20 + dy, expected[1]);
    }
  } finally { Object.assign(globalThis, old); }
});

test('the real stage fitter spans the window with the non-native toolbar and clears those offsets on native hosts', async () => {
  const old = Object.fromEntries(['document', 'innerWidth', 'innerHeight', 'bamtWindowChrome', 'bamtHeaderGeometry'].map(k => [k, globalThis[k]]));
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
  const { fitStage } = await import('../../src/ba_modding_toolkit/web/js/util.js');
  const style = () => ({ setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } });
  const bar = { style: style() };
  try {
    for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440], [2560, 1080], [960, 1200]]) {
      const g = geometry(width, height, null, false), stage = { style: style(), getBoundingClientRect: () => g.stage };
      Object.assign(globalThis, { innerWidth: width, innerHeight: height, bamtWindowChrome: null, bamtHeaderGeometry: null,
        document: { getElementById: () => stage, querySelector: () => bar } });
      fitStage();
      near(g.stage.left + parseFloat(bar.style.left) * g.scale, 0);
      near(g.stage.top + parseFloat(bar.style.top) * g.scale, 0);
      near(parseFloat(bar.style.width) * g.scale, width);
      globalThis.bamtHeaderGeometry = headerGeometry(width, height, 40);
      fitStage();
      assert.equal(bar.style.left, undefined); assert.equal(bar.style.top, undefined);
    }
  } finally { Object.assign(globalThis, old); }
});

test('the viewport clips the window while the scene artwork and sliding navigation retain their fitted clip', () => {
  const css = readFileSync(new URL('../../src/ba_modding_toolkit/web/css/app.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../src/ba_modding_toolkit/web/index.html', import.meta.url), 'utf8');
  assert.match(css, /\.viewport \{[^}]*position: fixed;[^}]*inset: 0;[^}]*overflow: clip;/);
  assert.doesNotMatch(/^\.stage \{([\s\S]*?)^\}/m.exec(css)[1], /overflow:/);
  assert.match(css, /\.scene-clip \{[^}]*position: absolute;[^}]*inset: 0;[^}]*overflow: clip;[^}]*pointer-events: none;/);
  assert.match(css, /#student-hall > \.lobby,[^}]*overflow: clip;/);
  // Inspect actual HTML ancestry: art clips inside the stage; controls stay outside that clip.
  const ancestry = new Map(), stack = [];
  for (const match of html.matchAll(/<(\/?)(div|section|footer|button)\b([^>]*)>/g)) {
    if (match[1]) { stack.pop(); continue; }
    const classes = /class="([^"]*)"/.exec(match[3])?.[1].split(' ') || [];
    const id = /id="([^"]*)"/.exec(match[3])?.[1];
    if (id) ancestry.set(id, stack.flat());
    if (match[2] === 'footer') assert.ok(stack.flat().includes('scene-clip'));
    stack.push(classes);
  }
  for (const id of ['ngui-bg', 'visual-bg', 'portrait', 'model', 'lobby', 'ngui', 'ngui-chips', 'ngui-expr']) assert.ok(ancestry.get(id).includes('scene-clip'), id);
  for (const id of ['visual-ui', 'fs-exit', 'popup', 'picker']) assert.ok(!ancestry.get(id).includes('scene-clip'), id);
});
