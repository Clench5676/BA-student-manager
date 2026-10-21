// Shared constants and small helpers for the screens.
import * as NGUI from "./ngui.js";

export const S = 1920 / 2960;                       // stage px per NGUI unit (the game fits 2960 units to the width)
export const TAN10 = Math.tan((10 * Math.PI) / 180); // the game's 10 degree incline
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const $ = (id) => document.getElementById(id);

export const glyphsOf = (str, fs) => NGUI.glyphWidth(str, fs);
export const advanceOf = (str, fs) => NGUI.textWidth(str, fs);

// prefab tree edits
export function at(tree, path) {
  const n = NGUI.find(tree, path);
  if (!n) console.warn("missing node", path);
  return n;
}
export const off = (tree, ...paths) => { for (const p of paths) { const n = at(tree, p); if (n) n.active = false; } };
export function text(tree, path, value, extra = {}) {
  const n = at(tree, path);
  const w = n?.widgets.find((x) => "text" in x);
  if (w) Object.assign(w, { text: value }, extra);
}
export const widget = (tree, path) => at(tree, path)?.widgets.find((x) => "w_" in x);

// a path (or a short text ending in one) broken after its separators (and the dashes and underscores of bundle names)
// to fit maxW; the largest size from fsMax down to fsMin that needs at most maxLines lines. Never cut: a part longer
// than a line is broken between characters.
export function wrapPath(path, fsMax, fsMin, maxW, maxLines = 3) {
  const pieces = String(path ?? "").split(/(?<=[\\/ _-])/);
  let best = null;
  for (let fs = fsMax; fs >= fsMin; fs -= 2) {
    // a piece wider than a line at this size is broken between characters
    const parts = pieces.flatMap((piece) => {
      if (glyphsOf(piece.trimEnd(), fs) <= maxW) return [piece];
      const out = [];
      let cur = "";
      for (const ch of piece) { if (cur && glyphsOf(cur + ch, fs) > maxW) { out.push(cur); cur = ch; } else cur += ch; }
      return cur ? [...out, cur] : out;
    });
    const lines = [];
    let cur = "";
    for (const part of parts) {
      if (cur && glyphsOf((cur + part).trimEnd(), fs) > maxW) { lines.push(cur.trimEnd()); cur = part; } else cur += part;
    }
    if (cur) lines.push(cur.trimEnd());
    best = { text: lines.join("\n"), fs, lines: lines.length };
    if (lines.length <= maxLines) return best;
  }
  return best;
}

// an invisible button over a rendered widget
export function hitButton(host, [l, t, w, h], fn, name, z = 50) {
  const b = document.createElement("button");
  b.className = "hit";
  if (name) b.setAttribute("aria-label", name);
  Object.assign(b.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px`, zIndex: z });
  b.addEventListener("click", fn);
  host.appendChild(b);
  return b;
}

// recruitable marker: the game's recruitment (gacha) icon from the lobby
export const RECRUIT = { sprite: "Common_Icon_Gacha2", atlas: "Common", ratio: 143 / 126 };
export const recruitIcon = (pos, h, depth = 15) => NGUI.node("Recruit", pos, [NGUI.sprite(RECRUIT.sprite, h / RECRUIT.ratio, h, { atlas: RECRUIT.atlas, type: 0, depth })]);

// a label, optionally led by the recruit icon, centred as one group around x = 0; shrinks and wraps to fit
export function markedLabel(caption, { fs = 40, fsMin = 26, color, maxW, mark = false, depth = 14, maxLines = 2 }) {
  const iconH = fs * 1.35, iconW = mark ? iconH / RECRUIT.ratio + 6 : 0;
  const f = NGUI.fitText(caption, fs, fsMin, maxW - iconW, maxLines);
  const tw = glyphsOf(f.text, f.fs), adv = Math.max(...f.text.split("\n").map((l) => advanceOf(l, f.fs)));
  const left = -(iconW + tw) / 2;
  const textNode = NGUI.node("Text", [left + iconW + adv / 2, 0], [NGUI.label(f.text, f.fs, color, adv + 2, f.fs * 1.2 * f.lines, { depth })]);
  return { nodes: mark ? [recruitIcon([left + iconW / 2 - 3, 0], iconH), textNode] : [textNode], fs: f.fs, lines: f.lines };
}

// the game's red "new" dot
export const DOT = (pos, size = 34) => NGUI.node("Dot", pos, [NGUI.sprite("Common_Icon_Reddot2", size, size * 31 / 34, { type: 0, depth: 45 })]);

export const fitStage = () => document.getElementById("stage").style.setProperty("--scale", Math.min(innerWidth / 1920, innerHeight / 1080));
