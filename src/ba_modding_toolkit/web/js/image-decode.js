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

// Share overlapping decode work and retain a bounded set of image objects. A
// retained image still rechecks decode readiness when requested again: WebKit
// may discard decoded pixels while a view is hidden. No assets are written out.
export function imageDecoder(create, { maxBytes = 32 * 1024 * 1024, maxEntries = 256 } = {}) {
  const images = new Map();
  let bytes = 0;
  const trim = () => {
    for (const [url, entry] of images) {
      if (bytes <= maxBytes && images.size <= maxEntries) break;
      if (entry.pending) continue;
      images.delete(url);
      bytes -= entry.bytes;
    }
  };
  return (url) => {
    let entry = images.get(url);
    if (entry) { images.delete(url); images.set(url, entry); }
    else {
      const image = create();
      image.src = url;
      entry = { image, pending: null, bytes: 0 };
      images.set(url, entry);
    }
    if (entry.pending) return entry.pending;
    entry.pending = Promise.resolve().then(() => entry.image.decode()).then(() => {
      bytes -= entry.bytes;
      entry.bytes = Math.max(1, entry.image.naturalWidth || 0) * Math.max(1, entry.image.naturalHeight || 0) * 4;
      bytes += entry.bytes;
    }).catch((error) => {
      if (images.get(url) === entry) { images.delete(url); bytes -= entry.bytes; }
      throw error;
    }).finally(() => { entry.pending = null; trim(); });
    return entry.pending;
  };
}

// Resolve true only when every picture decoded successfully. Failures settle
// without hanging the screen, but must not publish an incomplete loading word.
export function decodeAll(urls, decode, cap = Infinity, { signal } = {}) {
  const all = Promise.all(urls.map((url) => Promise.resolve().then(() => decode(url)).then(() => true, () => false)))
    .then((results) => results.every(Boolean));
  if (!Number.isFinite(cap) && !signal) return all;
  let timer = 0;
  let cancel;
  const late = new Promise((resolve) => {
    cancel = () => { clearTimeout(timer); resolve(false); };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener("abort", cancel, { once: true });
    if (Number.isFinite(cap)) timer = setTimeout(resolve, Math.max(0, cap), false);
  });
  return Promise.race([all, late]).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); });
}
