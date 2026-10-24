// Verified LobbyCommon and LobbyCommonNight: identity ancestors, TweenController/CharPos at (-112, -886),
// scale 111. Ordinary portrait SkeletonDataAssets use .01. The game's 16:9 UI camera spans 2960 x 1665 units.
// These are a projection baseline, not a claim about every runtime camera/character composition.
export const LOBBY_CHARACTER_POS = Object.freeze({ pos: [-112, -886], scale: [111, 111] });
export const LOBBY_UI_WIDTH = 2960;
export const PORTRAIT_SKELETON_SCALE = .01;
export const PORTRAIT_BASE_SCALE = 111 * PORTRAIT_SKELETON_SCALE * 1920 / LOBBY_UI_WIDTH;
export const PORTRAIT_ANCHOR = Object.freeze({ x: 960 - 112 * 1920 / LOBBY_UI_WIDTH, y: 540 + 886 * 1920 / LOBBY_UI_WIDTH });
export const HALL_SCALE = Object.freeze({ min: .25, max: 1.5, default: 1 });
export const hallScale = (value) => Number.isFinite(value) ? Math.max(HALL_SCALE.min, Math.min(HALL_SCALE.max, value)) : HALL_SCALE.default;
export const portraitScale = (entry, globalScale = HALL_SCALE.default) => PORTRAIT_BASE_SCALE * entry.scale * hallScale(globalScale);

export function portraitRect(entry, bounds = null, globalScale = HALL_SCALE.default) {
  const source = bounds || { x: -195, y: 0, width: 390, height: 850 }, scale = portraitScale(entry, globalScale);
  return { x: entry.x + (entry.mirror ? -source.x - source.width : source.x) * scale, y: entry.y - (source.y + source.height) * scale,
    width: source.width * scale, height: source.height * scale };
}
