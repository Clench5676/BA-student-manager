// Roster: the game's student list prefabs rendered by ngui.js
//   UICharacterCollection               list frame, ruled paper, segment filters, search / sort / order buttons, the
//                                       search box (CharacterSearch) and the empty list (LeftInfo_Empty)
//   UICharacterCollectionPopulatorUnit  card template (UICollectCard) and the "not owned" section bar
//   UIPopup_GachaCharList.Btn_Checkbox  checkbox toggle, reused for "group the variants of one character"
// Which cards show, and in what order, is roster-order.js: two segment filters (mods: all / modded / no mod;
// recruitment: all / recruitable / not recruitable), the search (every name language and the file id), and the display
// settings behind the sort button (display.js: filter groups and the sort key; the order button flips the order).
// Cards with mods come first; cards without mods follow the section bar, dimmed like not-owned students. Favourites
// (the game's pins) come first in each group. Grouped, each character shows its first variant (or the first one the
// search found). The view is kept across launches (settings key "roster"), the search for the session. Only the rows
// near the view are rendered; the list scrolls with the wheel, by dragging and with the scrollbar.
import * as NGUI from "./ngui.js";
import * as Display from "./display.js";
import * as Loading from "./loading.js";
import { current as modsState } from "./mod-switch.js";
import { countNodes, countText, iconsOf } from "./mod-counts.js";
import { rpc, spineBase } from "./api.js";
import { L, T, language } from "./i18n.js";
import { thumb } from "./thumbs.js";
import { configuredKey, hasAsset, previewBase, primaryKind } from "./switch-sources.js";
import { $, RECRUIT, S, advanceOf, clone, glyphsOf } from "./util.js";
import { DEFAULT_VIEW, SORTS, arrange, filtering, normalizeView, order as orderOf } from "./roster-order.js";

const { node, sprite, label, find } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);

const PANEL_TOP = 92;                      // stage y of the list frame's top edge (just under the top bar)
const ORIGIN = [960, PANEL_TOP + 525 * S]; // ListBG is centred at y -223 and 1496 tall: top edge at +525
const SHORTEN = 145;                       // the list frame ends above the bottom navigation
const PAPER_TOP = 334.5, PAPER_BOTTOM = -223 - 66 - (1247 - SHORTEN) / 2 + SHORTEN / 2;
// with the search box open (CharacterSearch/SearchName: top edge at 314, 112 tall) the cards start under it
const SEARCH_LIST_TOP = 314 - 112 - 20;
const CLIP_BOTTOM = ORIGIN[1] - PAPER_BOTTOM * S;
const PITCH = 600, COLS = 6, LEFT = -1155, FIRST_Y = 281 - 18 - 245, BAR_EXTRA = 67 + 100;
const TITLE_LEFT = -1270, RIGHT = 1412, GAP = 16;
const TOOL_Y = 446.5; // centre of the search, sort and order buttons in SeletControl's units

let view = { ...normalizeView(DEFAULT_VIEW), scroll: 0 };
let query = "", searching = false, searchTimer = 0; // searchTimer: the search box's debounce
// the search box's input: made and focused the moment the box opens, before the frame around it is drawn, and kept
// in the page across rebuilds, so nothing typed meanwhile is lost
let searchEl = null;
let layouts = null, data = null, ctx = null, items = [], rows = new Map(), contentH = 0, rendered = new Map(), dirty = true;
let countIcons = null;
let dom = {}; // the list's live elements: clip, scroll host (the newest, maybe still built), scrollbar, empty list
let building = false; // a frame is being built: the search box's keystrokes wait for it

const listTop = () => (searching ? SEARCH_LIST_TOP : PAPER_TOP);
const clipTop = () => ORIGIN[1] - listTop() * S;

export function invalidate() { dirty = true; }

// the saved view (settings.get's "roster"); called once at start, before the roster or a detail screen shows
export function init(prefs) { view = { ...normalizeView(prefs), scroll: 0 }; }
export const merged = () => view.merged;

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    rpc("settings.set", { key: "roster", value: normalizeView(view) })
      .then((prefs) => { if (ctx) ctx.prefs = prefs; })
      .catch((err) => console.warn("roster view not saved", err));
  }, 250);
}

