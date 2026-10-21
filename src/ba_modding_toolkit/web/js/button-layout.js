// Button patterns are separate NGUI widgets: their anchors, pivot and size follow the body, not its caption.
const PIVX = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1];
const PIVY = [1, 1, 1, 0.5, 0.5, 0.5, 0, 0, 0];

export function resizeButton(body, width = null, height = null) {
  const bg = body.widgets.find((w) => "sprite" in w && "w_" in w);
  if (!bg) return body;
  const oldW = bg.w_, oldH = bg.h_, pivot = bg.pivot ?? 4;
  bg.w_ = width ?? oldW;
  bg.h_ = height ?? oldH;
  for (const child of body.children || []) {
    for (const w of child.widgets) {
      if (!/^Common_Btn_.*_Pt$/.test(w.sprite || "")) continue;
      const anchors = w.anchors || {}, p = w.pivot ?? 4;
      const axis = (i, size, old, bp, cp, lo, hi) => {
        const scale = child.scale[i], span = w[size] * scale;
        const start = -bp * bg[size], end = start + bg[size];
        const edge = (key) => anchors[key] ? start + (end - start) * anchors[key][0] + anchors[key][1] : null;
        let a = edge(lo), b = edge(hi);
        if (a == null && b == null) {
          // Unanchored patterns retain their prefab edge offsets. Items/UseBtn's second pattern is mirrored
          // on the left/bottom; Mailbox/ReceiveAll uses a negative child scale for the same decoration.
          const flipped = i === 0 ? w.flip === 1 || w.flip === 3 : w.flip >= 2;
          const mirrored = flipped !== (scale < 0);
          child.pos[i] += (bg[size] - old) * ((mirrored ? 0 : 1) - bp);
          return;
        }
        if (a == null) a = b - span;
        if (b == null) b = a + span;
        child.pos[i] = a + (b - a) * cp;
        w[size] = (b - a) / scale;
      };
      axis(0, "w_", oldW, PIVX[pivot], PIVX[p], "leftAnchor", "rightAnchor");
      axis(1, "h_", oldH, PIVY[pivot], PIVY[p], "bottomAnchor", "topAnchor");
    }
  }
  return body;
}

// The game clips button decoration to its inclined body. NGUI's DOM renderer flattens the hierarchy, so restore
// that clipping from the *rendered prefab body*, after resizeButton has resolved the patterns' anchors.
export function clipButtonPatterns(view) {
  for (const [path, entry] of view.nodes) {
    const w = entry.node.widgets.find((w) => /^Common_Btn_.*_Pt$/.test(w.sprite || ""));
    if (!w) continue;
    const parent = view.nodes.get(path.slice(0, path.lastIndexOf("/")));
    const body = parent?.node.widgets.find((w) => w.sprite === "Common_Btn_BG");
    const element = entry.els[0];
    if (!body || !element) continue;
    const rect = (el) => ["left", "top", "width", "height"].map((key) => parseFloat(el.style[key]));
    const [bl, bt, bw, bh] = rect(parent.els[0]), [pl, pt, pw, ph] = rect(element);
    const slant = Math.tan((body.incline || 0) * Math.PI / 180) * bh / 2;
    const points = [[bl + slant, bt], [bl + bw + slant, bt], [bl + bw - slant, bt + bh], [bl - slant, bt + bh]];
    // Account for the prefab's flip on the pattern: clipping is applied before its CSS transform.
    const fx = w.flip === 1 || w.flip === 3 ? -1 : 1, fy = w.flip >= 2 ? -1 : 1;
    element.style.clipPath = `polygon(${points.map(([x, y]) => `${pw / 2 + (x - pl - pw / 2) * fx}px ${ph / 2 + (y - pt - ph / 2) * fy}px`).join(", ")})`;
  }
}
