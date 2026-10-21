// Batch Import's artwork is cloned from runtime game layouts. Only container dimensions and data slots adapt
// to the approved two-column screen; sprite slicing, inclines, decoration, colours and typography stay in NGUI.
import { countNodes, iconsOf } from "./mod-counts.js";
import { resizeButton } from "./button-layout.js";
import { clone } from "./util.js";

const INVENTORY = "Inventory_ListControl";
const LIST = `${INVENTORY}/RightCanvas/ListBG`;
const DETAIL = `${INVENTORY}/Left_Info/EquipInfo/Equip_Target`;
const FILTER = "Center/Popup/Filter/ScrollView/Filter_List/Table_List/UIFilterObjectList_1";
const RADIO = "Center/Popup/Sort/Scroll View/Sort_Normal/Option_Normal/Grid/UISortObjectListUnit/Label_Text";
export const ROW_SCALE = 0.54, ROW_WIDTH = 2208 * ROW_SCALE, ROW_HEIGHT = 348 * ROW_SCALE;
const rowGap = (ui, layouts) => 348 - ui.find(layouts.UIMailBoxContent, "List_01/BG").widgets.find((w) => "sprite" in w).h_;

export async function loadImportLayouts(ui) {
  const names = ["UINonEquipmentInventory", "UIMailBox", "UIMailBoxContent", "UIPopup_FilterSort", "UINonEquipmentInventoryListItem",
    "UIPopup_GachaCharList.Btn_Checkbox"];
  return Object.fromEntries(await Promise.all(names.map(async (name) => [name, await ui.layout(name)])));
}