let collator = null, collatorLang = null;
function opts(extra = {}) {
  if (collatorLang !== language()) {
    collatorLang = language();
    try { collator = new Intl.Collator(collatorLang, { numeric: true, sensitivity: "base" }); } catch { collator = null; }
  }
  return { query, label: L, collator, ...extra };
}

// the cards in the roster's order, as it shows them (the detail screen's arrows step through these); unfiltered: the
// whole roster in the same order
export function order(rosterData, { unfiltered = false } = {}) { return orderOf(rosterData, view, opts({ unfiltered })); }

// dragging the list: one pair of window listeners for the module's lifetime
let drag = null;
const stageScaleNow = () => document.getElementById("stage").getBoundingClientRect().width / 1920;
addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const dy = (ev.clientY - drag.y) / stageScaleNow();
  if (Math.abs(dy) > 6) ctx.dragged = true;
  view.scroll = drag.scroll - dy;
  applyScroll();
});
addEventListener("pointerup", () => { drag = null; setTimeout(() => { if (ctx) ctx.dragged = false; }, 0); });

// --- toolbar layout: right to left from the order button, the most generous sizes that fit after the title ---
function toolbarLayout() {
  const steps = [[230, 44, 56, 40, 62], [210, 40, 48, 38, 62], [200, 36, 44, 34, 58], [190, 34, 42, 32, 54], [180, 32, 40, 30, 50], [170, 30, 36, 28, 46]];
  for (const [segW, segFs, sortFs, cbFs, titleFs] of steps) {
    const titleEnd = TITLE_LEFT + advanceOf(T("roster.title"), titleFs) + 40;
    const segLabels = ["seg.all", "seg.mods", "seg.noMods", "seg.all", "seg.recruit", "seg.noRecruit"].map((k) => fitText(T(k), segFs, 22, segW - 26));
    // the sort button is as wide as its longest key, so choosing another one moves nothing
    const sortTexts = SORTS.map((k) => fitText(T(`sort.${k}`), sortFs, 28, 420));
    const sortText = sortTexts[Math.max(0, SORTS.indexOf(view.sort))];
    const sortW = Math.max(300, ...sortTexts.map((s) => glyphsOf(s.text, s.fs) + 170));
    const cbText = fitText(T("roster.merge"), cbFs, 24, 400);
    const cbW = 131 + glyphsOf(cbText.text, cbText.fs) + 46;
    let x = RIGHT;
    const order = x - 243 / 2; x -= 243 + GAP;
    const sort = x - sortW / 2; x -= sortW + GAP;
    const search = x - 75; x -= 150 + GAP;
    const seg2 = x; x -= 3 * segW + GAP;
    const seg1 = x; x -= 3 * segW + GAP;
    const cbLeft = x - cbW;
    if (cbLeft >= titleEnd || segW === 170) return { segW, segLabels, sortText, sortW, cbText, cbW, order, sort, search, seg1, seg2, cbLeft, titleFs };
  }
  return null;
}

