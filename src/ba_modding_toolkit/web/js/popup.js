// Shared popups on the game's popup frame (UIPopup_Sort), for every screen:
//   - the frame itself (popupFrame), with its backdrop, title, close button and Cancel / OK;
//   - the list popup, laid out like the game's quick formation edit: a card's details on the left, a framed list with
//     the student list's tools on the right (optional), the buttons under it; one card chosen, or several ticked;
//   - the message popup: a title, lines (a line may carry a small button), an optional checkbox (the gacha list's
//     Btn_Checkbox) and up to two buttons; it resolves when it closes, however it closes.
// Popups draw into a host: the detail screen's own (#popup, #picker) or the stage-level ones (#prompt for lists,
// #dialog for messages, both over the settings), so they show on any screen. Every open popup is on one stack:
// Escape goes to the topmost one only, as the game's PopupClose closes the popup in front. A popup that must be
// answered with a button takes Escape and does nothing with it, so nothing under it acts either.
// The pure parts (the stack, the selection, the start sequence) are tested in Node (tests/js/popup.test.mjs).
import * as NGUI from "./ngui.js";
import { T } from "./i18n.js";
import { DOT, RECRUIT, S, TAN10, advanceOf, clone, glyphsOf, hitButton, markedLabel, wrapPath } from "./util.js";

const { node, sprite, label, find, rect } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);
const hostOf = (h) => (typeof h === "string" ? document.getElementById(h) : h);

// --- the prefabs, read once: the frame (required), the student list's tools and the checkbox (each optional: a
// popup without them still works) ---
let layouts = null, loading = null;
const optional = (name) => NGUI.layout(name).catch((err) => { console.warn("popup layout", name, err); return null; });
export function ready() {
  loading ||= Promise.all([NGUI.layout("UIPopup_Sort"), optional("UICharacterCollection"), optional("UIPopup_GachaCharList.Btn_Checkbox")])
    .then(([sortPopup, collection, checkbox]) => { layouts = { sortPopup, collection, checkbox }; }, (err) => { loading = null; throw err; });
  return loading;
}

// --- the stack of open popups ---
// An entry is open while its host is in the page and shows, and its own layer (a host holding several popups) is in
// the page, so a popup closed by hiding its host leaves the stack by itself.
const stack = [];
const live = (e) => e.host.isConnected && !e.host.hidden && (!e.el || e.el.isConnected);
function prune() { for (let i = stack.length - 1; i >= 0; i -= 1) if (!live(stack[i])) stack.splice(i, 1); }

// a popup opened in host (el: its own layer, when the host holds several); close(how) closes it, how being "escape",
// "backdrop" or "close"; null for a popup that must be answered with one of its buttons. Drawing the same popup again
// keeps its place on the stack.
export function opened(host, close, { el = null } = {}) {
  prune();
  const entry = { host, el, close };
  const at = stack.findIndex((e) => e.host === host && e.el === el);
  if (at >= 0) stack[at] = entry; else stack.push(entry);
  return entry;
}
export function closed(host, el = null) {
  const at = stack.findIndex((e) => e.host === host && e.el === el);
  if (at >= 0) stack.splice(at, 1);
}
export function top() { prune(); return stack.at(-1) || null; }
// any popup open: the stack, or a host of the other popups (the consent and update popups, the settings, the display
// settings)
export const anyOpen = () => !!top() || !!document.querySelector(".popup-host:not([hidden]), .consent-host:not([hidden])");
// Holds leave every open popup usable, including stack entries with their own hosts and the consent layers.
// Escape belongs to the popup even when focus is still on the control that opened it.
export function allowsInput(ev) {
  prune();
  return (ev.key === "Escape" && anyOpen())
    || stack.some((e) => (e.el || e.host).contains(ev.target))
    || !!ev.target.closest?.(".popup-host:not([hidden]), .consent-host:not([hidden])");
}
// resolves once no popup is open (the start prompts that come later wait for this)
export function whenIdle(every = 200) {
  return new Promise((resolve) => { const check = () => (anyOpen() ? setTimeout(check, every) : resolve()); check(); });
}

