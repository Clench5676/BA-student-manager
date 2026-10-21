import assert from "node:assert/strict";
import { test } from "node:test";
import { lobbyStillViewport } from "../../src/ba_modding_toolkit/web/js/lobby-still.js";
// Coordinates derived from Ui's UILobbyElement / CH0169_home, with no game assets.
const ui = { view: { x: -1480, y: -832.5, w: 2960, h: 1665 }, layer: { x: 0, y: -962, scale: 1 } };
for (const aspect of [16 / 9, 384 / 352, 1, 480 / 880]) test(`Ui's ${aspect} still contains only the game camera`, () => {
  const v = lobbyStillViewport(ui, aspect), layer = ui.layer;
  const rect = { x: v.x * layer.scale + layer.x, y: v.y * layer.scale + layer.y,
    w: v.width * layer.scale, h: v.height * layer.scale };
  assert.ok(Math.abs(v.width / v.height - aspect) < 1e-8);
  assert.ok(rect.x >= ui.view.x && rect.y >= ui.view.y);
  assert.ok(rect.x + rect.w <= ui.view.x + ui.view.w + 1e-8);
  assert.ok(rect.y + rect.h <= ui.view.y + ui.view.h + 1e-8);
  assert.ok(Math.abs(rect.x + rect.w / 2) < 1e-8); assert.ok(Math.abs(rect.y + rect.h / 2) < 1e-8);
  if (aspect === 16 / 9) assert.deepEqual(v, { x: -1480, y: 129.5, width: 2960, height: 1665,
    padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {} });
});

test("a custom prefab layer transform changes skeleton coordinates, never the visible camera", () => {
  const v = lobbyStillViewport({ ...ui, layer: { x: 37.5, y: -880, scale: .72 } }, 16 / 9);
  assert.ok(Math.abs(v.x * .72 + 37.5 + 1480) < 1e-8); assert.ok(Math.abs(v.y * .72 - 880 + 832.5) < 1e-8);
});