// --- frame + top menu: our labels instead of image fonts, two segment filters, the checkbox, the tool states ---
function frameTree(lay) {
  const t = clone(layouts.collection);
  const menu = find(t, "SeletControl/TopMenu");
  Object.assign(find(menu, "Menubar/Label_Locale_Title").widgets[0], { text: T("roster.title"), fontSize: lay.titleFs, w_: 600 });
  // segment filters: the game's All / STRIKER / SPECIAL control with our words in the same colours
  const segFilter = (name, labels, active, right) => {
    const f = clone(find(menu, "FilterBtn"));
    f.name = name;
    f.active = true;
    const sx = lay.segW / 328;
    f.scale = [sx, 1];
    f.pos = [right - (529.7 + 164) * sx, -219];
    [["All", 0], ["Main", 1], ["Support", 2]].forEach(([k, i]) => {
      const seg = find(f, k);
      for (const state of seg.children) {
        for (const c of state.children || []) {
          const tex = c.widgets.find((w) => "texture" in w);
          if (tex) c.widgets = [label(labels[i].text, labels[i].fs, tex.color, (lay.segW - 16) / sx, 60 * labels[i].lines, { depth: 9 })];
        }
        state.active = (state.name === "Btn_Pressed") === (i === active);
      }
    });
    return f;
  };
  find(menu, "FilterBtn").active = false;
  menu.children.push(
    segFilter("ModFilter", lay.segLabels.slice(0, 3), { all: 0, mods: 1, none: 2 }[view.mods], lay.seg1),
    segFilter("RecruitFilter", lay.segLabels.slice(3), { all: 0, yes: 1, no: 2 }[view.recruit], lay.seg2));
  // search: the game's toggle, pressed while the search box is open
  const search = find(menu, "SearchBtn");
  search.pos[0] = lay.search - 89;
  find(search, "Btn_Normal").active = !searching;
  find(search, "Btn_Pressed").active = searching;
  // sort: the current key, and the funnel in blue while a display setting filters the list
  const sort = find(menu, "SortBtn");
  sort.pos[0] = lay.sort + 83;
  const body = find(sort, "Btn_Normal");
  const shrink = 622 - lay.sortW;
  body.widgets.find((w) => "sprite" in w).w_ = lay.sortW;
  const filtered = filtering(view.filters);
  for (const name of ["FilterMarker_Off", "FilterMarker_On"]) {
    const n = find(body, name);
    n.pos[0] += shrink / 2;
    find(n, "Icon").pos[0] -= shrink;
    find(n, "Filter_02").widgets[0].w_ -= shrink;
    n.active = (name === "FilterMarker_On") === filtered;
  }
  find(body, "Icon").pos[0] -= shrink / 2;
  find(body, "Type_1").active = false;
  const type2 = find(body, "Type_2");
  type2.active = true;
  Object.assign(find(type2, "Text").widgets[0], { text: lay.sortText.text, fontSize: lay.sortText.fs, w_: lay.sortW - 120 });
  find(type2, "Text").pos[0] = 30;
  // order: one arrow, down for descending (the prefab holds both, Icon_Up flipped)
  const orderBtn = find(menu, "OrderBtn");
  orderBtn.pos[0] = lay.order + 45.1;
  find(orderBtn, "Btn_Normal/Icon_down").active = view.order === "desc";
  find(orderBtn, "Btn_Normal/Icon_Up").active = view.order !== "desc";
  // checkbox toggle after the title (game: "unowned students only" in the gacha character list)
  const cb = clone(layouts.checkbox);
  cb.name = "Merge";
  cb.pos = [lay.cbLeft, -266];
  Object.assign(cb.widgets.find((w) => "sprite" in w), { w_: lay.cbW, h_: 104 });
  cb.children = cb.children.filter((c) => c.name !== "Locale_Text");
  for (const c of cb.children) {
    c.children = (c.children || []).filter((k) => k.name === "Check");
    c.active = (c.name === "Type_ON") === view.merged;
  }
  cb.children.push(node("Label", [131, 0], [label(lay.cbText.text, lay.cbText.fs, "#484e52/1.00", lay.cbW - 131, 50 * lay.cbText.lines, { pivot: 3, depth: 31 })]));
  find(menu, "Menubar").children.push(cb);
  // shorten the frame from the bottom (each piece keeps its top edge: centre up by half, height down by all)
  const listBG = find(t, "ListBG");
  listBG.pos[1] += SHORTEN / 2;
  for (const n of [listBG, find(listBG, "BG"), find(listBG, "PaperBG"), find(listBG, "PaperBG/PaperBGLine")]) n.widgets.find((w) => "sprite" in w).h_ -= SHORTEN;
  // ruled lines: a quarter of the prefab's strength, none below the paper
  for (const line of find(menu, "DotLine").children) {
    line.widgets[0].color = "#adbfc0/0.12";
    if (line.pos[1] < PAPER_BOTTOM + 20) line.active = false;
  }
  find(t, "SeletControl/List/Scroll Bar").active = false; // drawn by us
  return t;
}

// --- entries and their positions ---
function layoutItems() {
  const { groups } = arrange(data, view, opts());
  const out = [];
  const shift = PAPER_TOP - listTop(); // the search box pushes the cards down
  let y = FIRST_Y - shift, first = true;
  for (const g of groups) {
    if (!g.items.length) continue;
    const bar = g.id === "none" ? T("bar.noMods") : null;
    if (bar) {
      // the section bar row is 67 units taller than a card row, plus air above it; first in the list, it only
      // needs room under the paper's top edge
      y -= first ? 67 : BAR_EXTRA;
      out.push({ bar, y: y + 307, row: `bar:${g.id}` });
    }
    g.items.forEach((e, i) => {
      const r = Math.floor(i / COLS);
      out.push({ e, x: LEFT + (i % COLS) * 454, y: y - r * PITCH, row: `${g.id}:${r}` });
    });
    y -= Math.ceil(g.items.length / COLS) * PITCH;
    first = false;
  }
  contentH = (18 + 245 - shift - y) * S;
  // rows with their items and top edge (stage px), for the virtual list
  rows = new Map();
  for (const it of out) {
    let r = rows.get(it.row);
    if (!r) rows.set(it.row, r = { items: [], top: ORIGIN[1] - (it.bar ? it.y + 60 : it.y + 245) * S });
    r.items.push(it);
  }
  return out;
}

