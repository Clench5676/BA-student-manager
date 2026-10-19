// Display settings: the student list's filter and sort popup, the game's own (UIPopup_FilterSort). Filter and Sort
// tabs on the left; on the right the filter groups (UIFilterObjectList: title with its tag, dotted line, check boxes)
// under the list header with Reset All, or the sort keys as the game's radio buttons (UISortObjectListUnit); Cancel
// and Confirm below. It edits a draft of the view; Confirm hands the draft back.
import * as NGUI from "./ngui.js";
import { T } from "./i18n.js";
import { FILTERS, NATURAL, SORTS } from "./roster-order.js";
import { $, S, clone, glyphsOf, hitButton } from "./util.js";

const { node, find } = NGUI;
const Z = 3000;
// the filter list's visible area under its header (Filter/BG_List below Filter/BG_Tag), popup units
const LIST = { cx: 212, top: 377, bottom: -404, w: 2244 };
// one row of check boxes per group: the bottom line 36 under the row (as under the prefab's second row), the
// list's 12 of padding between groups
const GROUP = { x: -1109, top: -150, pitch: 308, unitX: [165, 712, 1259, 1806], unitY: -76, line: -176 };
// the sort keys' grid (Sort_Normal/Option_Normal/Grid), relative to the Sort panel
const SORT = { titleY: 446.5, x: -1015, y: 330, cell: [553, 174], perLine: 4 };

let layout = null, draft = null, tab = "filter", count = null, done = null, scroll = 0, token = 0;

const optionLabel = {
  favorite: { yes: () => T("fav.on"), no: () => T("display.fav.off") },
  portrait: { official: () => T("status.original"), replaced: () => T("status.replaced") },
  lobby: { yes: () => T("model.has"), no: () => T("model.none") },
  model: { yes: () => T("model.has"), no: () => T("model.none") },
  kind: { student: () => T("display.kind.student"), npc: () => T("display.kind.npc") },
};
const groupTitle = { favorite: () => T("fav.label"), portrait: () => T("tab.portrait"), lobby: () => T("tab.lobby"),
  model: () => T("tab.model"), kind: () => T("display.kind.title") };

const setText = (n, text, fsMax, fsMin, w) => NGUI.fitLabel(n.widgets.find((x) => "text" in x), text, fsMax, fsMin, w);

// --- the popup frame: backdrop, title, tabs, the shown panel, the buttons ---
function frameTree() {
  const t = clone(find(layout.fs, "Center"));
  find(t, "BlackBg/BlackBgClickArea").widgets.find((w) => "sprite" in w).color = "#000000/0.60";
  const popup = find(t, "Popup");
  const title = find(popup, "Base/BG/Label_Title_Locale");
  const tf = setText(title, T("display.title"), 72, 52, 1100);
  find(title, "Line").widgets[0].w_ = glyphsOf(tf.text, tf.fs) + 14;
  for (const [widget, id, key] of [["FilterWidget/Filter", "filter", "display.tab.filter"], ["SortWidget/Sort", "sort", "display.tab.sort"]]) {
    const n = find(popup, `Tab/${widget}`);
    for (const state of ["Tab_On", "Tab_Off"]) {
      setText(find(n, `${state}/Label_Locale`), T(key), 56, 40, 360);
      find(n, state).active = (state === "Tab_On") === (id === tab);
    }
  }
  const filter = find(popup, "Filter"), sort = find(popup, "Sort");
  filter.active = tab === "filter";
  sort.active = tab === "sort";
  // the filter panel: header with the count and Reset All; the groups scroll in a list drawn beside the tree
  setText(find(filter, "BG_Tag/Label_Locale_ListAll"), T("display.count", { n: count(draft) }), 56, 40, 1400);
  setText(find(filter, "BG_Tag/Btn_Reset/LabelLocale"), T("display.reset"), 48, 32, 300);
  filter.children = filter.children.filter((c) => ["BG_List", "BG_Tag"].includes(c.name));
  // the sort panel: the title bar and one radio button per key
  const normal = find(sort, "Scroll View/Sort_Normal");
  const bar = clone(find(normal, "Title_Normal"));
  bar.pos = [1, SORT.titleY];
  // the scroll view's own panel draws above the list's white body (BG_List, depth 16)
  const lift = (n) => { for (const w of n.widgets) if ("depth" in w) w.depth += 12; (n.children || []).forEach(lift); };
  lift(bar);
  setText(find(bar, "Label_Locale_UnitList"), T("display.sortBy"), 48, 36, 1600);
  const unit = find(normal, "Option_Normal/Grid/UISortObjectListUnit");
  const options = SORTS.map((key, i) => sortUnit(unit, key, i));
  sort.children = [find(sort, "BG_List"), bar, ...options];
  find(popup, "Btn_Section/Btn_Disable").active = false;
  setText(find(popup, "Btn_Section/Btn_Ok/Label_Locale"), T("picker.ok"), 72, 48, 420);
  setText(find(popup, "Btn_Section/Btn_Cancel/Label_Locale"), T("popup.cancel"), 72, 48, 420);
  return t;
}

