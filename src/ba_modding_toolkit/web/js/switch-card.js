// The picture's right edge continues behind the labels, with enough contrast throughout the faded colours.
import { withTimeout } from "./async.js";

const FALLBACK = [239, 243, 247], MIN_CONTRAST = 4.5;
const mean = (colours) => [0, 1, 2].map((c) => colours.reduce((sum, rgb) => sum + rgb[c], 0) / colours.length);
const mix = (a, b, t) => a.map((v, c) => v + (b[c] - v) * t);
const rgb = (colour) => `rgb(${colour.map((v) => v.toFixed(3)).join(", ")})`;
const luminance = (colour) => colour.reduce((sum, v, c) => {
  const s = v / 255;
  return sum + [0.2126, 0.7152, 0.0722][c] * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
}, 0);

// Transparent portrait margins carry no colour: use the last painted pixels, then the nearest painted row.
export function edgeColours({ data, width, height }) {
  const rows = Array.from({ length: height }, (_, y) => {
    const sum = [0, 0, 0];
    let weight = 0, count = 0;
    for (let x = width - 1; x >= 0 && count < 4; x--) {
      const i = (y * width + x) * 4, a = data[i + 3] / 255;
      if (!a) continue;
      for (let c = 0; c < 3; c++) sum[c] += data[i + c] * a;
      weight += a;
      count++;
    }
    return weight ? sum.map((v) => v / weight) : null;
  });
  const painted = rows.flatMap((row, y) => row ? [y] : []);
  const filled = rows.map((row, y) => row || (painted.length
    ? rows[painted.reduce((best, next) => Math.abs(next - y) < Math.abs(best - y) ? next : best)] : FALLBACK));
  return filled.map((_, y) => mean(filled.slice(Math.max(0, y - 2), y + 3)));
}

export function cardColours(rows, edge = 0.4) {
  if (!rows.length) rows = [FALLBACK];
  if (rows.length === 1) rows = [rows[0], rows[0]];
  const colours = [...rows, FALLBACK];
  // A component-wise lower bound also covers darker colours between differently coloured gradient stops.
  const low = [0, 1, 2].map((c) => Math.min(...colours.map((row) => row[c])));
  const choice = (light) => {
    const backing = light ? [0, 0, 0] : [255, 255, 255];
    // Leave a channel of headroom beyond rounding for the browser's gradient and compositing steps.
    const bound = (colour) => colour.map((v) => light ? Math.min(255, Math.ceil(v) + 1) : Math.max(0, Math.floor(v) - 1));
    const contrast = (alpha) => light
      ? 1.05 / (Math.max(...colours.map((row) => luminance(bound(mix(row, backing, alpha))))) + 0.05)
      : (luminance(bound(mix(low, backing, alpha))) + 0.05) / 0.05;
    let lo = 0, hi = 1;
    if (contrast(0) >= MIN_CONTRAST) hi = 0;
    else for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (contrast(mid) >= MIN_CONTRAST) hi = mid; else lo = mid;
    }
    return { color: light ? "#ffffff" : "#000000", backing, alpha: Math.ceil(hi * 1000) / 1000, contrast: contrast(0) };
  };
  const choices = [choice(false), choice(true)].sort((a, b) => a.alpha - b.alpha || b.contrast - a.contrast);
  const { color, backing, alpha } = choices[0];
  const stops = rows.map((row, y) => `${rgb(row)} ${((y + 0.5) / rows.length * 100).toFixed(3)}%`);
  // Start both fades at the visible image edge; the backing is complete before the labels on the slanted window.
  const start = (edge * 100).toFixed(3), readable = (Math.max(edge, 0.44) * 100).toFixed(3);
  const backgroundImage = [
    `linear-gradient(90deg, transparent ${start}%, rgba(${backing.join(", ")}, ${alpha}) ${readable}%)`,
    `linear-gradient(90deg, transparent ${start}%, ${rgb(FALLBACK)} 100%)`,
    `linear-gradient(180deg, ${stops.join(", ")})`,
  ].join(", ");
  return { color, backing, alpha, backgroundImage };
}

export async function colourSwitchCard(picture, text, widget, load, { signal, kind = "lobby", background } = {}) {
  if (signal?.aborted) return;
  // the portrait card keeps the prefab's own look: no background picture and no fade
  if (kind === "portrait") return;
  if (kind !== "lobby" && kind !== "model") return;
  const url = await withTimeout(Promise.resolve(widget.clipImage), widget.clipImage?.thumbnail ? Infinity : 15000, "Switch card picture", { signal });
  if (!url) return;
  const image = await withTimeout(load(url, { signal }), 15000, "Switch card colours", { signal }), canvas = document.createElement("canvas");
  if (signal?.aborted) return;
  canvas.width = 64; canvas.height = 24;
  const g = canvas.getContext("2d"), height = parseFloat(picture.style.height), edge = widget.imgEdge ?? 1;
  // Match the visible vertical crop of the upright picture, rather than sampling outside the card's window.
  // The masked tail is hidden: sample where the thumbnail starts fading, not its unseen rightmost pixels.
  g.drawImage(image, 0, 0, image.naturalWidth * edge, image.naturalHeight, 0,
    parseFloat(widget.imgTop) / height * canvas.height, canvas.width, parseFloat(widget.imgHeight) / height * canvas.height);
  const start = (parseFloat(widget.imgLeft) + parseFloat(widget.imgWidth) * edge) / parseFloat(picture.style.width);
  const colours = cardColours(edgeColours(g.getImageData(0, 0, canvas.width, canvas.height)), Number.isFinite(start) ? start : 0.4);
  picture.style.backgroundImage = colours.backgroundImage;
  text.style.color = colours.color;
}