function cardTree(e) {
  const t = clone(layouts.card);
  const name = find(t, "Label_CharName");
  // name: the recruit icon and the name centred as one group; long names shrink and wrap; the yellow marker under the glyphs
  const iconH = 64, iconW = e.recruit ? iconH / RECRUIT.ratio + 8 : 0;
  const f = fitText(e.name, 50, 30, 430 - iconW);
  const tw = glyphsOf(f.text, f.fs), adv = Math.max(...f.text.split("\n").map((l) => advanceOf(l, f.fs)));
  const left = -(iconW + tw) / 2;
  Object.assign(name.widgets[0], { text: f.text, fontSize: f.fs, w_: adv + 4, h_: 60 * f.lines });
  name.pos[0] = left + iconW + adv / 2;
  if (f.lines > 1) name.pos[1] -= 24;
  const marker = find(name, "Sprite");
  marker.widgets[0].w_ = tw + 8;
  marker.pos = [tw / 2 - adv / 2, f.lines > 1 ? -17 - 30 : -17];
  if (e.recruit) t.children.push(node("Recruit", [left + (iconW - 8) / 2, name.pos[1] + 2], [sprite(RECRUIT.sprite, iconH / RECRUIT.ratio, iconH, { atlas: RECRUIT.atlas, type: 0, depth: 12 })]));
  find(t, "NewIcon").active = !!e.fresh; // a newly added mod (the game's new-item dot)
  find(t, "CharacterWeapon").active = false;
  const pin = find(t, "Btn_Pin");
  pin.active = !!e.favorite;
  find(pin, "Off").active = false;
  // the band: portrait and memorial lobby counts, or "replaced" when no mod belongs to the variant
  const sort = find(t, "Sort");
  sort.active = e.mods > 0 || !!e.replaced;
  const counts = find(sort, "Label_Schoolname");
  if (e.mods > 0) {
    counts.widgets = [];
    counts.children = countNodes(e.modCounts, countIcons, T);
  } else counts.widgets[0].text = T("band.replaced");
  find(sort, "Sprite").widgets[0].w_ = 406; // cover the portrait's last pixel column
  // dimmed like the game's not-owned cards (BG_Discover is the darkening overlay); changed ones stay bright
  const dim = find(t, "BG_Discover");
  dim.active = !e.mods && !e.replaced;
  dim.widgets[0].color = "#000000/0.55";
  return t;
}

const portraitOf = (e) => {
  const kind = primaryKind(e), variants = data.families.find((f) => f.key === e.family)?.variants || [];
  if (modsState()?.enabled === false && configuredKey(e, kind)) {
    return thumb(previewBase(e, kind, false, variants), "roster", null, kind === "lobby");
  }
  return e.portrait || (hasAsset(e) ? thumb(spineBase(kind, kind === "spr" ? e.spr : e.lobby), "roster", null, kind === "lobby") : null);
};