// a sort key: the game's radio button with its label (the Label_Text form of UISortObjectListUnit)
function sortUnit(template, key, i) {
  const u = clone(template);
  u.name = `Sort_${key}`;
  u.pos = [SORT.x + (i % SORT.perLine) * SORT.cell[0], SORT.y - Math.floor(i / SORT.perLine) * SORT.cell[1]];
  for (const c of u.children) c.active = c.name === "Label_Text";
  const opt = find(u, "Label_Text");
  const on = draft.sort === key;
  find(opt, "On").active = on;
  for (const path of ["On/Label_On", "Label_On"]) setText(find(opt, path), T(`sort.${key}`), 48, 34, 360);
  find(opt, "Label_On").active = !on; // the dimmed label under the button when off, the dark one with it when on
  return u;
}

// the filter groups: UIFilterObjectList with one check box per option (UIFilterObjectListUnit)
function groupsTree() {
  const out = node("Groups", [0, 0]);
  Object.keys(FILTERS).forEach((group, gi) => {
    const g = clone(layout.group);
    g.name = `Group_${group}`;
    g.pos = [GROUP.x, GROUP.top - gi * GROUP.pitch];
    const title = find(g, "Label_Title");
    setText(title, groupTitle[group](), 50, 40, 1800);
    find(g, "Table_Align/Line_Deco_Bottom").pos[1] = GROUP.line;
    const units = find(g, "Table_Align/Table_ListUnit");
    const template = units.children[0];
    units.children = FILTERS[group].map((value, i) => {
      const u = clone(template);
      u.name = `Unit_${value}`;
      u.pos = [GROUP.unitX[i], GROUP.unitY];
      const on = (draft.filters[group] || []).includes(value);
      find(u, "UIFilter_CheckBox/CheckBoxIcon").active = on;
      find(u, "UIFilter_CheckBox/CheckBoxIcon_Disable").active = !on;
      const sw = find(u, "SwitchObject_Columns_4");
      for (const c of sw.children) c.active = c.name === "Label_Text";
      setText(find(sw, "Label_Text"), optionLabel[group][value](), 44, 32, 380);
      return u;
    });
    out.children.push(g);
  });
  return out;
}

function toggle(group, value) {
  const on = new Set(draft.filters[group] || []);
  if (on.has(value)) on.delete(value); else on.add(value);
  draft.filters = { ...draft.filters, [group]: FILTERS[group].filter((v) => on.has(v)) };
  if (!draft.filters[group].length) delete draft.filters[group];
  render();
}

// the list header's decoration (BG_Tag/DecoTex_Normal, pivot top left at the header's right end) runs on past the
// popup; the game's panel clips it at the popup's frame, so only the part over the frame's right margin shows
function clipToFrame(view, frame) {
  const deco = view.nodes.get("Center/Popup/Filter/BG_Tag/DecoTex_Normal")?.els[0];
  if (!deco || !frame) return;
  const [l, , w] = NGUI.rect(deco), [fl, , fw] = NGUI.rect(frame);
  const over = l + w - (fl + fw);
  if (over > 0) deco.style.clipPath = `inset(0 ${over.toFixed(2)}px 0 0)`;
}

const stagePx = ([x, y]) => [960 + x * S, 540 - y * S];
function hitAt(host, [x, y], [w, h], fn, title) {
  const [l, t] = stagePx([x - w / 2, y + h / 2]);
  return hitButton(host, [l, t, w * S, h * S], fn, title, Z + 200);
}

async function render() {
  const my = ++token;
  const next = document.createElement("div");
  const view = await NGUI.render(frameTree(), next, { scale: S, origin: [960, 540], z: Z });
  // a click on the backdrop cancels; the popup's body takes the clicks that miss its controls (UIEventTrigger)
  const back = view.nodes.get("Center/BlackBg/BlackBgClickArea")?.els[0];
  if (back) { back.style.pointerEvents = "auto"; back.addEventListener("click", () => finish(null)); }
  const body = view.nodes.get("Center/Popup/Base/BG")?.els[0];
  if (body) body.style.pointerEvents = "auto";
  clipToFrame(view, body);
  hitAt(next, [1323, 639], [120, 120], () => finish(null), T("display.close"));
  [["filter", 474.5], ["sort", 337.7]].forEach(([id, y]) => {
    if (id !== tab) hitAt(next, [-1143, y], [420, 136], () => { tab = id; scroll = 0; render(); }, T(`display.tab.${id}`));
  });
  hitAt(next, [289, -547], [520, 180], () => finish(draft), T("picker.ok"));
  hitAt(next, [-295, -547], [520, 180], () => finish(null), T("popup.cancel"));
  if (tab === "filter") {
    hitAt(next, [212 + 874, 516 - 66], [454, 106], () => { draft.filters = {}; render(); }, T("display.reset"));
    await renderGroups(next);
  } else {
    SORTS.forEach((key, i) => {
      const x = 211 + SORT.x + (i % SORT.perLine) * SORT.cell[0], y = -2.5 + SORT.y - Math.floor(i / SORT.perLine) * SORT.cell[1];
      hitAt(next, [x + 200, y], [520, 150], () => {
        if (draft.sort !== key) draft = { ...draft, sort: key, order: NATURAL[key] };
        render();
      }, T(`sort.${key}`));
    });
  }
  if (my !== token || $("display").hidden) return;
  $("display").replaceChildren(...next.childNodes);
  const list = $("display").querySelector(".display-rows");
  if (list) {
    list.scrollTop = scroll;
    list.addEventListener("scroll", () => { scroll = list.scrollTop; syncBar(list); });
    syncBar(list);
  }
}

