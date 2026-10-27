// Feature pages on the notice frame: /asset/ui/layout/UIPopup_Sort.json (Base/BG, Btn_Close, Btn_Cancel, Btn_Ok).
// Optional images are bundled illustrations of App UI only. Text-only pages need no capture, renderer or download.
import * as NGUI from "./ngui.js";
import * as Popup from "./popup.js";
import * as Buttons from "./game-buttons.js";
import { rpc } from "./api.js";
import { T } from "./i18n.js";
import { S, wrapPath } from "./util.js";

const { node, label, sprite, find } = NGUI;
export const GEOMETRY = { width: 2458, height: 1400, image: [-1000, -400, 2000, 500] };
let active = null;
const shown = new Set();
const paint = () => new Promise((resolve) => (globalThis.requestAnimationFrame || queueMicrotask)(resolve));

function fitCopy(text, max, min, width, limit) {
  let fitted;
  for (let fs = max; fs >= min; fs -= 2) {
    const lines = text.split(/\r?\n/).flatMap((line) => wrapPath(line, fs, fs, width, Infinity).text.split("\n"));
    fitted = { text: lines.join("\n"), fs, lines: lines.length };
    if (lines.length <= limit) return fitted;
  }
  return fitted;
}

function textLayout(page, index, count) {
  return Popup.messageLayout({ ok: true, cancel: true, lines: [
    { text: T("tour.count", { page: index + 1, total: count }), fontSize: 40, minFontSize: 40, color: "#506e8e" },
    { text: page.title },
    { text: page.body, fontSize: 48, minFontSize: 40 },
  ] });
}

// A tour keeps the longest localized page's message size; an illustration keeps the original large frame.
export function pageSize(pages) {
  if (pages.some((page) => page.image)) return GEOMETRY;
  const layouts = pages.map((page, index) => textLayout(page, index, pages.length));
  return { width: layouts[0].width, height: Math.max(...layouts.map((layout) => layout.height)) };
}

// Every caption wraps before shrinking within the popup's range; sibling controls use one font size.
export function pageTree(page, index, count, size = pageSize([page])) {
  const previous = T("tour.previous"), next = T(index === count - 1 ? "tour.finish" : "tour.next");
  const tree = Popup.popupFrame(`${T("tour.title")} - ${page.version}`, size.width, size.height,
    { cancel: previous, ok: next });
  const popup = find(tree, "Popup"), controls = find(popup, "Btn");
  find(controls, "Btn_Ok").actionSemantic = index === count - 1 ? "finish" : "navigation";
  const fs = Math.min(...[previous, next].map((text) => wrapPath(text, 64, 40, 400, 2).fs));
  for (const [name, text] of [["Btn_Cancel", previous], ["Btn_Ok", next]]) {
    const fitted = wrapPath(text, fs, fs, 400, 2);
    Object.assign(find(controls, `${name}/Label_Locale`).widgets[0], { text: fitted.text, fontSize: fs, w_: 420 });
  }
  if (index === 0) controls.children[controls.children.findIndex((child) => child.name === "Btn_Cancel")] = Buttons.disable(find(controls, "Btn_Cancel"));
  find(popup, "Base/BG/Label_Title_Locale").widgets[0].h_ = 100;
  if (!size.image) {
    const { body, y0 } = textLayout(page, index, count);
    const names = ["Count", "FeatureTitle", "FeatureBody"];
    body.tree.children.forEach((child, i) => { child.name = names[i]; child.pos[1] += y0; });
    popup.children.push(...body.tree.children);
    return tree;
  }
  const title = fitCopy(page.title, 52, 44, 2100, 2);
  const body = fitCopy(page.body, 48, 40, 2100, 3);
  const bodyHeight = body.lines * body.fs * 1.3 + 12;
  const illustrated = page.image && bodyHeight <= 200;
  popup.children.push(
    node("Count", [0, 520], [label(T("tour.count", { page: index + 1, total: count }), 40, "#506e8e/1.00", 500, 70, { depth: 8 })]),
    node("FeatureTitle", [0, illustrated ? 405 : 300], [label(title.text, title.fs, "#2d4664/1.00", 2100, title.lines * title.fs * 1.3 + 12, { depth: 8 })]),
    node("FeatureBody", [0, illustrated ? 220 : -40], [label(body.text, body.fs, "#2d4664/1.00", 2100, bodyHeight, { depth: 8 })]),
  );
  if (illustrated) {
    popup.children.push(node("ImageSlot", [0, -150], [sprite("Common_Bg_Raius10px", 2000, 500, { depth: 5, color: "#ecf5f9/1.00" })]));
    const caption = fitCopy(page.caption || "", 40, 40, 2100, 1);
    popup.children.push(node("Caption", [0, -445], [label(caption.text, caption.fs, "#506e8e/1.00", 2100, 70, { depth: 8 })]));
  }
  return tree;
}

export function show(pages, versions) {
  if (active) return active;
  const usable = (pages || []).filter((page) => page && typeof page.title === "string" && page.title.trim()
    && typeof page.body === "string" && page.body.trim());
  if (!usable.length) return Promise.resolve(false);
  active = view(usable, versions).finally(() => { active = null; });
  return active;
}