// --- rows near the view ---
// rows sit in the page in the list's order, and each row's buttons left to right, so the keyboard steps through the
// cards as they show
async function renderRow(host, rowKey) {
  const row = document.createElement("div");
  row.className = "card-row";
  const top = rows.get(rowKey)?.top ?? 0;
  row.dataset.top = String(top);
  host.insertBefore(row, [...host.children].find((r) => Number(r.dataset.top) > top) || null);
  rendered.set(rowKey, row);
  const jobs = [];
  for (const it of rows.get(rowKey)?.items || []) {
    if (it.bar) {
      const bar = clone(layouts.bar);
      find(bar, "Label_Locale").widgets[0].text = it.bar;
      find(bar, "Label_Locale").widgets[0].w_ = 900;
      bar.pos = [-20, it.y];
      jobs.push(NGUI.render(bar, row, { scale: S, origin: ORIGIN, z: 100 }));
      continue;
    }
    const t = cardTree(it.e);
    t.pos = [it.x, it.y];
    const tex = portraitOf(it.e);
    const hit = document.createElement("button");
    hit.className = "card-hit";
    const [sx, sy] = [ORIGIN[0] + it.x * S, ORIGIN[1] - it.y * S];
    Object.assign(hit.style, { left: `${sx - 218 * S}px`, top: `${sy - 245 * S}px`, width: `${436 * S}px`, height: `${490 * S}px` });
    const name = it.e.mods > 0 ? `${it.e.name} - ${countText(it.e.modCounts, T)}` : it.e.name;
    hit.setAttribute("aria-label", name);
    if (hasAsset(it.e)) hit.addEventListener("click", () => { if (!ctx.dragged) location.hash = `#/student/${encodeURIComponent(it.e.family)}/${encodeURIComponent(it.e.key)}`; });
    else hit.disabled = true;
    row.appendChild(hit);
    jobs.push(NGUI.render(t, row, { scale: S, origin: ORIGIN, z: 100, textures: tex ? { Char_Portrait: tex } : {} }));
  }
  row.ready = Promise.all(jobs).then(async (views) => {
    await Promise.all(views.flatMap((v) => v.pictures));
  });
  await row.ready;
}

// the rows near the view are rendered, the others dropped; resolves once the new ones are in
function syncRows() {
  const host = dom.scrollHost;
  const viewH = CLIP_BOTTOM - clipTop();
  const lo = clipTop() + view.scroll - viewH, hi = clipTop() + view.scroll + viewH * 2;
  const wanted = new Set();
  for (const [key, r] of rows) if (r.top + PITCH * S >= lo && r.top <= hi) wanted.add(key);
  for (const [key, el] of rendered) if (!wanted.has(key)) { el.remove(); rendered.delete(key); }
  // the thumbnails render in the order they are asked for: the rows in view first, then below, then above
  const shown = clipTop() + view.scroll, rank = (r) => (r.top + PITCH * S >= shown && r.top <= shown + viewH ? 0 : r.top > shown ? 1 : 2);
  const order = [...wanted].sort((a, b) => rank(rows.get(a)) - rank(rows.get(b)) || rows.get(a).top - rows.get(b).top);
  const visible = order.filter((key) => rank(rows.get(key)) === 0);
  const ready = Promise.all(visible.map((key) => rendered.get(key)?.ready || renderRow(host, key)));
  // Queue overscan only after the visible portraits; it never extends the reveal barrier.
  ready.then(() => {
    if (host !== dom.scrollHost) return;
    for (const key of order) if (!rendered.has(key)) renderRow(host, key).catch(console.error);
  }).catch(console.error);
  return ready;
}

function maxScroll() { return Math.max(0, contentH - (CLIP_BOTTOM - clipTop())); }

function applyScroll() {
  const { scrollHost, bar } = dom;
  if (!scrollHost) return Promise.resolve();
  view.scroll = Math.min(maxScroll(), Math.max(0, view.scroll));
  scrollHost.style.transform = `translateY(${-clipTop() - view.scroll}px)`;
  const viewH = CLIP_BOTTOM - clipTop(), th = Math.max(40, (viewH - 20) * Math.min(1, viewH / Math.max(1, contentH)));
  const thumbEl = bar.firstChild;
  thumbEl.style.height = `${th}px`;
  thumbEl.style.top = `${(viewH - 20 - th) * (maxScroll() ? view.scroll / maxScroll() : 0)}px`;
  bar.hidden = contentH <= viewH;
  return syncRows();
}

// the game's empty list (Arona and a line) when nothing matches
function emptyTree() {
  const t = clone(find(layouts.collection, "SeletControl/LeftInfo_Empty"));
  t.active = true;
  t.pos[1] -= PAPER_TOP - listTop();
  Object.assign(find(t, "Label_Locale").widgets[0], { text: T("roster.empty"), w_: 1200 });
  return t;
}
// the empty list's picture for the current items, built off screen (nothing when there are items)
async function emptyPicture() {
  const next = document.createElement("div");
  if (!items.length) await NGUI.render(emptyTree(), next, { scale: S, origin: ORIGIN, z: 120 });
  return next;
}
async function renderEmpty(host) {
  host.replaceChildren(...(await emptyPicture()).childNodes);
}

