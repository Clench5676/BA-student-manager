// NGUI prefab renderer. Takes a layout tree read from the game's UI prefabs (/asset/ui/layout/<Root>.json: nodes
// with local positions in NGUI units and UISprite / UITexture / UILabel widgets) and builds absolutely positioned DOM:
//   - sprites: Simple / Sliced (9-slice, borders from the atlas) / Tiled, tinted like NGUI (mColor multiplies the
//     mostly white sprite), flipped, sheared by inclineAngle
//   - textures: the game's UITexture images, or per-node overrides
//   - labels: plain text in the page font, sized from the label's font size (italic: a placeholder's slant)
// Depth becomes z-index; NGUI y points up, the stage's y points down.
import { spriteUrl } from "./api.js";

const PIVX = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1];
const PIVY = [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1]; // fraction of the height above the pivot
// measured for the page font (Resource Han Rounded): ascent 1.16, descent 0.29, CJK ink 0.84 above to 0.09 below the
// baseline, so in a 1.15 line box the ink centre is 0.06 em low
const GLYPH_LIFT = 0.06;
// Latin glyphs of this font are small next to its CJK glyphs and read low (lowercase mass sits on the baseline): text
// without CJK is drawn 12 % larger and lifted a little more. Measuring goes through textWidth, so layout agrees.
const LATIN_SCALE = 1.12, LATIN_LIFT = 0.085;
// CJK here: Han, kana, CJK punctuation and full-width forms, and Hangul (syllables, jamo, compatibility jamo)
const isLatin = (str) => !/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(str);
export const fontSizeFor = (str, fs) => fs * (isLatin(str) ? LATIN_SCALE : 1);
const measureCtx = document.createElement("canvas").getContext("2d");
// the page font stack of the UI language (app.css --font, chosen by the html lang), read again when the lang changes
let stackLang = null, stack = "RHR, sans-serif";
function fontStack() {
  const lang = document.documentElement.lang;
  if (lang !== stackLang) {
    stackLang = lang;
    stack = getComputedStyle(document.documentElement).getPropertyValue("--font").trim() || "RHR, sans-serif";
  }
  return stack;
}
export function textWidth(str, fs) {
  measureCtx.font = `500 ${fontSizeFor(str, fs)}px ${fontStack()}`;
  return Math.max(...String(str).split("\n").map((l) => measureCtx.measureText(l).width));
}

let index = null, textures = null, initDone = null;
const images = new Map(), tints = new Map();

// the atlas and texture indexes, fetched once however many callers wait for them (the loading screen asks first)
export function init() {
  initDone ||= Promise.all([
    fetch("/asset/ui/atlases.json").then((r) => (r.ok ? r.json() : {})),
    fetch("/asset/ui/textures.json").then((r) => (r.ok ? r.json() : {})),
  ]).then(([a, t]) => { [index, textures] = [a, t]; }, (err) => { initDone = null; throw err; });
  return initDone;
}

export function load(url) {
  if (!images.has(url)) {
    images.set(url, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { images.delete(url); reject(new Error(url)); };
      img.src = url;
    }));
  }
  return images.get(url);
}

// canvases become in-memory blob URLs (never written anywhere)
const canvasUrl = (c) => new Promise((resolve) => c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : c.toDataURL())));

// multiply the image by the tint colour, keeping its alpha (alpha of the tint is applied as opacity)
export async function tinted(url, hex) {
  if (hex === "#ffffff") return url;
  const key = `${url}|${hex}`;
  if (!tints.has(key)) {
    tints.set(key, load(url).then((img) => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = "multiply";
      g.fillStyle = hex;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(img, 0, 0);
      return canvasUrl(c);
    }));
  }
  return tints.get(key);
}

