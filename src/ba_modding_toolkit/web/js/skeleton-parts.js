// A lobby skeleton drawn in parts, the way Unity draws it. spine-unity gives each submesh the material of its atlas
// page, and Unity sorts every submesh by its own material's render queue: a skeleton whose pages sit in several queues
// (lobby.json layer "pages") draws one part per queue, lowest first, each part the slots on its pages in draw order,
// and what sorts between two queues (particle effects, particles-gl.js) draws in between. Hibiki's background page
// (2900) is drawn, then her river surface effect (3000), then her own page (3050); Kisaki's front mist page (3200) goes
// over her (3100) wherever its slots sit in the draw order.
import { queuesOf } from "./particles.js";

// an attachment's atlas page by the name the prefab gives it (the page's file name without its extension), or null
// for an attachment without one (clipping, bounding boxes, points)
const pageNames = new WeakMap(); // atlas page -> its name without the extension, worked out once
export function pageOf(attachment) {
  const page = attachment?.region?.page;
  if (!page?.name) return null;
  let name = pageNames.get(page);
  if (name === undefined) pageNames.set(page, (name = page.name.replace(/\.[^./]+$/, "")));
  return name;
}

// a layer's parts: how many, and the part of a page (by name); a page the prefab does not list draws with the
// layer's own queue
export function partsOf(layer) {
  const queues = queuesOf(layer), byPage = new Map();
  for (const [page, queue] of Object.entries(layer?.pages || {})) byPage.set(page, queues.indexOf(queue));
  const own = Math.max(0, queues.indexOf(layer?.queue));
  return { count: queues.length, of: (page) => byPage.get(page) ?? own };
}

// draw() with only part k drawn: the slots of the other parts' pages emptied for the call and given their attachment
// back after it (a slot without a page, a clipping attachment's included, takes part in every one: its clipping still
// applies to the slots it covers). A skeleton of one part is drawn as it is.
export function drawPart(skeleton, parts, k, draw) {
  if (!(parts?.count > 1)) { draw(); return; }
  const emptied = [];
  for (const slot of skeleton.drawOrder) {
    const page = pageOf(slot.attachment);
    if (page !== null && parts.of(page) !== k) { emptied.push([slot, slot.attachment]); slot.attachment = null; }
  }
  try {
    draw();
  } finally {
    for (const [slot, attachment] of emptied) slot.attachment = attachment;
  }
}

// draw(part) for every part in turn (drawPart); between(part) after each part but the last
export function drawInParts(skeleton, parts, draw, between = () => {}) {
  if (!(parts?.count > 1)) { draw(0); return; }
  for (let k = 0; k < parts.count; k++) {
    drawPart(skeleton, parts, k, () => draw(k));
    if (k < parts.count - 1) between(k);
  }
}