// The pictures are decoded too: a list that shows again after the
// detail screen has them all in its first frame (WebKit let go of them while it was hidden), not its cards undimmed
// and without their frames until they come back
const DECODE_CAP = 15000; // only a failed image decode may release the barrier without a picture
let listToken = 0;

// the cards again for the current view (a search keystroke): the frame stays; the new rows are built off screen and
// replace whatever the clip shows in one go (a relist overtaken by a newer one never swapped its rows in)
async function relist() {
  const my = ++listToken;
  items = layoutItems();
  const scrollHost = document.createElement("div");
  scrollHost.className = "card-scroll";
  dom.scrollHost = scrollHost;
  rendered = new Map();
  const empty = emptyPicture();
  await Promise.all([applyScroll(), empty]);
  if (my !== listToken || dom.scrollHost !== scrollHost) return;
  await NGUI.decoded(scrollHost, DECODE_CAP, dom.clip);
  if (my !== listToken || dom.scrollHost !== scrollHost) return;
  dom.clip.replaceChildren(scrollHost);
  // the empty list's picture changes with the cards (in the same frame when it is built by now), never before them
  empty.then((next) => { if (my === listToken) dom.empty.replaceChildren(...next.childNodes); });
}

// --- search: the game's search box over the top of the list, filtering as one types ---
function searchTree() {
  const box = clone(find(layouts.collection, "SeletControl/CharacterSearch"));
  const input = find(box, "SearchName/SearchNameArea/InputField");
  for (const c of input.children) c.widgets.find((w) => "text" in w).text = ""; // the input draws its text and placeholder
  return box;
}
// the input over the game's InputField (at (2, 258) in SeletControl's units)
function searchInput() {
  const el = document.createElement("input");
  el.className = "roster-search";
  el.type = "text";
  el.enterKeyHint = "search";
  el.spellcheck = false;
  el.autocomplete = "off";
  el.placeholder = T("roster.searchHint");
  el.setAttribute("aria-label", T("roster.search"));
  el.value = query;
  Object.assign(el.style, {
    left: `${ORIGIN[0] + (2 - 389) * S}px`, top: `${ORIGIN[1] - (258 + 46) * S}px`, width: `${778 * S}px`, height: `${92 * S}px`,
    fontSize: `${60 * S}px`,
  });
  // typing with an input method (Chinese, Japanese) filters once the word is committed
  el.addEventListener("input", (ev) => { if (!ev.isComposing) searchLater(90); });
  el.addEventListener("compositionend", () => searchLater(0));
  el.addEventListener("keydown", (ev) => {
    // the key that ends a conversion is the input method's (WebKit sends it after compositionend, as keyCode 229)
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Escape") { ev.preventDefault(); closeSearch(); } else if (ev.key === "Enter") el.blur();
  });
  return el;
}
// the list follows the box: a box closed meanwhile (its timer is cleared then) never filters it; while a frame is
// being built, the frame takes the box's text when it is done
function searchApply() {
  const el = searchEl;
  if (!searching || building || !el?.isConnected || el.value === query) return;
  query = el.value;
  view.scroll = 0;
  relist();
}
function searchLater(ms) { clearTimeout(searchTimer); searchTimer = setTimeout(searchApply, ms); }

async function renderSearch(host) {
  await NGUI.render(searchTree(), host, { scale: S, origin: ORIGIN, z: 300 });
  // the input the box opened with stays where it is in the page (it may have the focus); a new one goes in the frame
  if (!searchEl) searchEl = searchInput();
  if (!searchEl.isConnected) host.appendChild(searchEl);
  // the close button at (512, 258)
  const close = document.createElement("button");
  close.className = "card-hit";
  Object.assign(close.style, { left: `${ORIGIN[0] + (512 - 55) * S}px`, top: `${ORIGIN[1] - (258 + 55) * S}px`, width: `${110 * S}px`, height: `${110 * S}px`, zIndex: 330 });
  close.setAttribute("aria-label", T("display.close"));
  close.addEventListener("click", closeSearch);
  host.appendChild(close);
}