// Escape goes to the topmost popup; not while an input method composes (keyCode 229 is the key that ends a conversion
// in WebKit), nor when a control in the popup took the key itself
export function onKey(ev) {
  if (ev.key !== "Escape" || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return;
  const t = top();
  if (!t) return;
  ev.preventDefault();
  t.close?.("escape");
}
addEventListener("keydown", onKey);

// --- the start sequence: popups one at a time, in order. Each step resolves once its popup has closed, at once when
// it has nothing to show; one that fails is logged and the next one comes ---
export async function sequence(steps) {
  for (const [name, run] of steps) {
    try { await run(); } catch (err) { console.error("start popup", name, err); }
  }
}

// --- the selection of a list popup with several cards ticked: every card that can be ticked is, to start with ---
export const selectable = (items) => new Set(items.filter((it) => !it.disabled).map((it) => it.key));
// the selection with key ticked or unticked; a card that cannot be ticked leaves it as it is
export function toggled(selection, items, key) {
  const it = items.find((x) => x.key === key);
  const next = new Set(selection);
  if (!it || it.disabled) return next;
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}
// the sizes of the ticked cards, added up (bytes)
export const sizeOf = (items, selection) => items.reduce((n, it) => n + (selection.has(it.key) ? it.size || 0 : 0), 0);

// --- hit areas ---
const PIVX = [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1], PIVY = [0, 0, 0, 0.5, 0.5, 0.5, 1, 1, 1];
// a rendered node's stage rectangle: its widget's element, or, for a sprite the atlases lack, worked out from the
// node, so its button still works
export function nodeRect(view, path) {
  const e = view.nodes.get(path);
  if (!e) return null;
  if (e.els[0]) return rect(e.els[0]);
  const w = e.node.widgets.find((x) => "w_" in x);
  if (!w) return null;
  const ww = w.w_ * view.scale, hh = w.h_ * view.scale, p = w.pivot ?? 4;
  return [e.stage[0] - PIVX[p] * ww, e.stage[1] - PIVY[p] * hh, ww, hh];
}
// an invisible button over a rendered node; name: its accessible name (the caption it covers), action: what it does
// (data-action, for checks)
export function hit(host, view, path, fn, { name = "", action = "", z = 80, title = "" } = {}) {
  const r = nodeRect(view, path);
  if (!r) return null;
  const b = hitButton(host, r, fn, title, z);
  if (name) b.setAttribute("aria-label", name);
  if (action) b.dataset.action = action;
  return b;
}

// --- the frame ---
// the game's popup frame at a size: backdrop, title, close button and, when given, its Cancel and OK buttons with
// these labels near the bottom edge (a lone one in the middle). The frame's centre sits 12 units under the stage's
// (Base -20, BG +8).
export const FRAME_Y = -12;
export function popupFrame(title, w, h, { ok = null, cancel = null, close = true } = {}) {
  const t = clone(find(layouts.sortPopup, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: w, h_: h });
  find(bg, "Texture_Top").pos = [-w / 2 + 248, h / 2 - 66];
  const titleNode = find(bg, "Label_Title_Locale");
  const tf = fitText(title, 72, 52, Math.min(1300, w - 400));
  Object.assign(titleNode.widgets[0], { text: tf.text, fontSize: tf.fs, w_: Math.min(1400, w - 300) });
  titleNode.pos = [0, h / 2 - 64];
  find(titleNode, "Line").widgets[0].w_ = glyphsOf(tf.text, tf.fs) + 14;
  const closeBtn = find(bg, "Btn_Close");
  closeBtn.pos = [w / 2 - 90, h / 2 - 60];
  closeBtn.active = close;
  const btn = find(popup, "Btn");
  btn.active = !!(ok || cancel);
  btn.pos = [0, FRAME_Y - h / 2 + 122];
  for (const [name, caption] of [["Btn_Ok", ok], ["Btn_Cancel", cancel]]) {
    const b = find(btn, name);
    b.active = !!caption;
    if (!(ok && cancel)) b.pos = [0, b.pos[1]];
    if (caption) NGUI.fitLabel(find(b, "Label_Locale").widgets[0], caption, 64, 40, 420);
  }
  find(t, "BlackBg/BlackBgClickArea").widgets.find((x) => "sprite" in x).color = "#000000/0.60";
  return t;
}

// a click on a popup's backdrop or Escape closes it, as the game's PopupClose does; its body takes the clicks that
// miss its controls. close null: the popup must be answered with a button (the backdrop and Escape do nothing).
// Puts the popup on the stack.
export function closable(view, host, close, { el = null } = {}) {
  const back = view.nodes.get("Center/BlackBg/BlackBgClickArea")?.els[0];
  if (back) {
    back.style.pointerEvents = "auto";
    if (close) back.addEventListener("click", () => close("backdrop"));
  }
  const body = view.nodes.get("Center/Popup/Base/BG")?.els[0];
  if (body) body.style.pointerEvents = "auto";
  return opened(host, close, { el });
}

// a scrolling card area with the game list's scrollbar colours
export function scrollArea(host, [l, t, w, h], contentH) {
  const area = document.createElement("div");
  area.className = "popup-cards";
  Object.assign(area.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
  const inner = document.createElement("div");
  inner.className = "popup-cards-inner";
  inner.style.height = `${contentH}px`;
  area.appendChild(inner);
  host.appendChild(area);
  if (contentH > h + 1) {
    const bar = document.createElement("div");
    bar.className = "scrollbar";
    Object.assign(bar.style, { left: `${l + w + 8}px`, top: `${t + 6}px`, height: `${h - 12}px` });
    const th = document.createElement("i");
    th.style.height = `${(h - 12) * (h / contentH)}px`;
    th.style.top = "0";
    bar.appendChild(th);
    host.appendChild(bar);
    area.addEventListener("scroll", () => { th.style.top = `${(h - 12 - parseFloat(th.style.height)) * area.scrollTop / (contentH - h)}px`; });
  }
  return inner;
}

// the gacha list's checkbox (Btn_Checkbox: its white plate, the box and its tick, a label after it), at x (its left
// edge), y; the tick shows when on. Without the prefab, the same pieces drawn from its numbers.
const CHECK_H = 104;
function checkbox(name, x, y, caption, on, maxW) {
  const f = fitText(caption, 46, 30, maxW - 131 - 46);
  const w = 131 + glyphsOf(f.text, f.fs) + 46;
  const box = () => node("Check", [-120, 8], [sprite("Common_Bg_Raius10px", 74, 72, { incline: 10, depth: 25, color: "#e4f3f8/1.00" })], [
    node("Line", [0, 0], [sprite("Common_Line_Raius10px", 74, 72, { incline: 10, depth: 30, color: "#96b6c2/1.00" })]),
    node("Icon", [0.4, -1.8], [sprite("Common_Icon_Check_B", 59, 58, { depth: 35 })]),
  ]);
  const cb = layouts.checkbox ? clone(layouts.checkbox)
    : node("Btn_Checkbox", [0, 0], [sprite("Resource_Bg_Radius10px", 798, 110, { incline: 10, pivot: 3, depth: 20 })], [node("Type_ON", [178, -3.2], [], [box()])]);
  cb.name = name;
  cb.pos = [x, y];
  Object.assign(cb.widgets.find((x2) => "sprite" in x2), { w_: w, h_: CHECK_H });
  // one state drawn (Type_ON's box with its tick); the tick is shown or hidden in place
  cb.children = cb.children.filter((c) => c.name === "Type_ON");
  for (const c of cb.children) {
    c.active = true;
    c.children = (c.children || []).filter((k) => k.name === "Check");
    const icon = find(c, "Check/Icon");
    if (icon) icon.active = true;
  }
  cb.children.push(node("Label", [131, 0], [label(f.text, f.fs, "#484e52/1.00", w - 131, 50 * f.lines, { pivot: 3, depth: 31 })]));
  return { tree: cb, w, on };
}
// wires a drawn checkbox: a click flips it (state.checked) and shows or hides the tick
function wireCheck(host, view, path, state, onChange) {
  const tick = view.nodes.get(`${path}/Type_ON/Check/Icon`)?.els[0];
  const show = () => { if (tick) tick.style.visibility = state.checked ? "" : "hidden"; };
  show();
  const b = hit(host, view, path, () => {
    state.checked = !state.checked;
    show();
    b?.setAttribute("aria-checked", String(state.checked));
    onChange?.(state.checked);
  }, { name: state.label, action: "check" });
  if (b) { b.setAttribute("role", "checkbox"); b.setAttribute("aria-checked", String(state.checked)); }
  return b;
}

// --- the list popup ---
const LP = {
  frame: { w: 2860, h: 1520 },                  // Common_Popup_Bg, stretched to almost the whole screen
  left: { l: -1370, r: -520, t: 600, b: -690 }, // details panel
  list: { l: -480, r: 1370, t: 600, b: -470 },  // list panel (light blue frame)
  ok: { x: 1150, y: -600, w: 440, h: 160 },     // confirm
  card: { w: 250, h: 226, bar: 68 },            // card body (Common_Btn_BG) and its name bar
  pitch: [284, 350],
};
const COLS6 = 6;
const BTN_W = 496; // the frame's button body (Common_Btn_BG)

// the student list's tools at the top right of the list: order, sort, search and, with segs, the segment filter
function toolbar(right, y, { segs = null, sortKey = "sort.default", active = 0 } = {}) {
  const menu = find(layouts.collection, "SeletControl/TopMenu");
  const kids = [];
  let x = right;
  const order = clone(find(menu, "OrderBtn"));
  order.pos = [x - 243 / 2 + 45.1, y];
  x -= 243 + 16;
  const sort = clone(find(menu, "SortBtn"));
  const sortW = 420;
  const body = find(sort, "Btn_Normal");
  const shrink = 622 - sortW;
  body.widgets.find((w) => "sprite" in w).w_ = sortW;
  for (const m of ["FilterMarker_Off", "FilterMarker_On"]) {
    const n = find(body, m);
    n.pos[0] += shrink / 2;
    find(n, "Icon").pos[0] -= shrink;
    find(n, "Filter_02").widgets[0].w_ -= shrink;
  }
  find(body, "Icon").pos[0] -= shrink / 2;
  find(body, "Type_1").active = false;
  const type2 = find(body, "Type_2");
  type2.active = true;
  const st = fitText(T(sortKey), 56, 36, sortW - 150);
  Object.assign(find(type2, "Text").widgets[0], { text: st.text, fontSize: st.fs, w_: sortW - 120 });
  find(type2, "Text").pos[0] = 30;
  sort.pos = [x - sortW / 2 + 83, y];
  x -= sortW + 16;
  const search = clone(find(menu, "SearchBtn"));
  search.pos = [x - 150 / 2 - 89, y];
  x -= 150 + 16;
  kids.push(order, sort, search);
  let segBox = null;
  if (segs) {
    const filter = clone(find(menu, "FilterBtn"));
    const segW = 230, sx = segW / 328;
    filter.scale = [sx, 1];
    [["All", segs[0]], ["Main", segs[1]], ["Support", segs[2]]].forEach(([k, key], i) => {
      const seg = find(filter, k);
      for (const state of seg.children) {
        for (const c of state.children || []) {
          const tex = c.widgets.find((w) => "texture" in w);
          if (tex) {
            const f = fitText(T(key), 44, 26, segW - 30);
            c.widgets = [label(f.text, f.fs, tex.color, (segW - 20) / sx, 60, { depth: 9 })];
          }
        }
        state.active = (state.name === "Btn_Pressed") === (i === active);
      }
    });
    filter.pos = [x - 3 * segW + 123 * sx + 164 * sx - 6, y + 50.2];
    segBox = { right: x, segW, y };
    kids.push(filter);
  }
  return { tree: node("Toolbar", [0, 0], [], kids), segBox };
}

// the frame of a list popup: the details panel, the list panel and, under it, the buttons right-aligned to the
// confirm's place (main ones in OK's blue, the others in Cancel's; three or more a little smaller)
function listFrame(title, buttons, closeButton) {
  const t = clone(find(layouts.sortPopup, "Center"));
  const popup = find(t, "Popup");
  popup.children = popup.children.filter((c) => ["Base", "Btn"].includes(c.name));
  const bg = find(popup, "Base/BG");
  Object.assign(bg.widgets[0], { w_: LP.frame.w, h_: LP.frame.h });
  const top = LP.frame.h / 2;
  find(bg, "Texture_Top").pos = [-LP.frame.w / 2 + 248, top - 66];
  const titleNode = find(bg, "Label_Title_Locale");
  const titleFit = fitText(title, 72, 52, 1300);
  Object.assign(titleNode.widgets[0], { text: titleFit.text, fontSize: titleFit.fs, w_: 1400 });
  titleNode.pos = [0, top - 64];
  find(titleNode, "Line").widgets[0].w_ = glyphsOf(titleFit.text, titleFit.fs) + 14;
  const closeBtn = find(bg, "Btn_Close");
  closeBtn.pos = [LP.frame.w / 2 - 90, top - 60];
  closeBtn.active = closeButton;
  const btn = find(popup, "Btn");
  const [ok, cancel] = [find(btn, "Btn_Ok"), find(btn, "Btn_Cancel")];
  btn.pos = [0, 0];
  const k = buttons.length > 2 ? 0.8 : 1, bw = BTN_W * k, gap = 24, right = LP.ok.x + BTN_W / 2;
  btn.children = buttons.map((b, i) => {
    const n = clone(b.primary ? ok : cancel);
    n.name = `Btn_${i}`;
    n.active = true;
    n.scale = [k, k];
    n.pos = [right - bw / 2 - (buttons.length - 1 - i) * (bw + gap), LP.ok.y];
    const f = fitText(b.label, 72, 48, 360);
    Object.assign(find(n, "Label_Locale").widgets[0], { text: f.text, fontSize: f.fs });
    if (b.greyed) {
      find(n, "BG (1)").widgets.find((w) => "sprite" in w).color = "#dfe5ea/1.00";
      find(n, "Label_Locale").widgets[0].color = "#9aa3ad/1.00";
    }
    return n;
  });
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.60";
  const panel = (name, b, tone) => node(name, [(b.l + b.r) / 2, (b.t + b.b) / 2], [sprite("Common_Bg_Raius10px", b.r - b.l, b.t - b.b, { depth: 3, color: tone })]);
  popup.children.push(
    panel("LeftPanel", LP.left, "#ffffff/0.00"),
    panel("ListPanel", LP.list, "#d7eaf4/1.00"),
    node("ListPaper", [(LP.list.l + LP.list.r) / 2, (LP.list.t - 150 + LP.list.b + 16) / 2],
      [sprite("Common_Bg_Raius10px", LP.list.r - LP.list.l - 32, LP.list.t - 150 - LP.list.b - 16, { depth: 4, color: "#f4fcfe/1.00" })]));
  return t;
}

// one card of the list: the game's card body, the picture clipped to its window, a name bar under it. A card that
// cannot be chosen (dim) is darkened like the roster's not-owned cards, its picture without colour; its badge (In Use,
// or the caller's) stays bright.
function listCard(it, x, y, selected) {
  const { w, h, bar } = LP.card;
  const kids = [
    node("Thumb", [1, 4], [{ clipImage: it.thumb, w_: w - 16, h_: h - 26, pivot: 4, depth: 8, incline: 10, radius: 18, color: "#ffffff/1.00", imgSize: "cover", imgPosition: "center 30%" }]),
    node("Line", [1, 4], [sprite("Common_Line_Raius20px", w - 12, h - 18, { incline: 10, depth: 9, color: "#ffffff/1.00" })]),
  ];
  const lbl = markedLabel(it.label, { fs: 34, fsMin: 24, color: "#ffffff/1.00", maxW: w - 56, mark: false, maxLines: 2 });
  const barH = Math.max(bar, 22 + lbl.lines * lbl.fs * 1.2), barY = -h / 2 - 10 - barH / 2;
  kids.push(node("Bar", [barY * TAN10 + 4, barY], [sprite("Common_Bg_Raius10px", w - 22, barH, { incline: 10, depth: 8, color: "#2c4564/1.00" })], [node("Name", [0, 0], [], lbl.nodes)]));
  const corner = (dx, dy) => [dx + dy * TAN10, dy]; // a point inside the slanted card
  if (it.dim) kids.push(node("Dim", [1, 4], [sprite("Common_Bg_Raius10px", w - 12, h - 18, { incline: 10, depth: 24, color: "#000000/0.55" })]));
  const badge = it.badge || (it.inUse ? { text: T("popup.inUse"), color: "#ffbc11", ink: "#3a2a00" } : null);
  if (badge) {
    // as wide as its word needs, from the corner, up to most of the card
    const bf = fitText(badge.text, 26, 20, w - 70, 1), bw = Math.max(116, glyphsOf(bf.text, bf.fs) + 24);
    kids.push(node("Using", corner(-w / 2 + 12 + bw / 2, h / 2 - 30), [sprite("Common_Bg_Raius10px", bw, 42, { depth: 26, color: `${badge.color}/1.00`, incline: 10 })],
      [node("Text", [0, 0], [label(bf.text, bf.fs, `${badge.ink || "#3a2a00"}/1.00`, bw - 4, 40, { depth: 27 })])]));
  }
  if (it.fav) kids.push(node("Pin", corner(w / 2 - 38, -h / 2 + 36), [sprite("Common_Btn_Pin_01", 54, 54, { type: 0, depth: 26 })]));
  if (it.recruit) kids.push(node("Recruit", corner(-w / 2 + 34, -h / 2 + 40), [sprite(RECRUIT.sprite, 62 / RECRUIT.ratio, 62, { atlas: RECRUIT.atlas, type: 0, depth: 26 })]));
  // the new dot goes once the card is picked (it has been seen); the check takes the corner
  if (it.isNew && !selected) kids.push(DOT(corner(w / 2 - 4, h / 2 - 6), 34));
  if (selected) kids.push(node("Select", [1, 4], [sprite("Card_Ability_Select_Line", w + 4, h - 8, { incline: 10, depth: 20 })],
    [node("Check", [w / 2 - 28 + (h / 2 - 30) * TAN10, h / 2 - 30], [sprite("Card_Ability_Select_Line_Icon", 66, 65, { type: 0, depth: 21 })])]));
  return node(`Card_${it.key}`, [x, y], [sprite("Common_Btn_BG", w, h, { incline: 10, depth: 7, color: "#ffffff/1.00" })], kids);
}

// the details panel: title bar, the picture, name, kind chips, fields, actions
function detailsTree(it, title, fields, actions) {
  const b = LP.left, cx = (b.l + b.r) / 2, w = b.r - b.l;
  const kids = [
    node("Title_Bg", [cx, b.t - 40], [sprite("Common_Bg_Raius10px", w - 20, 73, { depth: 5, color: "#2d4c72/1.00", incline: 10 })], [
      node("Deco", [-(w - 20) / 2 + 30, 0], [sprite("Common_BGDeco", 68, 72, { depth: 6, color: "#2a5886/1.00", type: 0 })]),
      node("Deco (1)", [(w - 20) / 2 - 30, 0], [sprite("Common_BGDeco", 68, 72, { depth: 6, color: "#2a5886/1.00", flip: 3, type: 0 })]),
      node("Label", [0, 0], [label(title, fitText(title, 46, 32, w - 140).fs, "#ffffff/1.00", w - 140, 50, { depth: 7 })]),
    ]),
    node("Picture", [cx, b.t - 330], [sprite("Common_Btn_BG", w - 40, 460, { incline: 10, depth: 6, color: "#ffffff/1.00" })], [
      node("Thumb", [1, 4], [{ clipImage: typeof it.big === "function" ? it.big() : it.big, w_: w - 60, h_: 430, pivot: 4, depth: 7, incline: 10, radius: 22, color: "#ffffff/1.00", imgSize: "cover", imgPosition: "center 18%" }]),
      node("Line", [1, 4], [sprite("Common_Line_Raius20px", w - 54, 438, { incline: 10, depth: 8, color: "#ffffff/1.00" })]),
    ]),
  ];
  const nameFit = fitText(it.full, 52, 36, w - 60);
  kids.push(node("Name", [cx, b.t - 610], [label(nameFit.text, nameFit.fs, "#2d4664/1.00", w - 40, 60 * nameFit.lines, { depth: 8 })]));
  const using = it.inUseText || (it.inUse ? T("popup.inUse") : null);
  const chips = it.chips || [it.recruit ? T("type.recruit") : it.kind === "mod" ? T("type.added") : T("type.noRecruit"), ...(using ? [using] : [])];
  const dark = !it.chips && it.recruit; // the recruit chip: dark, with the recruit mark
  chips.forEach((c, i) => {
    const cw = 250, x = cx + (i - (chips.length - 1) / 2) * (cw + 16);
    kids.push(node(`Chip_${i}`, [x, b.t - 690], [sprite("Common_Bg_Raius10px", cw, 60, { incline: 10, depth: 6, color: i === 0 && dark ? "#2c4564/1.00" : "#ffffff/1.00" })], [
      node("Line", [0, 0], [sprite("Common_Line_Raius10px", cw, 60, { incline: 10, depth: 7, color: "#c0c9d4/1.00" })]),
      node("Text", [0, 0], [], markedLabel(c, { fs: 32, fsMin: 24, color: i === 0 && dark ? "#ffffff/1.00" : "#2c4564/1.00", maxW: cw - 30, mark: i === 0 && dark, depth: 8 }).nodes),
    ]));
  });
  // fields, on the game's light stats box; long values (file names) wrap, never cut
  const capW = Math.max(...fields.map(([k]) => advanceOf(k, 38))) + 30, room = w - 120 - capW;
  const values = fields.map(([, v]) => wrapPath(String(v), 38, 26, room, 3));
  const rowHs = values.map((f) => Math.max(64, f.lines * f.fs * 1.25 + 16));
  const boxT = b.t - 750, boxH = rowHs.reduce((a, h) => a + h, 0) + 24;
  kids.push(node("Fields", [cx, boxT - boxH / 2], [sprite("Common_Bg_Raius10px", w - 40, boxH, { depth: 5, color: "#ecf5f9/1.00" })], [
    node("Line", [0, 0], [sprite("Common_Line_Raius10px", w - 34, boxH + 6, { depth: 4, color: "#c0c9d4/1.00" })]),
  ]));
  let top = boxT - 12;
  fields.forEach(([k, , color], i) => {
    const rowH = rowHs[i], y = top - rowH / 2, x0 = b.l + 50, f = values[i];
    kids.push(node(`F_${i}`, [x0, y], [label(k, 38, "#2d4664/1.00", capW, 50, { pivot: 3, depth: 8 })]));
    kids.push(node(`V_${i}`, [x0 + capW, y], [label(f.text, f.fs, color || "#000000/1.00", room + 20, f.lines * f.fs * 1.25 + 8, { pivot: 3, depth: 8 })]));
    if (i < fields.length - 1) kids.push(node(`L_${i}`, [cx, y - rowH / 2], [sprite("Common_Line_Dot", w - 100, 4, { type: 2, depth: 7, color: "#c0c9d4/1.00" })]));
    top -= rowH;
  });
  actions.forEach(([caption], i) => {
    const bw = (w - 60) / actions.length, x = b.l + 30 + bw / 2 + i * bw, f = fitText(caption, 40, 26, bw - 60);
    kids.push(node(`Act_${i}`, [x, b.b + 70], [sprite("Common_Btn_BG", bw - 14, 120, { depth: 6, color: "#dbeef5/1.00", incline: 10 })], [
      node("Pt", [50, -2], [sprite("Common_Btn_Normal_B_C_Pt", 126, 70, { type: 0, depth: 7, color: "#ffffff/0.80" })]),
      node("Label", [0, 6], [label(f.text, f.fs, "#2d5164/1.00", bw - 40, 60 * f.lines, { depth: 8 })]),
    ]));
  });
  return node("Details", [0, 0], [], kids);
}

// a list popup in host (an element or its id). Redrawn by the caller on every change (a card picked, a segment):
//   items: [{key, label, full, thumb, big, recruit, kind, inUse, inUseText, fav, isNew, size, disabled, dim, badge: {text, color,
//           ink}, chips}]; disabled: cannot be ticked (with multi); dim: the darkened look
//   inUseText: a saved source's caption in the detail chip, independent of whether its files are in use
//   selected: the chosen key; with multi, the ticked keys (selectable(items) ticks all), focus: the card whose details
//             show (by default the first ticked one)
//   onSelect(key, scroll): a card was clicked (the caller ticks it, toggled(), or chooses it, and draws the popup again)
//   buttons: [{label, fn, primary, greyed, action}] under the list, or okText and onOk for the one confirm button
//   onClose(how): the close button, the backdrop and Escape; null for a popup without them (it must be answered)
//   tools: {segs, seg, onSeg, sortKey} for the student list's tools over the cards, or null; without them, hint
//          (left) and footer (right) show in their place
//   check: {label, checked, onChange} for a checkbox left of the buttons; a click flips check.checked, so the same
//          object is passed to every drawing
//   details(it): {title, fields: [[caption, value, colour]], actions: [[caption, fn]]} for the panel on the left
//   keepScroll: the list's scroll position to draw it at
const tokens = new Map(); // host -> the latest drawing's number: an older one that ends later is dropped
export async function listPopup({
  host: hostArg, hostId, title, items, selected = null, multi = false, focus = null, onSelect, buttons = null, okText, onOk,
  onClose = null, tools = null, hint = "", footer = "", check = null, details, keepScroll: scrollTop = 0,
}) {
  const host = hostOf(hostArg ?? hostId);
  const my = (tokens.get(host) || 0) + 1;
  tokens.set(host, my);
  host.hidden = false;
  await ready();
  const ticked = multi ? new Set(selected || []) : null;
  const isSelected = (key) => (multi ? ticked.has(key) : key === selected);
  const btns = buttons || [{ label: okText, fn: onOk, primary: true, action: "ok" }];
  const next = document.createElement("div");
  const view = await NGUI.render(listFrame(title, btns, !!onClose), next, { scale: S, origin: [960, 540] });
  btns.forEach((b, i) => hit(next, view, `Center/Popup/Btn/Btn_${i}/BG (1)`, b.fn, { name: b.label, action: b.action || `button${i}` }));
  if (onClose) hit(next, view, "Center/Popup/Base/BG/Btn_Close", () => onClose("close"), { name: T("display.close"), action: "close" });
  closable(view, host, onClose);
  const band = [];
  if (tools && layouts.collection) {
    const tb = toolbar(LP.list.r - 24, LP.list.t - 76, { segs: tools.segs, sortKey: tools.sortKey, active: tools.seg ?? 0 });
    await NGUI.render(tb.tree, next, { scale: S, origin: [960, 540], z: 20 });
    if (tb.segBox && tools.onSeg) {
      const { right, segW, y } = tb.segBox;
      for (let i = 0; i < 3; i++) {
        const ux = right - (3 - i) * segW + segW / 2 - 6, uy = y + 50.2 - 50;
        hitButton(next, [960 + (ux - segW / 2) * S, 540 - (uy + 52) * S, segW * S, 104 * S], () => tools.onSeg(i), T(tools.segs[i]), 80);
      }
    }
  } else {
    // the band over the cards: a hint at the left, the footer (the ticked cards, their size) at the right
    const room = LP.list.r - LP.list.l - 80;
    const ft = footer ? fitText(footer, 40, 28, room / 2, 1) : null;
    const ht = hint ? fitText(hint, 40, 28, room - (ft ? glyphsOf(ft.text, ft.fs) + 40 : 0), 2) : null;
    if (ht) band.push(node("Hint", [LP.list.l + 40, LP.list.t - 76], [label(ht.text, ht.fs, "#2d4664/1.00", room, 50 * ht.lines, { pivot: 3, depth: 8 })]));
    if (ft) band.push(node("Footer", [LP.list.r - 40, LP.list.t - 76], [label(ft.text, ft.fs, "#2d4664/1.00", room / 2, 50, { pivot: 5, depth: 8 })]));
  }
  let cb = null;
  if (check) {
    const k = btns.length > 2 ? 0.8 : 1, left = LP.ok.x + BTN_W / 2 - btns.length * (BTN_W * k + 24) + 24;
    cb = checkbox("Check", LP.list.l, LP.ok.y, check.label, !!check.checked, left - 40 - LP.list.l);
    band.push(cb.tree);
  }
  if (band.length) {
    const bv = await NGUI.render(node("Band", [0, 0], [], band), next, { scale: S, origin: [960, 540], z: 20 });
    if (cb) wireCheck(next, bv, "Band/Check", check, check.onChange);
  }
  const top = LP.list.t - 166, bottom = LP.list.b + 24;
  const [aL, aT] = [960 + (LP.list.l + 16) * S, 540 - top * S];
  const rows = Math.ceil(items.length / COLS6);
  const contentH = (rows * LP.pitch[1] + 20) * S, visH = (top - bottom) * S;
  const inner = scrollArea(next, [aL, aT, (LP.list.r - LP.list.l - 32) * S, visH], contentH);
  const origin = [960 - aL, 540 - aT];
  // centre the grid on its ink: slanted cards lean right at the top (+h/2 tan10) and left under the name bar
  const leanL = (LP.card.h / 2 + 10 + LP.card.bar) * TAN10, leanR = (LP.card.h / 2) * TAN10;
  const inkW = (COLS6 - 1) * LP.pitch[0] + LP.card.w + leanL + leanR, areaW = LP.list.r - LP.list.l - 32 - 30;
  const x0 = LP.list.l + 16 + (areaW - inkW) / 2 + leanL + LP.card.w / 2;
  const at = (i) => [x0 + (i % COLS6) * LP.pitch[0], top - 30 - LP.card.h / 2 - Math.floor(i / COLS6) * LP.pitch[1]];
  await Promise.all(items.map((it, i) => {
    const styles = it.dim ? { [`Card_${it.key}/Thumb`]: "filter: grayscale(1)" } : undefined;
    return NGUI.render(listCard(it, ...at(i), isSelected(it.key)), inner, { scale: S, origin, z: 30, styles });
  }));
  // the cards' buttons in the list's order, so the keyboard steps through them as they show
  items.forEach((it, i) => {
    const [x, y] = at(i), [sx, sy] = [origin[0] + x * S, origin[1] - y * S];
    const b = hitButton(inner, [sx - LP.card.w / 2 * S, sy - LP.card.h / 2 * S, LP.card.w * S, (LP.card.h + 90) * S], () => onSelect(it.key, inner.parentElement.scrollTop), it.full, 60);
    b.dataset.key = it.key;
    if (multi) { b.setAttribute("role", "checkbox"); b.setAttribute("aria-checked", String(ticked.has(it.key))); }
  });
  const shown = multi ? focus ?? items.find((it) => ticked.has(it.key))?.key : selected;
  const sel = items.find((it) => it.key === shown) || items[0];
  if (sel && details) {
    const d = details(sel);
    const dv = await NGUI.render(detailsTree(sel, d.title, d.fields, d.actions), next, { scale: S, origin: [960, 540], z: 20 });
    d.actions.forEach(([caption, fn], i) => { if (fn) hit(next, dv, `Details/Act_${i}`, fn, { name: caption, title: caption }); });
  }
  if (tokens.get(host) !== my || host.hidden) return;
  const area = inner.parentElement;
  host.replaceChildren(...next.childNodes);
  area.scrollTop = scrollTop;
  // the thumbnails render in the order they were asked for: the cards in view go first, again as the list scrolls
  const bumpShown = () => {
    const row = LP.pitch[1] * S, first = Math.floor(area.scrollTop / row), last = Math.floor((area.scrollTop + visH) / row);
    for (let i = items.length - 1; i >= 0; i--) {
      const at = Math.floor(i / COLS6);
      if (at >= first && at <= last) items[i].thumb?.bump?.();
    }
  };
  bumpShown();
  let waiting = false;
  area.addEventListener("scroll", () => {
    if (waiting) return;
    waiting = true;
    setTimeout(() => { waiting = false; bumpShown(); }, 120);
  });
}

// --- the message popup ---
const MSG = { title: 150, gap: 28, rowMin: 104, check: 150, buttons: 236, none: 70, minH: 640 };

// message({title, lines, ok, cancel, check, host, width, close, confirmKeys}): a message on the popup frame, in host
// (#dialog by default, over everything but the toast). Resolves once it is closed, however it is closed, with
// {button, checked}: button "ok" or "cancel", or null for the close button, the backdrop or Escape; checked, the
// checkbox's state then (null without one).
//   lines: text, or {text, button: {label, fn}} for a line with a small button at its end (fn({close}), where
//          close(button) closes the popup); with such a line every line shows as a row of the game's light box
//   ok, cancel: the buttons' labels (either may be left out); check: {label, checked}
//   close: false for a popup that must be answered with a button (no close button; the backdrop and Escape do nothing)
//   confirmKeys: keys that press OK while the popup is in front and holds the focus itself (a focused button takes its
//                own key), as the PC client binds its popups' confirm (["Enter", " "]); none by default
// The popup takes the keyboard focus while it is open (Enter presses nothing under it) and gives it back after.
// Without the frame's prefab (no game folder) the same message is drawn plain.
export function message(opts) {
  return new Promise((resolve) => { showMessage(opts, resolve); });
}

// a key that presses OK (confirmKeys): alone, not a held key's repeat, not while an input method composes
export function confirmKey(ev, keys) {
  if (!keys?.length || !ev || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229 || ev.repeat) return false;
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return false;
  return keys.includes(ev.key);
}

// the message without the game's prefab: a plain box on a dark backdrop, the same buttons, marked the same way
function plainMessage(layer, { title, lines, ok, cancel, state, dismissable }, finish) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (caption, fn, action, cls = "message-button") => {
    const b = el("button", cls, caption);
    b.dataset.action = action;
    b.setAttribute("aria-label", caption);
    b.addEventListener("click", fn);
    return b;
  };
  const back = el("div", "plain-popup-back");
  if (dismissable) back.addEventListener("click", () => finish(null));
  const box = el("div", "plain-popup");
  box.appendChild(el("h2", "", title));
  lines.map((l) => (typeof l === "string" ? { text: l } : l)).forEach((r, i) => {
    const p = el("p", "", r.text);
    if (r.button) p.appendChild(button(r.button.label, () => r.button.fn?.({ close: finish }), `line${i}`, "plain-line-button"));
    box.appendChild(p);
  });
  if (state) {
    const b = button(state.label, () => { state.checked = !state.checked; b.setAttribute("aria-checked", String(state.checked)); }, "check", "plain-check");
    b.setAttribute("role", "checkbox");
    b.setAttribute("aria-checked", String(state.checked));
    box.appendChild(b);
  }
  if (ok || cancel) {
    const row = el("div", "message-actions");
    if (cancel) row.appendChild(button(cancel, () => finish("cancel"), "cancel"));
    if (ok) row.appendChild(button(ok, () => finish("ok"), "ok"));
    box.appendChild(row);
  }
  layer.replaceChildren(back, box);
}

function messageLines(lines, w) {
  const rows = lines.map((l) => (typeof l === "string" ? { text: l } : l));
  const boxed = rows.some((r) => r.button);
  const out = [];
  let y = 0;
  if (!boxed) {
    rows.forEach((r, i) => {
      // a long line wraps near the popup's own size rather than shrinking to fit one line
      const f = fitText(r.text, 52, 44, w - 240, 4);
      const h = f.lines * f.fs * 1.3 + 8;
      out.push(node(`Line_${i}`, [0, y - h / 2], [label(f.text, f.fs, `${r.color || "#2d4664"}/1.00`, w - 200, h, { depth: 8 })]));
      y -= h + 16;
    });
    return { tree: node("Lines", [0, 0], [], out), height: -y - 16, buttons: [] };
  }
  // rows on the game's light stats box: text at the left, the line's button at the right
  const boxW = w - 200, buttons = [];
  const sized = rows.map((r) => {
    const bf = r.button ? fitText(r.button.label, 40, 28, 340) : null;
    const bw = bf ? Math.max(230, glyphsOf(bf.text, bf.fs) + 90) : 0;
    const f = fitText(r.text, 44, 40, boxW - 80 - (bw ? bw + 30 : 0), 4);
    return { r, f, bf, bw, h: Math.max(MSG.rowMin, f.lines * f.fs * 1.3 + 30) };
  });
  const boxH = sized.reduce((a, s) => a + s.h, 0) + 16;
  out.push(node("Box", [0, -boxH / 2], [sprite("Common_Bg_Raius10px", boxW, boxH, { depth: 5, color: "#ecf5f9/1.00" })], [
    node("Line", [0, 0], [sprite("Common_Line_Raius10px", boxW + 6, boxH + 6, { depth: 4, color: "#c0c9d4/1.00" })]),
  ]));
  y = -8;
  sized.forEach(({ r, f, bf, bw, h }, i) => {
    const cy = y - h / 2;
    out.push(node(`Row_${i}`, [-boxW / 2 + 40, cy], [label(f.text, f.fs, `${r.color || "#2d4664"}/1.00`, boxW - 80 - (bw ? bw + 30 : 0), f.lines * f.fs * 1.3 + 8, { pivot: 3, depth: 8 })]));
    if (bf) {
      // the small light-blue button of the consent popup's Change
      out.push(node(`Btn_${i}`, [boxW / 2 - 30 - bw / 2, cy], [sprite("Common_Btn_BG", bw, 92, { incline: 10, depth: 8, color: "#8de4ff/1.00" })], [
        node("Deco", [bw / 2 - 70, 8], [sprite("Common_Btn_Normal_B_S_Pt", 140, 92, { type: 0, depth: 9, color: "#ffffff/1.00" })]),
        node("Label", [0, 3], [label(bf.text, bf.fs, "#314665/1.00", bw - 30, 80, { depth: 10 })]),
      ]));
      buttons.push([i, r.button]);
    }
    if (i < sized.length - 1) out.push(node(`Dot_${i}`, [0, y - h], [sprite("Common_Line_Dot", boxW - 60, 4, { type: 2, depth: 7, color: "#c0c9d4/1.00" })]));
    y -= h;
  });
  return { tree: node("Lines", [0, 0], [], out), height: boxH, buttons };
}

async function showMessage({ title = "", lines = [], ok = null, cancel = null, check = null, host: hostArg = "dialog", width = 1700, close: dismissable = true, confirmKeys = null }, resolve) {
  const host = hostOf(hostArg);
  const layer = document.createElement("div");
  layer.className = "popup-layer";
  layer.tabIndex = -1;
  host.appendChild(layer);
  host.hidden = false;
  const before = document.activeElement;
  const state = check ? { label: check.label, checked: !!check.checked } : null;
  let ended = false;
  const finish = (button) => {
    if (ended) return;
    ended = true;
    const focused = layer.contains(document.activeElement);
    layer.remove();
    closed(host, layer);
    if (!host.children.length) host.hidden = true;
    if (focused && before?.isConnected) before.focus?.({ preventScroll: true });
    resolve({ button, checked: state ? state.checked : null });
  };
  opened(host, dismissable ? () => finish(null) : null, { el: layer });
  // the confirm keys, while this popup is in front and the focus is on the popup itself
  if (ok && confirmKeys) {
    layer.addEventListener("keydown", (ev) => {
      if (ev.target !== layer || top()?.el !== layer || !confirmKey(ev, confirmKeys)) return;
      ev.preventDefault();
      finish("ok");
    });
  }
  try {
    await ready();
  } catch (err) {
    console.warn("message popup without the game's frame", err);
    if (ended) return;
    plainMessage(layer, { title, lines, ok, cancel, state, dismissable }, finish);
    layer.focus?.({ preventScroll: true });
    return;
  }
  try {
    const body = messageLines(lines, width);
    const hasButtons = !!(ok || cancel);
    const need = MSG.title + body.height + (state ? MSG.check : 0) + MSG.gap + (hasButtons ? MSG.buttons : MSG.none);
    const h = Math.max(MSG.minH, need);
    const t = popupFrame(title, width, h, { ok, cancel, close: dismissable });
    const popup = find(t, "Popup");
    // the content in the middle of the room between the title and the buttons
    const top = FRAME_Y + h / 2 - MSG.title, bottom = FRAME_Y - h / 2 + (hasButtons ? MSG.buttons : MSG.none);
    const used = body.height + (state ? MSG.check : 0);
    const y0 = top - Math.max(0, (top - bottom - used) / 2);
    body.tree.pos = [0, y0];
    popup.children.push(body.tree);
    if (state) {
      const cb = checkbox("Check", 0, y0 - body.height - MSG.check / 2 - 10, state.label, state.checked, width - 300);
      cb.tree.pos[0] = -cb.w / 2;
      popup.children.push(cb.tree);
    }
    const next = document.createElement("div");
    const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 10 });
    if (ended) return;
    if (ok) hit(next, view, "Center/Popup/Btn/Btn_Ok/BG (1)", () => finish("ok"), { name: ok, action: "ok" });
    if (cancel) hit(next, view, "Center/Popup/Btn/Btn_Cancel/BG (1)", () => finish("cancel"), { name: cancel, action: "cancel" });
    if (dismissable) hit(next, view, "Center/Popup/Base/BG/Btn_Close", () => finish(null), { name: T("display.close"), action: "close" });
    for (const [i, b] of body.buttons) {
      hit(next, view, `Center/Popup/Lines/Btn_${i}`, () => b.fn?.({ close: finish }), { name: b.label, action: `line${i}` });
    }
    if (state) wireCheck(next, view, "Center/Popup/Check", state);
    closable(view, host, dismissable ? () => finish(null) : null, { el: layer });
    layer.replaceChildren(...next.childNodes);
    layer.focus?.({ preventScroll: true });
  } catch (err) {
    console.error("message popup", err);
    finish(null);
  }
}