function view(pages, versions) {
  return new Promise((resolve) => {
    const host = document.getElementById("dialog"), layer = document.createElement("div"), before = document.activeElement;
    layer.className = "popup-layer";
    layer.tabIndex = -1;
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-label", T("tour.title"));
    host.appendChild(layer);
    host.hidden = false;
    let index = 0, ended = false, rendering = false, recorded = false, focusables = [];
    const finish = (displayed = recorded) => {
      if (ended) return;
      ended = true;
      layer.remove();
      Popup.closed(host, layer);
      if (!host.children.length) host.hidden = true;
      if (before?.isConnected) before.focus?.({ preventScroll: true });
      resolve(displayed);
    };
    Popup.opened(host, () => finish(), { el: layer, loading: true });
    const move = (delta) => {
      if (ended || rendering) return;
      if (delta > 0 && index === pages.length - 1) { finish(); return; }
      const next = Math.max(0, Math.min(pages.length - 1, index + delta));
      if (next === index) return;
      index = next;
      draw().catch(failed);
    };
    layer.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || Popup.top()?.el !== layer) return;
      if (event.key === "Escape") { event.preventDefault(); finish(); }
      else if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); move(event.key === "ArrowLeft" ? -1 : 1); }
      else if (event.key === "Tab" && focusables.length) {
        event.preventDefault();
        const at = focusables.indexOf(document.activeElement);
        const next = at < 0 ? (event.shiftKey ? focusables.length - 1 : 0)
          : (at + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
        focusables[next].focus?.();
      }
    });
    const failed = (error) => { console.warn("feature tour unavailable", error); finish(false); };
    const draw = async () => {
      rendering = true;
      const page = pages[index], next = document.createElement("div");
      const tree = pageTree(page, index, pages.length, pageSize(pages.filter((candidate) => candidate.version === page.version)));
      const rendered = await NGUI.render(tree, next, { scale: S, origin: [960, 540], z: 10 });
      if (ended) return;
      const previous = Popup.hit(next, rendered, "Center/Popup/Btn/Btn_Cancel/BG (1)", () => move(-1), { name: T("tour.previous"), action: "previous" });
      previous.disabled = index === 0;
      previous.setAttribute("aria-disabled", String(index === 0));
      const forward = Popup.hit(next, rendered, "Center/Popup/Btn/Btn_Ok/BG (1)", () => move(1),
        { name: T(index === pages.length - 1 ? "tour.finish" : "tour.next"), action: "next" });
      const close = Popup.hit(next, rendered, "Center/Popup/Base/BG/Btn_Close", () => finish(), { name: T("display.close"), action: "close" });
      focusables = [previous, forward, close].filter((button) => button && !button.disabled);
      Popup.closable(rendered, host, () => finish(), { el: layer });
      if (find(tree, "Popup/ImageSlot") && typeof page.image === "string" && /^\/tours\/[A-Za-z0-9_-]+\.png$/.test(page.image)) {
        const image = document.createElement("img");
        const [left, bottom, width, height] = GEOMETRY.image;
        Object.assign(image.style, { position: "absolute", left: `${960 + left * S}px`, top: `${540 - (bottom + height) * S}px`,
          width: `${width * S}px`, height: `${height * S}px`, objectFit: "contain", zIndex: 40 });
        image.alt = page.caption || page.title;
        image.onerror = () => image.remove(); // An optional missing image never delays text or controls.
        image.src = page.image;
        next.appendChild(image);
      }
      layer.replaceChildren(...next.childNodes);
      layer.style.visibility = "";
      layer.inert = false;
      layer.focus?.({ preventScroll: true });
      rendering = false;
      // Acknowledgement follows the first painted page, never a prefab load or a failed pre-render.
      await paint();
      await paint();
      if (!ended && !recorded) {
        recorded = true;
        for (const version of versions) shown.add(version);
        rpc("app.tourPresented", { versions }).catch((error) => console.warn("feature tour history", error));
      }
    };
    Popup.ready().then(() => { if (!ended) return draw(); }).catch(failed);
  });
}

// Called after first-screen reveal and the startup sequence. Existing dialogs/jobs retain priority; no network check.
export async function start({ info, ready, blocked = () => false }) {
  if (!info?.gameFound || info.safeMode) return;
  await ready;
  const result = await rpc("app.tours", { launching: true });
  if (!result?.automatic?.pages?.length) return;
  await Popup.whenIdle(200, blocked);
  // A manual replay while waiting may already have consumed this pending presentation.
  const fresh = await rpc("app.tours", { launching: true });
  const automatic = fresh?.automatic;
  if (!automatic?.pages?.length || automatic.versions.every((version) => shown.has(version))) return;
  await Popup.whenIdle(200, blocked);
  return show(automatic.pages, automatic.versions);
}

export async function browse() {
  const result = await rpc("app.tours");
  const tours = result?.tours || [];
  return Popup.message({ title: T("tour.title"), width: 2458, scroll: true, plain: true,
    lines: tours.length ? tours.map((tour) => ({ text: `${tour.version} - ${tour.pages.map((page) => page.title).join(T("tour.separator"))}`,
      button: { label: T("tour.open"), fn: () => show(tour.pages, [tour.version]) } })) : [T("tour.empty")],
    cancel: T("display.close") });
}