// the input goes in at once and takes the focus; the box's frame and the list under it follow
function openSearch() {
  searching = true;
  view.scroll = 0;
  searchEl = searchInput();
  searchEl.classList.add("pending"); // unseen until its box is drawn round it
  $("roster").appendChild(searchEl);
  searchEl.focus();
  renderAll();
}
function closeSearch() {
  clearTimeout(searchTimer);
  searching = false;
  query = "";
  view.scroll = 0;
  searchEl = null; // goes with the frame it is in
  renderAll();
}

// --- display settings (the sort button) and the order button ---
function openDisplay() {
  Loading.wait(Display.open({
    view,
    count: (draft) => orderOf(data, { ...view, ...draft }, opts()).length,
    onDone: (draft) => {
      if (!draft) return;
      Object.assign(view, draft, { scroll: 0 });
      save();
      renderAll();
    },
  }));
}
function flipOrder() {
  view.order = view.order === "desc" ? "asc" : "desc";
  view.scroll = 0;
  save();
  renderAll();
}

// the whole screen: built off screen, then swapped in for the one shown (no empty frame in between); a newer call
// takes over from one still building
let frameToken = 0;
async function renderAll() {
  const my = ++frameToken;
  building = true;
  try {
    await buildFrame(my);
  } finally {
    if (my === frameToken) building = false;
  }
  // keystrokes that came while the frame was built filter the list now
  if (my === frameToken && searching && searchEl && searchEl.value !== query) searchLater(0);
}
async function buildFrame(my) {
  listToken += 1; // a search still building its rows gives way
  // a keystroke still waiting for its debounce is taken now: the rebuilt box starts from it
  clearTimeout(searchTimer);
  if (searching && searchEl) query = searchEl.value;
  const host = $("roster");
  const next = document.createElement("div");
  const lay = toolbarLayout();
  const t = frameTree(lay);
  await Promise.all([
    NGUI.render(find(t, "BG"), next, { scale: S, origin: [960, 540], rootPath: "BG" }),
    NGUI.render({ ...t, children: t.children.filter((c) => ["ListBG", "SeletControl"].includes(c.name)) }, next, {
      scale: S, origin: ORIGIN, off: ["Top", "LeftInfo_Empty", "CharacterSearch", "Btn_Information"],
    }),
  ]);
  if (my !== frameToken) return;
  // cards live in a clipped scroll area: the inside of the ruled paper (under the search box while it is open)
  const clip = document.createElement("div");
  clip.className = "card-clip";
  Object.assign(clip.style, { top: `${clipTop()}px`, height: `${CLIP_BOTTOM - clipTop()}px` });
  const scrollHost = document.createElement("div");
  scrollHost.className = "card-scroll";
  clip.appendChild(scrollHost);
  next.appendChild(clip);
  // scrollbar in the paper's right gutter, game colours (track #ccd7df, thumb #92a6b7)
  const bar = document.createElement("div");
  bar.className = "scrollbar";
  Object.assign(bar.style, { left: `${960 + 1391 * S - 5}px`, top: `${clipTop() + 10}px`, height: `${CLIP_BOTTOM - clipTop() - 20}px` });
  bar.appendChild(document.createElement("i"));
  next.appendChild(bar);
  const empty = document.createElement("div");
  empty.className = "roster-empty";
  next.appendChild(empty);
  clip.addEventListener("wheel", (ev) => {
    if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return; // horizontal trackpad swipes
    ev.preventDefault();
    view.scroll += ev.deltaY / stageScaleNow();
    applyScroll();
  }, { passive: false });
  clip.addEventListener("pointerdown", (ev) => { drag = { y: ev.clientY, scroll: view.scroll }; ctx.dragged = false; });
  // a card focused from the keyboard is brought into view through the list's own position, so the rows, the
  // scrollbar and the virtual list stay in step; whatever still scrolls the clip itself (the browser showing a
  // focused card) goes the same way
  clip.addEventListener("focusin", (ev) => {
    if (!ev.target.classList?.contains("card-hit")) return;
    const r = ev.target.getBoundingClientRect(), c = clip.getBoundingClientRect(), k = stageScaleNow();
    if (r.top < c.top) view.scroll -= (c.top - r.top) / k;
    else if (r.bottom > c.bottom) view.scroll += (r.bottom - c.bottom) / k;
    else return;
    applyScroll();
  });
  clip.addEventListener("scroll", () => {
    const dy = clip.scrollTop;
    if (!dy && !clip.scrollLeft) return;
    clip.scrollTop = 0;
    clip.scrollLeft = 0;
    view.scroll += dy;
    applyScroll();
  });

  // hit areas for the header controls (TopMenu sits at y 720 in SeletControl's units)
  const hit = ([ux, uy, w, h], fn, name) => {
    const b = document.createElement("button");
    b.className = "card-hit";
    Object.assign(b.style, { left: `${ORIGIN[0] + (ux - w / 2) * S}px`, top: `${ORIGIN[1] - (uy + h / 2) * S}px`, width: `${w * S}px`, height: `${h * S}px` });
    if (name) b.setAttribute("aria-label", name);
    b.addEventListener("click", fn);
    next.appendChild(b);
    return b;
  };
  const segY = 720 - 219 - 50.2;
  const reset = (fn) => () => { fn(); view.scroll = 0; save(); renderAll(); };
  ["all", "mods", "none"].forEach((k, i) => hit([lay.seg1 - (2.5 - i) * lay.segW, segY, lay.segW, 104], reset(() => { view.mods = k; })));
  ["all", "yes", "no"].forEach((k, i) => hit([lay.seg2 - (2.5 - i) * lay.segW, segY, lay.segW, 104], reset(() => { view.recruit = k; })));
  hit([lay.cbLeft + lay.cbW / 2, 720 - 273, lay.cbW, 110], reset(() => { view.merged = !view.merged; }));
  hit([lay.search, TOOL_Y, 150, 116], () => (searching ? closeSearch() : openSearch()), T("roster.search"));
  // the display settings' first drawing takes a while: it starts as the pointer comes to the button
  hit([lay.sort, TOOL_Y, lay.sortW, 116], openDisplay, T("display.title")).addEventListener("pointerenter", () => Display.warm());
  hit([lay.order, TOOL_Y, 243, 116], flipOrder, T(view.order === "desc" ? "roster.desc" : "roster.asc"));

  // The visible cards and their portraits finish behind the loading cover.
  rendered = new Map();
  dom = { clip, scrollHost, bar, empty };
  items = layoutItems();
  const box = searching ? renderSearch(next) : Promise.resolve();
  await Promise.all([applyScroll(), renderEmpty(empty), box]);
  if (my !== frameToken) return;
  await NGUI.decoded(next, DECODE_CAP, host);
  if (my !== frameToken) return;
  // the open search box's input stays in place (it may have the focus, a caret or an unfinished input method word);
  // everything else is swapped
  const keep = searching && searchEl?.parentNode === host ? searchEl : null;
  const fresh = document.createDocumentFragment();
  fresh.append(...next.childNodes);
  for (const child of [...host.childNodes]) if (child !== keep) child.remove();
  host.insertBefore(fresh, keep);
  if (searching) searchEl?.classList.remove("pending");
}

