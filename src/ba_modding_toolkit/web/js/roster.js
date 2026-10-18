// Roster: the game's student list prefabs rendered by ngui.js
//   UICharacterCollection               list frame, ruled paper, filter / search / sort / order buttons
//   UICharacterCollectionPopulatorUnit  card template (UICollectCard) and the "not owned" section bar
//   UIPopup_GachaCharList.Btn_Checkbox  checkbox toggle, reused for "group the variants of one character"
// Two segment filters: mods (all / modded / no mod) and recruitment (all / recruitable / not recruitable). Cards with
// mods come first; cards without mods follow the section bar, dimmed like not-owned students. Favourites (the game's
// pins) come first in each group. Grouped, each character shows its first variant. Only the rows near the view are
// rendered; the list scrolls with the wheel, by dragging and with the scrollbar.
import * as NGUI from "./ngui.js";
import { spineBase } from "./api.js";
import { L, T } from "./i18n.js";
import { thumb } from "./thumbs.js";
import { $, RECRUIT, S, advanceOf, clone, glyphsOf } from "./util.js";

const { node, sprite, label, find } = NGUI;
const fitText = (...a) => NGUI.fitText(...a);

const PANEL_TOP = 92;                      // stage y of the list frame's top edge (just under the top bar)
const ORIGIN = [960, PANEL_TOP + 525 * S]; // ListBG is centred at y -223 and 1496 tall: top edge at +525
const SHORTEN = 145;                       // the list frame ends above the bottom navigation
const PAPER_TOP = 334.5, PAPER_BOTTOM = -223 - 66 - (1247 - SHORTEN) / 2 + SHORTEN / 2;
const CLIP_TOP = ORIGIN[1] - PAPER_TOP * S, CLIP_BOTTOM = ORIGIN[1] - PAPER_BOTTOM * S;
const PITCH = 600, COLS = 6, LEFT = -1155, FIRST_Y = 281 - 18 - 245, BAR_EXTRA = 67 + 100;
const TITLE_LEFT = -1270, RIGHT = 1412, GAP = 16;

const view = { merged: false, filter: "all", recruit: "all", scroll: 0 };
let layouts = null, data = null, ctx = null, items = [], contentH = 0, rendered = new Map(), dirty = true;

export function invalidate() { dirty = true; }

// dragging the list: one pair of window listeners for the module's lifetime
let drag = null;
const stageScaleNow = () => document.getElementById("stage").getBoundingClientRect().width / 1920;
addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const dy = (ev.clientY - drag.y) / stageScaleNow();
  if (Math.abs(dy) > 6) ctx.dragged = true;
  view.scroll = drag.scroll - dy;
  applyScroll(drag.scrollHost, drag.bar);
});
addEventListener("pointerup", () => { drag = null; setTimeout(() => { if (ctx) ctx.dragged = false; }, 0); });

