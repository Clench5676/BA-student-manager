// Align original game sprite ink with the visible body of its native inclined button.
import * as NGUI from "./ngui.js";
import { spriteUrl } from "./api.js";

const metrics = new Map();
export function inkBounds({ width, height, data }, body = false, alphaCutoff = 128) {
  let left = width, top = height, right = 0, bottom = 0;
  let weight = 0, weightedX = 0, weightedY = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4;
    if (data[at + 3] < (body ? 192 : alphaCutoff) || (body && Math.min(data[at], data[at + 1], data[at + 2]) < 192)) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    weight += data[at + 3]; weightedX += (x + .5) * data[at + 3]; weightedY += (y + .5) * data[at + 3];
  }
  return { width, height, left: right > left ? left : 0, top: bottom > top ? top : 0,
    right: right > left ? right : width, bottom: bottom > top ? bottom : height,
    centerX: weight ? weightedX / weight : width / 2, centerY: weight ? weightedY / weight : height / 2 };
}
export function fitInk(ink, body, { height = Infinity, maxWidth = Infinity, maxSize = Infinity, rotation = 0, center = "mass" } = {}) {
  const angle = -rotation * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  const width = ink.right - ink.left, tall = ink.bottom - ink.top;
  const rotatedWidth = Math.abs(width * cosine) + Math.abs(tall * sine), rotatedHeight = Math.abs(width * sine) + Math.abs(tall * cosine);
  const scale = Math.min(height / rotatedHeight, maxWidth / rotatedWidth, maxSize / Math.max(rotatedWidth, rotatedHeight));
  const centerX = center === "bounds" ? (ink.left + ink.right) / 2 : ink.centerX;
  const centerY = center === "bounds" ? (ink.top + ink.bottom) / 2 : ink.centerY;
  const dx = (centerX - ink.width / 2) * scale, dy = (centerY - ink.height / 2) * scale;
  return { width: ink.width * scale, height: ink.height * scale,
    left: body.x - ink.width * scale / 2 - (dx * cosine - dy * sine),
    top: body.y - ink.height * scale / 2 - (dx * sine + dy * cosine) };
}
async function pixels(url) {
  const image = await NGUI.load(url), canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
function remember(key, read) {
  if (!metrics.has(key)) {
    metrics.set(key, read().catch((error) => { metrics.delete(key); throw error; }));
    while (metrics.size > 40) metrics.delete(metrics.keys().next().value);
  }
  return metrics.get(key);
}
export async function buttonCenter(background) {
  const bodyUrl = /^url\((?:"([^"]+)"|'([^']+)'|(.+))\)$/.exec(background.style.backgroundImage);
  const source = bodyUrl?.[1] || bodyUrl?.[2] || bodyUrl?.[3];
  const bodyInk = source ? await remember(`body:${source}`, async () => inkBounds(await pixels(source), true)) : null;
  const width = parseFloat(background.style.width), height = parseFloat(background.style.height);
  const dx = bodyInk ? ((bodyInk.left + bodyInk.right) / 2 / bodyInk.width - .5) * width : 0;
  const dy = bodyInk ? ((bodyInk.top + bodyInk.bottom) / 2 / bodyInk.height - .5) * height : 0;
  const skew = Number(/skewX\(([-.\d]+)deg\)/.exec(background.style.transform || "")?.[1] || 0) * Math.PI / 180;
  return { x: parseFloat(background.style.left) + width / 2 + dx + Math.tan(skew) * dy,
    y: parseFloat(background.style.top) + height / 2 + dy };
}
export async function alignIcon(view, path, backgroundPath, options = {}) {
  const entry = view.nodes.get(path), element = entry.els[0], widget = entry.node.widgets.find((item) => "sprite" in item);
  const url = spriteUrl(widget.atlas || "Common", widget.sprite), alphaCutoff = options.alphaCutoff ?? 128;
  const [ink, body] = await Promise.all([
    remember(`icon:${alphaCutoff}:${url}`, async () => inkBounds(await NGUI.spritePixels(widget), false, alphaCutoff)),
    buttonCenter(view.nodes.get(backgroundPath).els[0]),
  ]);
  const fit = fitInk(ink, body, options);
  Object.assign(element.style, Object.fromEntries(Object.entries(fit).map(([key, value]) => [key, `${value}px`])));
  // Source alpha is preserved; original RGB must not darken the common authored foreground tint.
  const mask = `url("${url}")`, color = (options.color || widget.color).split("/")[0];
  Object.assign(element.style, { backgroundImage: "none", backgroundColor: color, maskImage: mask, webkitMaskImage: mask,
    maskSize: "100% 100%", webkitMaskSize: "100% 100%", maskRepeat: "no-repeat", webkitMaskRepeat: "no-repeat",
    opacity: options.enabled === false ? ".4" : "1", transformOrigin: "50% 50%",
    transform: options.rotation ? `rotate(${-options.rotation}deg)` : "" });
}
