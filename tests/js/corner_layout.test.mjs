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
  return { width, height, native, stage, rowBottom: header?.rowHeight || 0,
    barBottom: header?.rowHeight ?? stage.top + 64 * scale, immersive, scale };
}

test('the shared margin is the detail Home sprite edge, in authored NGUI units', () => {
  assert.equal(home.pivot, 4);
  near(CORNER_UNITS, -home.pos[0] - home.size[0] / 2);
  near(CORNER_MARGIN, 67.8 * S);
});

// Source boxes retain prefab sizes. Sibling groups move together, preserving their original gaps.
const visual = [171 * S, 116 * S], hall = [156 * S, 104 * S];
const scenes = [
  ['Student Hall', false, [['top-right', [1875 - (4 * hall[0] + 60), 145 - hall[1] / 2, 4 * hall[0] + 60, hall[1]]]]],
  ['Student Hall fullscreen', true, [['top-right', [1875 - hall[0], 145 - hall[1] / 2, ...hall]]]],
  ['portrait fullscreen', true, [['top-left', [0, 0, ...visual]], ['top-right', [0, 0, ...visual]], ['bottom-right', [0, 0, ...visual]]]],
  ['memorial lobby fullscreen', true, [['top-left', [0, 0, ...visual]], ['top-right', [0, 0, ...visual]], ['bottom-right', [0, 0, ...visual]]]],
  ...['portrait camera', 'memorial lobby camera'].map(name => [name, true, [
    ['top-left', [25, 20, 164 * S, 172 * S]], ['top-right', [1352, 25, 538, 76]],
    ['bottom-left', [25, 950, 130, 82]], ['bottom-right', [1788 - 20 - 145 * 82 / 141, 950, 102 + 20 + 145 * 82 / 141, 82]],
  ]]),
];
for (const locale of locales) for (const platform of [null, 'darwin', 'win32']) {
  const strings = JSON.parse(readFileSync(new URL(`../../src/ba_modding_toolkit/locales/${locale}.json`, import.meta.url))).webui;
  for (const [scene, immersive, groups] of scenes) test(`${scene}, ${locale}, ${platform || 'no native chrome'}: shared edge margin`, () => {
    assert.ok(strings.lobby.exit && strings.row.switch.portrait && strings.row.switch.lobby && strings.photo.occlusion && strings.photo.gridOn);
    for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440]]) for (const density of [1, 2, 3]) {
      const g = geometry(width, height, platform, immersive);
      for (const [corner, box] of groups) {
        const result = cornerBox(box, { ...g, corner });
        const rect = { left: g.stage.left + result[0] * g.scale, top: g.stage.top + result[1] * g.scale };
        rect.right = rect.left + result[2] * g.scale; rect.bottom = rect.top + result[3] * g.scale;
        const right = corner.endsWith('right'), bottom = corner.startsWith('bottom');
        const nativeCorner = platform && (right ? platform === 'win32' : platform === 'darwin');
        const top = Math.max(immersive ? 0 : g.barBottom, nativeCorner ? g.rowBottom : 0);
        near((right ? width - rect.right : rect.left) * density, CORNER_MARGIN * g.scale * density);
        near((bottom ? height - rect.bottom : rect.top - top) * density, CORNER_MARGIN * g.scale * density);
        near(result[2], box[2]); near(result[3], box[3]);
        assert.ok(rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= height);
        if (g.native) assert.ok(!overlap(rect, g.native.bounds), 'The entire corner group clears native controls');
      }
    }
  });
  test(`detail and shared toolbar, ${locale}, ${platform || 'no native chrome'}: prefab side inset and native row`, () => {
    for (const [width, height] of [[960, 540], [1600, 900], [2560, 1440]]) {
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
      Object.assign(globalThis, { innerWidth: width, innerHeight: height, bamtWindowChrome: g.native, bamtHeaderGeometry: { rowHeight: g.rowBottom },
        document: { getElementById: () => ({ getBoundingClientRect: () => g.stage }) } });
      if (!control.style.translate) bindCorner(control, [25, 20, 164 * S, 172 * S], { corner: 'top-left' });
      else reflowCorners();
      const expected = cornerBox([25, 20, 164 * S, 172 * S], { ...g, corner: 'top-left' });
      const [dx, dy] = control.style.translate.split(' ').map(parseFloat);
      near(25 + dx, expected[0]); near(20 + dy, expected[1]);
    }
  } finally { Object.assign(globalThis, old); }
});
