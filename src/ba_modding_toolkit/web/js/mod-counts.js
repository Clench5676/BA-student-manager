// The roster band's two library counts: portraits and memorial lobbies, each a game icon plus "x n". When an icon is
// missing from the loaded atlases the count falls back to a short word (locale keys band.portrait, band.lobby).
import { label, node, sprite, textWidth } from "./ngui.js";

// The game sprites drawn as the count icons, both already drawn elsewhere in the UI: the Students entry of the bottom
// navigation (nav-items.js) and the play button of the lobby tab (detail.js). Change a name here to swap an icon.
export const COUNT_ICONS = Object.freeze({ spr: "Common_Icon_Student", lobby: "Common_Icon_Play", model: "Common_Icon_Craft", other: "Common_Icon_Inventory_Equip" });

const KINDS = ["spr", "lobby", "model", "other"];
const WORD = { spr: "band.portrait", lobby: "band.lobby", model: "tab.model", other: "import.other" };

// kind -> { atlas, name, ratio } for the sprites the loaded atlas index has; a kind without its sprite is left out
export function iconsOf(index = {}) {
  const icons = {};
  for (const kind of KINDS) {
    for (const [atlas, sprites] of Object.entries(index)) {
      const meta = sprites?.[COUNT_ICONS[kind]];
      if (meta) { icons[kind] = { atlas, name: COUNT_ICONS[kind], ratio: meta.width / meta.height || 1 }; break; }
    }
  }
  return icons;
}

export const countText = (counts, T) => T("band.modCounts", { portraits: counts?.spr || 0, lobbies: counts?.lobby || 0 });

// The portrait band: one half per kind, both always shown (zero too); long text shrinks in place
export function countNodes(counts, icons = {}, T = null, { kinds = ["spr", "lobby"], width = 400, color = "#ffffff/1.00" } = {}) {
  return kinds.map((kind, i) => {
    const icon = icons[kind], n = `×${counts?.[kind] || 0}`;
    const room = icon ? 120 : 190, text = icon || !T ? n : `${T(WORD[kind])} ${n}`;
    const fs = Math.min(36, 36 * room / Math.max(textWidth(text, 36), 1));
    const kids = [node("Count", [icon ? 28 : 0, 0], [label(text, fs, color, room, 48, { depth: 16 })])];
    if (icon) kids.push(node("Icon", [-70, 0], [sprite(icon.name, 42 * Math.min(1, icon.ratio), 42 / Math.max(1, icon.ratio),
      { atlas: icon.atlas, type: 0, depth: 16, color })]));
    return node(kind, [(i + 0.5) * width / kinds.length - width / 2, 0], [], kids);
  });
}