// --- toolbar layout: right to left from the order button, the most generous sizes that fit after the title ---
function toolbarLayout() {
  const steps = [[230, 44, 56, 40, 62], [210, 40, 48, 38, 62], [200, 36, 44, 34, 58], [190, 34, 42, 32, 54], [180, 32, 40, 30, 50], [170, 30, 36, 28, 46]];
  for (const [segW, segFs, sortFs, cbFs, titleFs] of steps) {
    const titleEnd = TITLE_LEFT + advanceOf(T("roster.title"), titleFs) + 40;
    const segLabels = ["seg.all", "seg.mods", "seg.noMods", "seg.all", "seg.recruit", "seg.noRecruit"].map((k) => fitText(T(k), segFs, 22, segW - 26));
    const sortText = fitText(T("sort.recent"), sortFs, 28, 420);
    const sortW = Math.max(300, glyphsOf(sortText.text, sortText.fs) + 170);
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

// --- frame + top menu: our labels instead of image fonts, two segment filters, the checkbox ---
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
    segFilter("ModFilter", lay.segLabels.slice(0, 3), { all: 0, mods: 1, none: 2 }[view.filter], lay.seg1),
    segFilter("RecruitFilter", lay.segLabels.slice(3), { all: 0, yes: 1, no: 2 }[view.recruit], lay.seg2));
  find(menu, "SearchBtn").pos[0] = lay.search - 89;
  const sort = find(menu, "SortBtn");
  sort.pos[0] = lay.sort + 83;
  const body = find(sort, "Btn_Normal");
  const shrink = 622 - lay.sortW;
  body.widgets.find((w) => "sprite" in w).w_ = lay.sortW;
  for (const name of ["FilterMarker_Off", "FilterMarker_On"]) {
    const n = find(body, name);
    n.pos[0] += shrink / 2;
    find(n, "Icon").pos[0] -= shrink;
    find(n, "Filter_02").widgets[0].w_ -= shrink;
  }
  find(body, "Icon").pos[0] -= shrink / 2;
  find(body, "Type_1").active = false;
  const type2 = find(body, "Type_2");
  type2.active = true;
  Object.assign(find(type2, "Text").widgets[0], { text: lay.sortText.text, fontSize: lay.sortText.fs, w_: lay.sortW - 120 });
  find(type2, "Text").pos[0] = 30;
  find(menu, "OrderBtn").pos[0] = lay.order + 45.1;
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
function entries() {
  const list = [];
  let n = 0;
  for (const f of data.families) {
    if (!f.variants.length) continue;
    if (view.merged) {
      const first = f.variants[0];
      list.push({ ...first, name: L(f.base), recruit: f.variants.some((v) => v.playable), mods: f.variants.reduce((s, v) => s + (v.mods || 0), 0),
        favorite: f.variants.some((v) => v.favorite), fresh: f.variants.some((v) => v.fresh),
        replaced: f.variants.find((v) => v.replaced)?.replaced || null,
        recent: Math.min(...f.variants.map((v) => v.recent ?? Infinity)), family: f.key, n: n++ });
    } else {
      for (const v of f.variants) list.push({ ...v, name: L(v.names).full, recruit: v.playable, family: f.key, recent: v.recent ?? Infinity, n: n++ });
    }
  }
  return list
    .filter((e) => view.recruit === "all" || (view.recruit === "yes") === e.recruit)
    .sort((a, b) => (b.favorite - a.favorite) || (a.recent - b.recent) || (a.n - b.n));
}

function layoutItems() {
  const list = entries();
  const groups = [];
  if (view.filter !== "none") groups.push({ items: list.filter((e) => e.mods) });
  if (view.filter !== "mods") groups.push({ items: list.filter((e) => !e.mods), bar: T("bar.noMods") });
  const out = [];
  let y = FIRST_Y, first = true;
  for (const g of groups) {
    if (!g.items.length) continue;
    if (g.bar) {
      // the section bar row is 67 units taller than a card row, plus air above it; first in the list, it only
      // needs room under the paper's top edge
      y -= first ? 67 : BAR_EXTRA;
      out.push({ bar: g.bar, y: y + 307, row: `bar:${g.bar}` });
    }
    g.items.forEach((e, i) => {
      const r = Math.floor(i / COLS);
      out.push({ e, x: LEFT + (i % COLS) * 454, y: y - r * PITCH, row: `${g.bar || "mods"}:${r}` });
    });
    y -= Math.ceil(g.items.length / COLS) * PITCH;
    first = false;
  }
  contentH = (18 + 245 - y) * S;
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
  find(t, "NewIcon").active = !!e.fresh; // a newly added portrait (the game's new-item dot)
  find(t, "CharacterWeapon").active = false;
  const pin = find(t, "Btn_Pin");
  pin.active = !!e.favorite;
  find(pin, "Off").active = false;
  // the band: the number of mods, or "replaced" when the game file wears another portrait without a mod of its own
  const sort = find(t, "Sort");
  sort.active = e.mods > 0 || !!e.replaced;
  find(sort, "Label_Schoolname").widgets[0].text = e.mods > 0 ? T("band.mods", { n: e.mods }) : T("band.replaced");
  find(sort, "Sprite").widgets[0].w_ = 406; // cover the portrait's last pixel column
  // dimmed like the game's not-owned cards (BG_Discover is the darkening overlay); changed ones stay bright
  const dim = find(t, "BG_Discover");
  dim.active = !e.mods && !e.replaced;
  dim.widgets[0].color = "#000000/0.55";
  return t;
}

const portraitOf = (e) => e.portrait || (e.spr ? thumb(spineBase("spr", e.spr), "roster") : null);

// --- rows near the view ---
async function renderRow(host, rowKey) {
  const row = document.createElement("div");
  row.className = "card-row";
  host.appendChild(row);
  rendered.set(rowKey, row);
  const jobs = [];
  for (const it of items) {
    if (it.row !== rowKey) continue;
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
    jobs.push(NGUI.render(t, row, { scale: S, origin: ORIGIN, z: 100, textures: tex ? { Char_Portrait: tex } : {} }).then(() => {
      const hit = document.createElement("button");
      hit.className = "card-hit";
      const [sx, sy] = [ORIGIN[0] + it.x * S, ORIGIN[1] - it.y * S];
      Object.assign(hit.style, { left: `${sx - 218 * S}px`, top: `${sy - 245 * S}px`, width: `${436 * S}px`, height: `${490 * S}px` });
      hit.title = it.e.name;
      if (it.e.spr) hit.addEventListener("click", () => { if (!ctx.dragged) location.hash = `#/student/${encodeURIComponent(it.e.family)}/${encodeURIComponent(it.e.key)}`; });
      else hit.disabled = true;
      row.appendChild(hit);
    }));
  }
  await Promise.all(jobs);
}

function rowTop(rowKey) {
  const it = items.find((x) => x.row === rowKey);
  return it ? ORIGIN[1] - (it.bar ? it.y + 60 : it.y + 245) * S : 0;
}

function syncRows(host) {
  const viewH = CLIP_BOTTOM - CLIP_TOP;
  const lo = CLIP_TOP + view.scroll - viewH, hi = CLIP_TOP + view.scroll + viewH * 2;
  const wanted = new Set();
  for (const it of items) {
    const top = rowTop(it.row);
    if (top + PITCH * S >= lo && top <= hi) wanted.add(it.row);
  }
  for (const [key, el] of rendered) if (!wanted.has(key)) { el.remove(); rendered.delete(key); }
  for (const key of wanted) if (!rendered.has(key)) renderRow(host, key);
}

function maxScroll() { return Math.max(0, contentH - (CLIP_BOTTOM - CLIP_TOP)); }

function applyScroll(scrollHost, bar) {
  view.scroll = Math.min(maxScroll(), Math.max(0, view.scroll));
  scrollHost.style.transform = `translateY(${-CLIP_TOP - view.scroll}px)`;
  const viewH = CLIP_BOTTOM - CLIP_TOP, th = Math.max(40, (viewH - 20) * Math.min(1, viewH / Math.max(1, contentH)));
  const thumbEl = bar.firstChild;
  thumbEl.style.height = `${th}px`;
  thumbEl.style.top = `${(viewH - 20 - th) * (maxScroll() ? view.scroll / maxScroll() : 0)}px`;
  bar.hidden = contentH <= viewH;
  syncRows(scrollHost);
}

async function renderAll() {
  const host = $("roster");
  host.innerHTML = "";
  rendered = new Map();
  const lay = toolbarLayout();
  const t = frameTree(lay);
  await NGUI.render(find(t, "BG"), host, { scale: S, origin: [960, 540], rootPath: "BG" });
  await NGUI.render({ ...t, children: t.children.filter((c) => ["ListBG", "SeletControl"].includes(c.name)) }, host, {
    scale: S, origin: ORIGIN, off: ["Top", "LeftInfo_Empty", "CharacterSearch", "Btn_Information"],
  });
  items = layoutItems();
  // cards live in a clipped scroll area: the inside of the ruled paper
  const clip = document.createElement("div");
  clip.className = "card-clip";
  Object.assign(clip.style, { top: `${CLIP_TOP}px`, height: `${CLIP_BOTTOM - CLIP_TOP}px` });
  const scrollHost = document.createElement("div");
  scrollHost.className = "card-scroll";
  clip.appendChild(scrollHost);
  host.appendChild(clip);
  // scrollbar in the paper's right gutter, game colours (track #ccd7df, thumb #92a6b7)
  const bar = document.createElement("div");
  bar.className = "scrollbar";
  Object.assign(bar.style, { left: `${960 + 1391 * S - 5}px`, top: `${CLIP_TOP + 10}px`, height: `${CLIP_BOTTOM - CLIP_TOP - 20}px` });
  bar.appendChild(document.createElement("i"));
  host.appendChild(bar);
  applyScroll(scrollHost, bar);

  const stageScale = () => document.getElementById("stage").getBoundingClientRect().width / 1920;
  clip.addEventListener("wheel", (ev) => {
    if (Math.abs(ev.deltaY) < Math.abs(ev.deltaX)) return; // horizontal trackpad swipes
    ev.preventDefault();
    view.scroll += ev.deltaY / stageScale();
    applyScroll(scrollHost, bar);
  }, { passive: false });
  clip.addEventListener("pointerdown", (ev) => { drag = { y: ev.clientY, scroll: view.scroll, scrollHost, bar }; ctx.dragged = false; });

  // hit areas for the header controls (TopMenu sits at y 720 in SeletControl's units)
  const hit = ([ux, uy, w, h], fn) => {
    const b = document.createElement("button");
    b.className = "card-hit";
    Object.assign(b.style, { left: `${ORIGIN[0] + (ux - w / 2) * S}px`, top: `${ORIGIN[1] - (uy + h / 2) * S}px`, width: `${w * S}px`, height: `${h * S}px` });
    b.addEventListener("click", fn);
    host.appendChild(b);
  };
  const segY = 720 - 219 - 50.2;
  const reset = (fn) => () => { fn(); view.scroll = 0; renderAll(); };
  ["all", "mods", "none"].forEach((k, i) => hit([lay.seg1 - (2.5 - i) * lay.segW, segY, lay.segW, 104], reset(() => { view.filter = k; })));
  ["all", "yes", "no"].forEach((k, i) => hit([lay.seg2 - (2.5 - i) * lay.segW, segY, lay.segW, 104], reset(() => { view.recruit = k; })));
  hit([lay.cbLeft + lay.cbW / 2, 720 - 273, lay.cbW, 110], reset(() => { view.merged = !view.merged; }));
}

// show the roster; data comes from roster.list (re-read when invalidated)
export async function show(context, rosterData) {
  ctx = context;
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
  }
}