// A scrollable text document on the shared popup frame. Text stays literal, selectable and in its original order.
export function textViewer({ title, text, copy, close = T("display.close"), onCopy }) {
  return new Promise((resolve) => {
    const host = hostOf("dialog"), layer = document.createElement("div"), before = document.activeElement;
    layer.className = "popup-layer";
    layer.tabIndex = -1;
    host.hidden = false;
    host.appendChild(layer);
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      layer.remove();
      closed(host, layer);
      if (!host.children.length) host.hidden = true;
      if (before?.isConnected) before.focus?.({ preventScroll: true });
      resolve();
    };
    opened(host, finish, { el: layer });
    const pre = document.createElement("pre");
    pre.className = "log-text";
    pre.textContent = text;
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", title);
    const draw = async () => {
      try {
        await ready();
        if (ended) return;
        const next = document.createElement("div");
        const view = await NGUI.render(popupFrame(title, 2458, 1400, { ok: copy, cancel: close }), next,
          { scale: S, origin: [960, 540], z: 10 });
        if (ended) return;
        hit(next, view, "Center/Popup/Btn/Btn_Ok/BG (1)", onCopy, { name: copy, action: "copy" });
        hit(next, view, "Center/Popup/Btn/Btn_Cancel/BG (1)", finish, { name: close, action: "cancel" });
        hit(next, view, "Center/Popup/Base/BG/Btn_Close", finish, { name: close, action: "close" });
        closable(view, host, finish, { el: layer });
        Object.assign(pre.style, { position: "absolute", left: `${960 - 1100 * S}px`, top: `${540 - (FRAME_Y + 530) * S}px`,
          width: `${2200 * S}px`, height: `${900 * S}px`, zIndex: 40 });
        next.appendChild(pre);
        layer.replaceChildren(...next.childNodes);
      } catch (err) {
        if (ended) return;
        console.warn("text popup without the game's frame", err);
        const back = document.createElement("div"), box = document.createElement("div"), heading = document.createElement("h2");
        back.className = "plain-modal-back";
        back.addEventListener("click", finish);
        box.className = "plain-message log-message";
        heading.textContent = title;
        box.appendChild(heading);
        box.appendChild(pre);
        for (const [caption, fn, action] of [[copy, onCopy, "copy"], [close, finish, "close"]]) {
          const button = document.createElement("button");
          button.className = "message-button";
          button.textContent = caption;
          button.dataset.action = action;
          button.addEventListener("click", fn);
          box.appendChild(button);
        }
        layer.replaceChildren(back, box);
      }
      pre.scrollTop = pre.scrollHeight;
      layer.focus?.({ preventScroll: true });
    };
    draw();
  });
}
