// Pictures decoded before a screen shows. WebKit (the app's window on macOS) lets go of what a hidden screen draws:
// the blob images ngui.js bakes (sliced and tinted sprites) have no other user than that screen's elements. When the
// screen shows again, WebKit paints its first frames without those pictures until they are loaded and decoded again:
// the roster came back from the detail screen without its frame, its card frames and the dimming of the cards without
// mods for about 100 ms. A screen about to show waits for decode() of every picture it draws, so its first frame has
// them all. No DOM here: the tests run it in Node.

// cssUrls('url("a"), url(b)') -> ["a", "b"]: the URLs in a CSS image value (an element's style.backgroundImage)
export function cssUrls(value) {
  const out = [];
  for (const m of String(value || "").matchAll(/url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)"'\s]*))\s*\)/g)) {
    const url = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
    if (url) out.push(url);
  }
  return out;
}

// imageUrls(elements) -> the distinct URLs the elements' inline backgrounds draw, in the elements' order
export function imageUrls(elements) {
  const urls = new Set();
  for (const el of elements) for (const url of cssUrls(el?.style?.backgroundImage)) urls.add(url);
  return [...urls];
}

// decodeAll(urls, decode, cap) -> resolves with true once decode(url) has settled for every URL (one that fails counts
// as done: the element shows what it can, as before), or with false after cap ms, whichever comes first
export function decodeAll(urls, decode, cap = Infinity) {
  const all = Promise.all(urls.map((url) => Promise.resolve().then(() => decode(url)).catch(() => {}))).then(() => true);
  if (!Number.isFinite(cap)) return all;
  let timer = 0;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, cap), false); });
  return Promise.race([all, late]).finally(() => clearTimeout(timer));
}