export function importArtwork(ui, layouts) {
  const get = (prefab, path) => {
    const n = path ? ui.find(layouts[prefab], path) : layouts[prefab];
    if (!n) throw new Error(`Import prefab node missing: ${prefab}/${path}`);
    const t = clone(n); t.active = true; return t;
  };
  const at = (n, x = 0, y = 0) => { n.pos = [x, y]; return n; };
  const label = (n, caption, width = null, lines = 1) => {
    const w = n.widgets.find((w) => "text" in w);
    const f = ui.fitText(caption, w.fontSize, w.fontSize * 0.7, width ?? w.w_, lines);
    Object.assign(w, { text: f.text, fontSize: f.fs, w_: width ?? w.w_, h_: Math.max(w.h_, f.fs * 1.3 * String(f.text).split("\n").length) });
    return n;
  };
  const inventory = (path) => get("UINonEquipmentInventory", path);
  const mail = (path) => get("UIMailBox", path);
  const content = (path) => get("UIMailBoxContent", path);
  const filter = (path) => get("UIPopup_FilterSort", path);

  return {
    label,
    rowGap: () => rowGap(ui, layouts) * ROW_SCALE,
    // UINonEquipmentInventory/Inventory_ListControl/BG, including the game's two background textures.
    background: () => at(inventory(`${INVENTORY}/BG`)),
    // Items/ListBG: retain its paper and inset; replace its grid with the scrolling mail cards.
    panel(width, height) {
      const t = at(inventory(LIST));
      t.children = t.children.filter((c) => ["PaperBG", "Inbox"].includes(c.name));
      Object.assign(t.widgets.find((w) => "sprite" in w), { w_: width, h_: height });
      for (const c of t.children) {
        const w = c.widgets.find((w) => "sprite" in w);
        const inset = c.name === "PaperBG" ? 9 : 45;
        Object.assign(w, { w_: width - inset, h_: height - (c.name === "PaperBG" ? 152 : 182) });
        c.pos[1] = -60; c.children = [];
      }
      return t;
    },
    // Anchor Items' complete header to the panel's top/right; only its title follows the left edge.
    header(width, title, caption, filtered, ascending, searching) {
      const t = inventory(`${LIST}/BG_Top_Widget`);
      const panel = ui.find(layouts.UINonEquipmentInventory, LIST).widgets.find((w) => "sprite" in w);
      t.pos[0] += width - panel.w_ / 2; t.pos[1] -= panel.h_ / 2;
      const heading = ui.find(t, "Label_Locale_Title");
      heading.pos[0] -= width - panel.w_;
      label(heading, title, 660).widgets.find((w) => "text" in w).ellipsis = true;
      const sort = ui.find(t, "SortBtn/Btn_Normal");
      for (const name of ["FilterMarker_Off", "FilterMarker_On"]) ui.find(sort, name).active = (name === "FilterMarker_On") === filtered;
      ui.find(sort, "Type_1").active = false; ui.find(sort, "Type_2").active = true;
      label(ui.find(sort, "Type_2/Text"), caption).widgets.find((w) => "text" in w).ellipsis = true;
      const order = ui.find(t, "OrderBtn/Btn_Normal");
      ui.find(order, "Icon_down").active = !ascending; ui.find(order, "Icon_Up").active = ascending;
      ui.find(t, "SearchBtn/Btn_Normal").active = !searching;
      ui.find(t, "SearchBtn/Btn_Pressed").active = searching;
      return t;
    },
    // Mailbox's top/right count stays in the paper header, outside the scrolling list.
    count: (caption) => {
      const t = at(mail("Right/Label_Amount")), w = t.widgets.find((w) => "text" in w), height = w.h_;
      label(t, caption, 500); Object.assign(w, { h_: height, ellipsis: true }); return t;
    },
    searchTop() {
      const panel = ui.find(layouts.UINonEquipmentInventory, LIST);
      return panel.widgets.find((w) => "sprite" in w).h_ / 2 - ["Inbox", "Inbox/SearchInfo", "Inbox/SearchInfo/SearchName", "Inbox/SearchInfo/SearchName/SearchNameArea"]
        .reduce((y, path) => y + ui.find(panel, path).pos[1], 0);
    },
    // Items' white search field, outline, search icon and clear icon. Resize actual sprite widgets:
    // SearchNameArea starts with a nonvisual component in exported layouts, not its background sprite.
    search(width, searching = true) {
      const t = at(inventory(`${LIST}/Inbox/SearchInfo/SearchName/SearchNameArea`));
      const body = t.widgets.find((w) => "sprite" in w), delta = width - body.w_;
      body.w_ = width;
      ui.find(t, "BG_Line").widgets.find((w) => "sprite" in w).w_ = width;
      ui.find(t, "Icon_Search").pos[0] -= delta / 2;
      ui.find(t, "Btn_Close").pos[0] += delta / 2;
      ui.find(t, "Icon_Search").active = searching;
      ui.find(t, "Btn_Close").active = searching;
      for (const c of ui.find(t, "InputField").children) {
        const w = c.widgets.find((w) => "text" in w);
        w.text = "";
        w.w_ = searching ? w.w_ + delta : width - 60;
      }
      return t;
    },
    inputStyle(scale) {
      const w = ui.find(layouts.UINonEquipmentInventory, `${LIST}/Inbox/SearchInfo/SearchName/SearchNameArea/InputField/Label_Search`).widgets.find((w) => "text" in w);
      return { color: w.color.split("/")[0], caretColor: w.color.split("/")[0], fontSize: `${w.fontSize * scale}px` };
    },
    // MailboxContent/List_01/Btn_Receive supplies every blue action; Items/Bottom/Use/UseBtn supplies Import.
    // Clone the entire disabled state, including its dark dotted B_C patterns, not just its body/label colours.
    button(caption, width, primary = false, enabled = true) {
      const t = primary ? inventory(`${INVENTORY}/RightCanvas/Bottom/${enabled ? "Use" : "None"}/UseBtn`)
        : enabled ? content("List_01/Btn_Receive") : mail("Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn_Disable");
      at(t);
      const body = primary ? ui.find(t, "BG") : t;
      if (primary) {
        const [x, y] = body.pos;
        for (const c of t.children) { c.pos[0] -= x; c.pos[1] -= y; }
      }
      resizeButton(body, width);
      // NGUI's DOM renderer uses sprite flips for mirroring; negative prefab scales would produce negative CSS sizes.
      for (const c of body.children) for (const w of c.widgets) if (/^Common_Btn_.*_Pt$/.test(w.sprite || "")) {
        w.flip = (w.flip || 0) ^ (c.scale[0] < 0 ? 1 : 0) ^ (c.scale[1] < 0 ? 2 : 0);
        c.scale = c.scale.map(Math.abs);
      }
      const captionNode = ui.find(t, primary ? enabled ? "Label_Locale_Use" : "Text" : "Label_Locale");
      label(captionNode, caption, width - 60, 2);
      const w = captionNode.widgets.find((w) => "text" in w), height = body.widgets.find((w) => "sprite" in w).h_ - 20;
      if (w.h_ > height) { w.fontSize *= height / w.h_; w.h_ = height; }
      return t;
    },
    // UIPopup_GachaCharList.Btn_Checkbox, as the roster's variant grouping toggle: its own caption, the body sized to it.
    toggle(caption, on) {
      const t = at(get("UIPopup_GachaCharList.Btn_Checkbox")), text = label(ui.find(t, "Locale_Text"), caption, 460);
      const w = text.widgets.find((w) => "text" in w);
      t.widgets.find((w) => "sprite" in w).w_ = text.pos[0] + ui.glyphWidth(w.text, w.fontSize) + 46;
      for (const c of t.children) if (c.name.startsWith("Type_")) {
        c.children = c.children.filter((k) => k.name === "Check");
        c.active = (c.name === "Type_ON") === on;
      }
      return t;
    },
    // UIPopup_FilterSort's actual UIFilter_CheckBox, also used by the roster's display settings.
    checkbox(checked, disabled = false) {
      const t = at(filter(`${FILTER}/Table_Align/Table_ListUnit/UIFilterObjectListUnit_1/UIFilter_CheckBox`));
      ui.find(t, "CheckBoxIcon").active = checked && !disabled;
      ui.find(t, "CheckBoxIcon_Disable").active = checked && disabled;
      return t;
    },
    // UIPopup_FilterSort/UISortObjectListUnit/Label_Text, matching display.js's sortUnit.
    radio(caption, checked, width = 1500) {
      const t = at(filter(RADIO));
      ui.find(t, "On").active = checked;
      ui.find(t, "Label_On").active = !checked;
      for (const p of ["On/Label_On", "Label_On"]) label(ui.find(t, p), caption, width - 100, 2);
      ui.find(t, "Line").widgets[0].w_ = width;
      return t;
    },
    // Items/EquipPos: bind comparison art to its UITexture without the decorative backing circle.
    preview(caption, headerHeight) {
      const t = at(inventory(`${INVENTORY}/EquipPos`));
      const picture = ui.find(t, "Texture");
      picture.widgets[0].h_ = 837; picture.pos[1] = -headerHeight - picture.widgets[0].h_ / 2;
      t.children = t.children.filter((child) => child.name !== "BGCilcle");
      const tag = inventory(`${DETAIL}/Text_Type`);
      const bg = ui.find(tag, "TypeBG"), body = bg.widgets[0];
      at(tag, -240, -(bg.pos[1] + body.h_ / 2) * tag.scale[1]); label(tag, caption, 500);
      body.w_ = 520;
      t.children.push(tag); return t;
    },
    // Items/Equip_Target: keep the dark name plate, texture and category tag. Quantity/expiry are irrelevant to Mods.
    banner(name, kind) {
      const t = at(inventory(DETAIL));
      t.children = t.children.filter((c) => ["BG", "Label_Name", "Text_Type"].includes(c.name));
      ui.find(t, "BG").children = ui.find(t, "BG").children.filter((c) => c.name !== "HaveBG");
      label(ui.find(t, "Label_Name"), name, 1160, 1);
      const tag = ui.find(t, "Text_Type"); label(tag, kind, 850);
      ui.find(tag, "TypeBG").widgets[0].w_ = 910;
      return t;
    },
    // MailboxContent/List_01 (unread) and List_02 (muted/read): the real card, title, divider and meta slots.
    // The sender becomes the aligned kind column; TimeLimit becomes status; receipt/expiry become metadata/reason.
    row({ name, kind, state, stateKey = "ready", meta, route = "", note = "", muted = false, counts = null, badge = true }) {
      const t = at(content(muted ? "List_02" : "List_01"));
      t.children = t.children.filter((c) => ["BG", "Deco", "Deco (1)", "Sprite", "Line", "BG_Icon", "Label_System", "Label_From",
        "Label_Locale_Received", "Label_Locale_Limit", "TimeLimit"].includes(c.name));
      ui.find(t, "BG_Icon").children = ui.find(t, "BG_Icon").children.filter((c) => c.name === "Icon_Arona");
      const picture = ui.find(t, "BG_Icon/Icon_Arona"), slot = picture.widgets.find((w) => "texture" in w);
      picture.active = true;
      ui.find(t, "BG_Icon").widgets = [];
      // Use a rectangular crop inside the mail icon slot, clear of the inclined card edge and text column.
      Object.assign(slot, { w_: 252, h_: 260, pivot: 4 });
      picture.pos = [0, 0]; picture.scale = [1, 1];
      ui.find(t, "BG_Icon").pos = [-914, 0];
      label(ui.find(t, "Label_System"), name, 1688, 1);
      // Keep the card's title, divider and row pitch; reserve the bottom right for three fixed columns.
      const sender = ui.find(t, "Label_From"); at(sender, 110, -23); label(sender, kind, 360, 2);
      sender.widgets[0].pivot = 4;
      if (counts) {
        const kinds = ["spr", "lobby", "model", "other"].filter((kind) => counts[kind] > 0);
        at(sender, 220, -23); sender.widgets = [];
        sender.children = countNodes(counts, iconsOf(ui.atlasIndex?.()), ui.translate, { kinds, width: 800,
          color: ui.find(t, "Label_System").widgets[0].color });
      }
      const received = ui.find(t, "Label_Locale_Received"); received.children = []; label(received, meta, 620, 1);
      at(received, -760, -10);
      const platform = clone(received); platform.name = "Platform"; at(platform, received.pos[0], -84);
      const routeLabel = platform.widgets.find((w) => "text" in w);
      routeLabel.fontSize = Math.min(routeLabel.fontSize, 42); routeLabel.h_ = routeLabel.fontSize * 1.3;
      label(platform, route, 620, 1); t.children.push(platform);
      let limit = ui.find(t, "Label_Locale_Limit");
      if (!limit) { limit = content("List_01/Label_Locale_Limit"); t.children.push(limit); }
      limit.children = []; at(limit, -760, -138);
      const noteLabel = limit.widgets.find((w) => "text" in w);
      noteLabel.fontSize = Math.min(noteLabel.fontSize, 36); noteLabel.h_ = noteLabel.fontSize * 1.3;
      label(limit, note, 1360, 1);
      // TimeLimit is only present on the unread card; clone that same node for read cards as well.
      let status = ui.find(t, "TimeLimit");
      if (!status) { status = content("List_01/TimeLimit"); t.children.push(status); }
      status.active = badge;
      at(status, 605, -23);
      ui.find(status, "Bg").widgets[0].w_ = 540;
      const tones = {
        ready: inventory(`${DETAIL}/Text_Amount`).widgets[0].color,
        convert: mail("Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn").widgets[0].color,
        update: mail("Bottom/ObjectsDisplayed_Unread/ReceiveAll/Btn").widgets[0].color,
        library: content("List_02/BG").widgets[0].color,
        installed: content("List_02/Label_System").widgets[0].color,
        done: content("List_02/Label_System").widgets[0].color,
        blocked: inventory(`${DETAIL}/Label_ExpirationDateTime/TypeBG`).widgets[0].color,
      };
      ui.find(status, "Bg").widgets[0].color = tones[stateKey] || tones.blocked;
      const statusLabel = ui.find(status, "Label_Locale_TimeLimit");
      if (["ready", "convert", "update", "library"].includes(stateKey)) statusLabel.widgets[0].color = inventory(`${DETAIL}/Text_Type`).widgets[0].color;
      if (muted) statusLabel.widgets[0].fontSize *= 0.8;
      label(statusLabel, state, 510, 2);
      ui.find(status, "Bg").widgets[0].h_ = statusLabel.widgets[0].h_ + 8;
      return t;
    },
    // Items list card's Cover_Select provides the selected preview marker, independently of import selection.
    selection() {
      const root = layouts.UINonEquipmentInventoryListItem;
      return at(get("UINonEquipmentInventoryListItem", `${root.children[0].name}/Normal/Cover_Select`));
    },
    // Items/ListEmpty label; Mailbox's footer note is the status/progress text slot (no synthetic progress widget).
    empty: (caption) => at(label(inventory(`${LIST}/Inbox/ListEmpty/Label_Locale_EmptyMessage`), caption, 1700, 2)),
    note: (caption) => at(label(mail("Bottom/ObjectsDisplayed_Unread/Label_Locale"), caption, 1678, 2)),
    // Items' expiry tag supplies the error tone; read mail's title supplies the muted note tone.
    error(caption) {
      const t = at(label(inventory(`${LIST}/Inbox/ListEmpty/Label_Locale_EmptyMessage`), caption, 1700, 2));
      t.widgets[0].color = inventory(`${DETAIL}/Label_ExpirationDateTime/TypeBG`).widgets[0].color;
      return t;
    },
  };
}

export { clipButtonPatterns } from "./button-layout.js";