// the groups scroll inside the list area (wheel, trackpad, scrollbar drag of the OS is hidden: the game's bar shows)
async function renderGroups(host) {
  const [l, t] = stagePx([LIST.cx - LIST.w / 2, LIST.top]);
  const w = LIST.w * S, h = (LIST.top - LIST.bottom) * S;
  const area = document.createElement("div");
  area.className = "settings-rows display-rows";
  Object.assign(area.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px`, zIndex: Z + 20 });
  const inner = document.createElement("div");
  inner.className = "settings-rows-inner";
  const groups = Object.keys(FILTERS).length;
  const contentH = (-GROUP.top + (groups - 1) * GROUP.pitch - GROUP.line + 40) * S;
  inner.style.height = `${Math.max(h, contentH)}px`;
  area.appendChild(inner);
  host.appendChild(area);
  const origin = [w / 2, 0];
  await NGUI.render(groupsTree(), inner, { scale: S, origin, z: Z + 30 });
  Object.keys(FILTERS).forEach((group, gi) => {
    FILTERS[group].forEach((value, i) => {
      const x = GROUP.x + GROUP.unitX[i], y = GROUP.top - gi * GROUP.pitch + GROUP.unitY;
      // the check box and its label (the unit's AlignTableSpace: from the box to the end of the label)
      hitButton(inner, [origin[0] + (x - 130) * S, -(y + 64) * S, 520 * S, 128 * S], () => toggle(group, value), optionLabel[group][value](), Z + 60);
    });
  });
  // the game's thin scrollbar in the list's right gutter, when the groups do not fit
  const bar = document.createElement("div");
  bar.className = "scrollbar display-bar";
  Object.assign(bar.style, { left: `${l + w - 18}px`, top: `${t + 10}px`, height: `${h - 20}px`, zIndex: Z + 80 });
  bar.appendChild(document.createElement("i"));
  bar.hidden = contentH <= h;
  host.appendChild(bar);
}

function syncBar(list) {
  const bar = $("display").querySelector(".display-bar");
  if (!bar || bar.hidden) return;
  const viewH = list.clientHeight, total = list.scrollHeight, track = viewH - 20;
  const th = Math.max(40, track * Math.min(1, viewH / Math.max(1, total)));
  const thumb = bar.firstChild;
  thumb.style.height = `${th}px`;
  thumb.style.top = `${(track - th) * (total > viewH ? list.scrollTop / (total - viewH) : 0)}px`;
}

function onKey(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
}

function finish(result) {
  const host = $("display");
  host.hidden = true;
  host.innerHTML = "";
  removeEventListener("keydown", onKey);
  const fn = done;
  done = null;
  fn?.(result);
}

// open({view, count, onDone}): view is the roster's view (sort, order, filters); count(draft) the number of cards the
// draft shows; onDone(draft) with the confirmed draft, or null when cancelled
export async function open({ view, count: counter, onDone }) {
  await load();
  draft = { sort: view.sort, order: view.order, filters: clone(view.filters || {}) };
  count = counter;
  done = onDone;
  scroll = 0;
  $("display").hidden = false;
  addEventListener("keydown", onKey);
  await render();
}

let loading = null;
const load = () => (loading ||= Promise.all([NGUI.layout("UIPopup_FilterSort"), NGUI.layout("UIFilterObjectList")])
  .then(([fs, group]) => { layout = { fs, group }; }, (err) => { loading = null; throw err; }));

// draw both tabs once off screen, so the first open finds the frame's images made (the popup's large panels take
// a while to slice the first time); once per session, started when the pointer comes to the sort button
let warming = null;
export function warm() {
  warming ||= drawAhead().catch((err) => { warming = null; console.warn("display warm-up", err); });
  return warming;
}
async function drawAhead() {
  await load();
  if (!$("display").hidden) return;
  const keep = [draft, tab, count];
  draft = { sort: SORTS[0], order: NATURAL[SORTS[0]], filters: {} };
  count = () => 0;
  const trees = [];
  for (const id of ["filter", "sort"]) { tab = id; trees.push(frameTree()); }
  trees.push(groupsTree());
  [draft, tab, count] = keep;
  const scratch = document.createElement("div");
  await Promise.all(trees.map((t) => NGUI.render(t, scratch, { scale: S, origin: [960, 540] })));
}

export const isOpen = () => !$("display").hidden;