// draw a sliced sprite at its final pixel size (x2 for sharp edges on HiDPI) into a single image
const baked = new Map();
function slicedImage(url, b, wpx, hpx, bs) {
  const key = `${url}|${b.join(",")}|${wpx.toFixed(1)}x${hpx.toFixed(1)}|${bs.toFixed(3)}`;
  if (!baked.has(key)) {
    baked.set(key, load(url).then((img) => {
      const k = 2, W = Math.max(1, Math.round(wpx * k)), H = Math.max(1, Math.round(hpx * k));
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      const [t, r, bo, l] = b, sw = img.naturalWidth, sh = img.naturalHeight;
      // destination borders: sprite pixels times the stage scale, shrunk together if they overlap
      let dl = l * bs * k, dr = r * bs * k, dt = t * bs * k, db = bo * bs * k;
      if (dl + dr > W) { const f = W / (dl + dr); dl *= f; dr *= f; }
      if (dt + db > H) { const f = H / (dt + db); dt *= f; db *= f; }
      dl = Math.round(dl); dr = Math.round(dr); dt = Math.round(dt); db = Math.round(db);
      const xs = [[0, l, 0, dl], [l, sw - r, dl, W - dr], [sw - r, sw, W - dr, W]];
      const ys = [[0, t, 0, dt], [t, sh - bo, dt, H - db], [sh - bo, sh, H - db, H]];
      for (const [sx0, sx1, dx0, dx1] of xs) {
        for (const [sy0, sy1, dy0, dy1] of ys) {
          if (sx1 <= sx0 || sy1 <= sy0 || dx1 <= dx0 || dy1 <= dy0) continue;
          g.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
        }
      }
      return canvasUrl(c);
    }));
  }
  return baked.get(key);
}

// halve repeatedly with smoothing until the image is at most twice its drawn size (x2 for HiDPI)
const scaled = new Map();
function downscaled(url, wpx, hpx) {
  const key = `${url}|${Math.round(wpx)}x${Math.round(hpx)}`;
  if (!scaled.has(key)) {
    scaled.set(key, load(url).then((img) => {
      let w = img.naturalWidth, h = img.naturalHeight;
      // small icons get 3x so their edges stay smooth on HiDPI screens
      const k = Math.max(wpx, hpx) < 120 ? 3 : 2;
      const tw = Math.max(1, Math.round(wpx * k)), th = Math.max(1, Math.round(hpx * k));
      if (w <= tw * 1.5 && h <= th * 1.5) return url;
      let src = img;
      while (w / 2 >= tw && h / 2 >= th) {
        const c = document.createElement("canvas");
        c.width = Math.round(w / 2); c.height = Math.round(h / 2);
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(src, 0, 0, c.width, c.height);
        src = c; w = c.width; h = c.height;
      }
      const c = document.createElement("canvas");
      c.width = tw; c.height = th;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(src, 0, 0, tw, th);
      return canvasUrl(c);
    }));
  }
  return scaled.get(key);
}

const colorOf = (c) => {
  const [hex, a] = (c || "#ffffff/1.00").split("/");
  return { hex: hex.toLowerCase(), a: Number(a ?? 1) };
};