// the search box and the empty list (small) are first drawn a while after the roster, so their images are ready when
// they are needed
let warmed = false;
function warm() {
  if (warmed) return;
  warmed = true;
  setTimeout(() => {
    const scratch = document.createElement("div");
    Promise.all([
      NGUI.render(searchTree(), scratch, { scale: S, origin: ORIGIN }),
      NGUI.render(emptyTree(), scratch, { scale: S, origin: ORIGIN }),
    ]).catch((err) => console.warn("warm-up", err));
  }, 2500);
}

// show the roster; data comes from roster.list (re-read when invalidated). Resolves once the list is ready to be seen,
// built and its pictures decoded: the caller builds it behind the screen still shown and then shows it, so its first
// frame is complete.
export async function show(context, rosterData) {
  ctx = context;
  await NGUI.init();
  countIcons ||= iconsOf(NGUI.atlasIndex());
  if (!layouts) {
    const [collection, unit, checkbox] = await Promise.all([
      NGUI.layout("UICharacterCollection"), NGUI.layout("UICharacterCollectionPopulatorUnit"), NGUI.layout("UIPopup_GachaCharList.Btn_Checkbox"),
    ]);
    layouts = { collection, checkbox, card: find(unit, "Grid/UICollectCard"), bar: find(unit, "UnownedBG") };
  }
  if (rosterData !== data || dirty) {
    data = rosterData;
    dirty = false;
    await renderAll();
  } else {
    await NGUI.decoded($("roster"), DECODE_CAP); // the list as it was: its pictures again
  }
  warm();
}
