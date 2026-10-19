// A lobby skeleton drawn in parts, the way Unity draws it. spine-unity gives each submesh the material of its atlas
// page, and Unity sorts every submesh by its own material's render queue: a skeleton whose pages sit in several queues
// (lobby.json layer "pages") draws one part per queue, lowest first, each part the slots on its pages in draw order,
// and what sorts between two queues (particle effects, particles-gl.js) draws in between. Hibiki's background page
// (2900) is drawn, then her river surface effect (3000), then her own page (3050); Kisaki's front mist page (3200) goes
// over her (3100) wherever its slots sit in the draw order.
import { queuesOf } from "./particles.js";

// an attachment's atlas page by the name the prefab gives it (the page's file name without its extension), or null
// for an attachment without one (clipping, bounding boxes, points)
export function pageOf(attachment) {
  const name = attachment?.region?.page?.name;
  return name ? name.replace(/\.[^./]+$/, "") : null;
}

// a layer's parts: how many, and the part of a page (by name); a page the prefab does not list draws with the
// layer's own queue
export function partsOf(layer) {
  const queues = queuesOf(layer), byPage = new Map();
  for (const [page, queue] of Object.entries(layer?.pages || {})) byPage.set(page, queues.indexOf(queue));
  const own = Math.max(0, queues.indexOf(layer?.queue));
  return { count: queues.length, of: (page) => byPage.get(page) ?? own };
}

// draw(part) for every part in turn, with the slots of the other parts' pages emptied for the call and given their
// attachment back after it (a slot without a page, a clipping attachment's included, takes part in every one: its
// clipping still applies to the slots it covers); between(part) after each part but the last
export function drawInParts(skeleton, parts, draw, between = () => {}) {
  if (!(parts?.count > 1)) { draw(0); return; }
  const slots = skeleton.drawOrder;
  const part = slots.map((slot) => { const page = pageOf(slot.attachment); return page === null ? -1 : parts.of(page); });
  for (let k = 0; k < parts.count; k++) {
    const emptied = [];
    slots.forEach((slot, i) => {
      if (part[i] >= 0 && part[i] !== k) { emptied.push([slot, slot.attachment]); slot.attachment = null; }
    });
    try {
      draw(k);
    } finally {
      for (const [slot, attachment] of emptied) slot.attachment = attachment;
    }
    if (k < parts.count - 1) between(k);
  }
}
