import { validRect } from "./lobby-health.js";

export const isSpecial = (v) => !!(v?.spineCategory || v?.key?.startsWith("special:"));
export function specialFraming(v) {
  if (!isSpecial(v)) return null;
  const core = v.lobby || v.key.slice("special:".length), category = v.spineCategory;
  if (/_(?:npc|spr)$/i.test(core) || (category === "spinecharacters" && !/workpage|background|cafe|task/i.test(core))) return "character";
  return "scene";
}

// Fit the whole NPC; fill the canvas with a scene. Both use drawable skeleton bounds, independent of export scale.
export function specialView(bounds, framing, aspect = 16 / 9, anchor = 0.5) {
  if (!validRect(bounds) || !(aspect > 0)) throw new Error("No drawable L2D bounds");
  const bw = bounds.x1 - bounds.x0, bh = bounds.y1 - bounds.y0;
  const w = framing === "character" ? Math.max(bw / (2 * Math.min(anchor, 1 - anchor)), bh * aspect) : Math.min(bw, bh * aspect), h = w / aspect;
  return { x: bounds.x0 + bw / 2 - w * anchor, y: bounds.y0 + bh / 2 - h / 2, w, h };
}
