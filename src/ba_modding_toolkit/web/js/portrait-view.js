// The detail screen's portrait framing, as in the game: UICharacterDetail places every portrait skeleton with its
// origin on the node CharacterPos, at that node's scale, whatever the skeleton holds. Framing on the skeleton's
// bounds instead shrank and shifted every character with a long weapon, wings or a prop beside her (Eimi (Armed)'s
// gun made her 30 % smaller, 200 px to the right and lower than her other variants). No DOM: the tests run it in Node.

// every portrait's SkeletonDataAsset scale: a skeleton unit is 1/100 of a Unity unit (all 630 in the 2026-10 install)
export const SKELETON_SCALE = 0.01;
// CharacterPos as UICharacterDetail has it, for a layout without the node
export const CHARACTER_POS = Object.freeze({ pos: [-738, -746], scale: [101, 101] });

// portraitViewport(node, {origin, s, box}) -> a spine-player viewport showing exactly the box, with the skeleton's
// origin on the node. node: the layout node (pos, scale in prefab units); origin: the prefab centre on the stage and s
// the stage px per prefab unit (detail.js toStage); box: the player's box on the stage {left, top, width, height}.
// spine-player keeps one zoom for both axes and fits the viewport into its canvas: a viewport of the canvas's own
// aspect fills it exactly, so a skeleton unit is the same number of px across and down.
export function portraitViewport(node, { origin, s, box }) {
  const pos = Array.isArray(node?.pos) ? node.pos : CHARACTER_POS.pos;
  const scale = Number(node?.scale?.[0]) > 0 ? node.scale[0] : CHARACTER_POS.scale[0];
  const k = scale * SKELETON_SCALE * s; // stage px per skeleton unit
  const ox = origin[0] + pos[0] * s, oy = origin[1] - pos[1] * s;
  return {
    x: (box.left - ox) / k, y: (oy - (box.top + box.height)) / k, width: box.width / k, height: box.height / k,
    padLeft: 0, padRight: 0, padTop: 0, padBottom: 0, transitionTime: 0, animations: {},
  };
}

// where a skeleton point lands on the stage, by spine-player's own camera arithmetic for a canvas of the box's size
// at a device pixel ratio (its drawing buffer is the box times the ratio)
export function stagePoint(view, box, x, y, dpr = 1) {
  const cw = Math.round(box.width * dpr), ch = Math.round(box.height * dpr);
  const zoom = ch / cw > view.height / view.width ? view.width / cw : view.height / ch;
  const cx = view.x + view.width / 2, cy = view.y + view.height / 2;
  const bx = (x - cx) / zoom + cw / 2, by = ch / 2 - (y - cy) / zoom;
  return [box.left + (bx / cw) * box.width, box.top + (by / ch) * box.height];
}