// opts: scale (stage px per unit), origin [x, y] (stage px of the root's origin),
//       on / off (node names or paths to force), shift { name|path: [dx, dy] units },
//       texts { name|path: text }, textures { name|path: url }, textureNames { texture name: url },
//       styles { name|path: css }, rootPath (prefix used in paths), z (z-index offset)
// Resolves with { nodes, scale, origin, pictures }: pictures are the clipImage pictures still being made (thumbnails),
// each a promise settled once it is in.
export async function render(tree, host, opts = {}) {
  await init();
  const S = opts.scale ?? 1920 / 2960;
  const [ox, oy] = opts.origin ?? [960, 540];
  const on = new Set(opts.on || []), off = new Set(opts.off || []);
  const pick = (map, name, path) => (map ? map[path] ?? map[name] : undefined);
  const nodes = new Map();
  const jobs = [], post = [], pictures = [];

  function walk(n, px, py, sx, sy, alpha, path) {
    const p = path ? `${path}/${n.name}` : n.name;
    const active = (n.active || on.has(n.name) || on.has(p)) && !off.has(n.name) && !off.has(p);
    if (!active) return;
    const shift = pick(opts.shift, n.name, p) || [0, 0];
    const x = px + (n.pos[0] + shift[0]) * sx, y = py + (n.pos[1] + shift[1]) * sy;
    const nsx = sx * n.scale[0], nsy = sy * n.scale[1];
    const entry = { node: n, x, y, els: [], stage: [ox + x * S, oy - y * S] };
    nodes.set(p, entry);
    let a = alpha;
    for (const w of n.widgets) {
      if (!("w_" in w)) continue;
      const col = colorOf(w.color);
      if ("sprite" in w || "texture" in w || "text" in w || "clipImage" in w) {
        const el = widget(n, w, p, x, y, nsx, nsy, col, alpha);
        if (el) entry.els.push(el);
      }
      a = alpha * col.a; // NGUI widgets pass their alpha on to child widgets
    }
    for (const c of n.children || []) walk(c, x, y, nsx, nsy, a, p);
  }

  function widget(n, w, p, x, y, sx, sy, col, alpha) {
    const ww = w.w_ * sx, hh = w.h_ * sy;
    const left = x - PIVX[w.pivot ?? 4] * ww, top = y + PIVY[w.pivot ?? 4] * hh;
    const el = document.createElement("div");
    el.className = `ngui ${n.name.replace(/\W+/g, "_")}`;
    el.dataset.path = p;
    Object.assign(el.style, {
      position: "absolute", left: `${(ox + left * S).toFixed(2)}px`, top: `${(oy - top * S).toFixed(2)}px`,
      width: `${(ww * S).toFixed(2)}px`, height: `${(hh * S).toFixed(2)}px`,
      zIndex: String((opts.z || 0) + (w.depth || 0)), opacity: String(alpha * col.a), pointerEvents: "none",
    });
    const transforms = [];
    if (w.incline && Math.abs(w.incline) > 0.01) transforms.push(`skewX(${-w.incline}deg)`);
    if (w.flip === 1 || w.flip === 3 || w.flip === 2) transforms.push(`scale(${w.flip === 1 || w.flip === 3 ? -1 : 1}, ${w.flip >= 2 ? -1 : 1})`);
    if (transforms.length) el.style.transform = transforms.join(" ");

    if ("clipImage" in w) {
      // an upright picture in a sheared, rounded window (stands in for NGUI panel clipping)
      const r = (w.radius || 0) * S * Math.abs(sy);
      Object.assign(el.style, { overflow: "hidden", borderRadius: `${r.toFixed(1)}px` });
      const pic = document.createElement("div");
      const inc = w.incline || 0;
      Object.assign(pic.style, {
        position: "absolute", left: w.imgLeft || "-15%", top: w.imgTop || "0", width: w.imgWidth || "130%", height: w.imgHeight || "100%",
        backgroundSize: w.imgSize || "cover", backgroundPosition: w.imgPosition || "center 20%",
        backgroundRepeat: "no-repeat", transform: inc ? `skewX(${inc}deg)` : "",
        ...(w.imgMask ? { webkitMaskImage: w.imgMask, maskImage: w.imgMask } : {}),
      });
      const src = w.clipImage;
      if (src) {
        // a URL, or a promise of one (a thumbnail being rendered): thumbnails fill in when ready, render() does not
        // wait. One that comes in after the first frames fades in instead of popping.
        const t0 = performance.now();
        Object.assign(pic.style, { opacity: "0", transition: "opacity .25s ease" });
        const done = Promise.resolve(src).then((u) => (u && w.tint ? tinted(u, w.tint) : u)).then((u) => {
          if (!u) return;
          pic.style.backgroundImage = `url("${u}")`;
          if (performance.now() - t0 < 50) pic.style.transition = "none";
          pic.style.opacity = "1";
        }).catch(() => {});
        if (typeof src === "string") jobs.push(done);
        else pictures.push(done);
      }
      el.appendChild(pic);
    } else if ("text" in w) {
      const text = pick(opts.texts, n.name, p) ?? w.text;
      if (!text) return null;
      const align = [, "left", "center", "right", "justify"][w.align] || ["left", "center", "right"][(w.pivot ?? 4) % 3];
      Object.assign(el.style, {
        display: "flex", alignItems: ["flex-start", "center", "flex-end"][Math.floor((w.pivot ?? 4) / 3)],
        justifyContent: { left: "flex-start", center: "center", right: "flex-end", justify: "center" }[align],
        color: col.hex, fontSize: `${(fontSizeFor(text, w.fontSize || 40) * sy * S).toFixed(2)}px`, lineHeight: "1.15", whiteSpace: "pre", textAlign: align,
        fontStyle: w.italic ? "italic" : "",
        paddingBottom: `${(fontSizeFor(text, w.fontSize || 40) * sy * S * (isLatin(text) ? LATIN_LIFT : GLYPH_LIFT) * 2).toFixed(2)}px`,
      });
      if (w.ellipsis) {
        const span = document.createElement("span");
        Object.assign(span.style, { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" });
        span.textContent = text;
        el.appendChild(span);
      } else {
        el.textContent = text;
      }
    } else if ("sprite" in w) {
      if (w.sprite === "Common_Empty") return null;
      const atlas = w.atlas || "Common", meta = index?.[atlas]?.[w.sprite];
      if (!meta) return null;
      jobs.push(tinted(spriteUrl(atlas, w.sprite), col.hex).then((url) => {
        const b = [meta.borderTop, meta.borderRight, meta.borderBottom, meta.borderLeft].map((v) => v || 0);
        // like NGUI, shrink borders that overlap (e.g. 30 + 30 on a 55 px sprite) so the centre survives
        const fitB = (i, j, size) => {
          if (b[i] + b[j] >= size) { const f = (size - 1) / (b[i] + b[j]); b[i] = Math.floor(b[i] * f); b[j] = Math.floor(b[j] * f); }
        };
        fitB(0, 2, meta.height);
        fitB(1, 3, meta.width);
        if (w.type === 1 && b.some(Boolean)) {
          return slicedImage(url, b, ww * S, hh * S, S * Math.min(Math.abs(sx), Math.abs(sy))).then((img) => {
            Object.assign(el.style, { backgroundImage: `url("${img}")`, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" });
          });
        } else if (w.type === 2) {
          Object.assign(el.style, { backgroundImage: `url("${url}")`, backgroundRepeat: "repeat", backgroundSize: `${meta.width * S}px ${meta.height * S}px` });
        } else {
          // simple sprites keep their own aspect unless told to stretch (NGUI stretches; game widgets are sized to match)
          return downscaled(url, ww * S, hh * S).then((small) => {
            Object.assign(el.style, { backgroundImage: `url("${small}")`, backgroundSize: w.keepAspect ? "contain" : "100% 100%", backgroundPosition: "center", backgroundRepeat: "no-repeat" });
          });
        }
        return null;
      }).catch(() => {}));
    } else {
      el.dataset.tex = w.texture;
      const override = pick(opts.textures, n.name, p) ?? opts.textureNames?.[w.texture];
      const src = override || textures?.[w.texture] || null;
      if (!src) return null;
      const done = Promise.resolve(src).then((u) => (override ? u : tinted(u, col.hex)))
        .then((url) => (!url || url.startsWith("data:image/svg") ? url : downscaled(url, ww * S, hh * S))).then((url) => {
          if (url) Object.assign(el.style, { backgroundImage: `url("${url}")`, backgroundSize: "100% 100%", backgroundRepeat: "no-repeat" });
        }).catch(() => {});
      if (typeof src === "string") jobs.push(done); // a pending thumbnail fills in later
    }
    const css = pick(opts.styles, n.name, p);
    if (css) post.push([el, css]); // applied after the images are in, so it can override them
    host.appendChild(el);
    return el;
  }

  walk(tree, 0, 0, 1, 1, 1, opts.rootPath || "");
  await Promise.all(jobs);
  for (const [el, css] of post) el.style.cssText += css;
  return { nodes, scale: S, origin: [ox, oy], pictures };
}

// find a subtree by path ("A/B/C", relative to the given node)
export function find(tree, path) {
  let n = tree;
  for (const part of path.split("/").filter(Boolean)) {
    n = (n.children || []).find((c) => c.name === part);
    if (!n) return null;
  }
  return n;
}

// the first node with this name, depth first
export function findNamed(tree, name) {
  if (tree.name === name) return tree;
  for (const c of tree.children || []) {
    const hit = findNamed(c, name);
    if (hit) return hit;
  }
  return null;
}

// "Root" or "Root.Node": a prefab root, or the first node of that name inside it
const layouts = new Map();
export function layout(name) {
  if (!layouts.has(name)) {
    const [root, sub] = name.split(".");
    layouts.set(name, fetch(`/asset/ui/layout/${encodeURIComponent(root)}.json`).then((r) => {
      if (!r.ok) throw new Error(`layout ${root}: HTTP ${r.status}`);
      return r.json();
    }).then((tree) => (sub ? findNamed(tree, sub) : tree)));
  }
  return layouts.get(name);
}

// stage rectangle [left, top, width, height] of an element made by render()
export const rect = (el) => ["left", "top", "width", "height"].map((k) => parseFloat(el.style[k]));

// a plain node, for building widgets by hand: node("Name", [x, y], [widget], [children])
export const node = (name, pos, widgets = [], children = [], scale = [1, 1]) => ({ name, active: true, pos, scale, rotZ: 0, widgets, children });
export const sprite = (name, w, h, opts = {}) => ({ sprite: name, atlas: "Common", type: 1, w_: w, h_: h, pivot: 4, depth: 5, color: "#ffffff/1.00", incline: 0, flip: 0, ...opts });
export const label = (text, fontSize, color, w, h, opts = {}) => ({ cls: "UILabel", text, fontSize, color, w_: w, h_: h, pivot: 4, depth: 9, align: 0, ...opts });

// glyph extent: a closing full-width bracket or corner bracket is mostly blank on the right
export const glyphWidth = (str, fs) => Math.max(...String(str).split("\n").map((l) => textWidth(l, fs) - (/[\uff09\u300d]$/.test(l) ? fs * 0.45 : 0)));
// fit text into maxW: shrink from fsMax to fsMin on one line; if it still does not fit, break into up to maxLines lines
// at the smallest size that fits. Breaks go at separators (full-width comma and enumeration comma, ", ", " - ", spaces,
// before brackets) first, then between CJK
// words; closing punctuation never starts a line. Wrapped text is never larger than fsMin.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/;
function tokensOf(str, cjkBreaks) {
  let tokens = String(str).split(/(?<=[\uff0c\u3001]|, | - |\s)|(?=[\uff08(])/).filter(Boolean);
  // CJK runs break between words (Intl.Segmenter), so a compound such as "add memorial lobby" wraps between its words, not inside one
  const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(document.documentElement.lang || "zh", { granularity: "word" }) : null;
  if (cjkBreaks) tokens = tokens.flatMap((tok) => (!CJK.test(tok) ? [tok] : seg ? [...seg.segment(tok)].map((x) => x.segment)
    : tok.match(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]|[^\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]+/g)));
  const merged = [];
  for (const tok of tokens) {
    if (merged.length && /^[\uff0c\u3001\uff09\u300d\u3002,.)]/.test(tok)) merged[merged.length - 1] += tok;
    else merged.push(tok);
  }
  return merged;
}
function breakLines(tokens, fs, maxW) {
  const lines = [];
  let cur = "";
  for (const tok of tokens) {
    const next = cur + tok;
    if (cur && glyphWidth(next.trimEnd(), fs) > maxW) { lines.push(cur.trimEnd()); cur = tok.trimStart(); } else cur = next;
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}
export function fitText(str, fsMax, fsMin, maxW, maxLines = 2) {
  str = String(str ?? "");
  for (let fs = fsMax; fs >= fsMin; fs -= 2) if (glyphWidth(str, fs) <= maxW) return { text: str, fs, lines: 1 };
  for (const cjkBreaks of [false, true]) {
    const tokens = tokensOf(str, cjkBreaks);
    for (let fs = fsMin; fs >= fsMin - 8; fs -= 2) {
      let lines = breakLines(tokens, fs, maxW);
      if (lines.length > 1 && lines.length <= maxLines && lines.every((l) => glyphWidth(l, fs) <= maxW)) {
        // balance: the narrowest width that still gives the same number of lines (no lone character on the last line)
        let lo = 0, hi = maxW;
        while (hi - lo > 2) {
          const mid = (lo + hi) / 2, tryLines = breakLines(tokens, fs, mid);
          if (tryLines.length === lines.length && tryLines.every((l) => glyphWidth(l, fs) <= mid)) hi = mid; else lo = mid;
        }
        lines = breakLines(tokens, fs, hi);
        return { text: lines.join("\n"), fs, lines: lines.length };
      }
    }
  }
  return { text: str, fs: fsMin - 8, lines: 1 };
}
