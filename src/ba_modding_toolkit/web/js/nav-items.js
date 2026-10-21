// The bottom navigation's entries and what a click on one does, without the DOM (tested in Node from
// tests/test_nav_items.py). An entry with a web screen has a route; one without has the classic GUI's tab
// (webui/system.py CLASSIC_TABS) and is greyed out: drawn with the game's disabled tint, still a button, and a click
// hands over to the classic UI, through the hand-off prompt while the pref classicPrompt is on. An entry that gets a
// route is drawn normally and drops out of the hand-off.

export const ITEMS = Object.freeze([
  { label: "nav.students", icon: "Common_Icon_Student", route: "#/roster" },
  { label: "nav.import", icon: "Common_Icon_All_Download", route: "#/import" },
  { label: "nav.crc", icon: "School_Icon_Schedule", classic: "crc_tool" },
  { label: "nav.pack", icon: "Common_Icon_Craft", classic: "asset_packer" },
  { label: "nav.extract", icon: "Common_Icon_Inventory_Equip", classic: "asset_extractor" },
  { label: "nav.adb", icon: "Common_Icon_MoMoTalk", classic: "adb_push" },
  { label: "nav.tools", icon: "Common_Icon_Setting_Game", classic: "tools" },
].map((item) => Object.freeze(item)));

// greyed exactly when the entry has a classic tab and no web screen
export const greyed = (item) => !!item.classic && !item.route;

// how an entry is drawn: its label, the accessible name ("{label} - Classic UI" for a greyed one, the label alone
// otherwise; never a tooltip), whether it is greyed, and where it goes (route, or the classic tab it hands off)
export function view(item, T) {
  const label = T(item.label);
  const grey = greyed(item);
  return { label, name: grey ? T("nav.classic", { label }) : label, greyed: grey, route: item.route || null, tab: grey ? item.classic : null };
}

// the hand-off prompt (popup.js message): the entry's label, where it opens, Don't Ask Again (unticked), Cancel and
// Open
export const handOffPrompt = (item, T) => ({
  title: T(item.label), lines: [T("classic.hint")], check: { label: T("mods.dontAsk"), checked: false },
  ok: T("settings.classic.open"), cancel: T("popup.cancel"),
});

// a click (or Enter, or Space) on an entry:
//   prompt   whether the hand-off prompt shows first (the pref classicPrompt; on unless it is false)
//   go(route)          shows a web screen
//   ask(item)          the hand-off prompt; resolves with {button, checked}: "ok" is Open, the box Don't Ask Again
//   open(tab)          hands over to the classic UI on that tab
//   savePrompt(false)  turns the prompt off; only Open with the box ticked calls it, before the hand-off
// Resolves with what happened: "route", "cancel" or "open".
export async function activate(item, { prompt = true, go, ask, open, savePrompt }) {
  if (!greyed(item)) {
    if (item.route) go(item.route);
    return "route";
  }
  if (prompt !== false) {
    const answer = await ask(item);
    if (answer?.button !== "ok") return "cancel";
    if (answer.checked) await savePrompt(false);
  }
  await open(item.classic);
  return "open";
}

// --- the greyed look ---
// The game draws a locked lobby entry (UILobby's bottom menu, Front/Bottom/Menu/BG/Grid/<entry>) with its Disable node:
// the icon's sprite tinted (#797979 in the 2026-10 resource version) under a lock, the label in its usual colour. The
// tool takes the tint alone (no lock: these entries are not locked, they open elsewhere). In order:
//   "game"   the tint of the first entry's Disable/Icon, as a brightness factor (NGUI multiplies the sprite by it)
//   "ngui"   NGUI's default disabled colour (Color.grey): the icon and the label at half brightness
//   "plain"  no game folder: the icon in grey at half brightness, the label in the settings' disabled grey
export const NGUI_GREY = 0.5;

const rgbOf = (color) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color || "");
  return m ? m.slice(1, 4).map((h) => parseInt(h, 16) / 255) : null;
};

// grid: the layout of UILobby's Front/Bottom/Menu/BG/Grid (or null when there is no game, or it could not be read)
export function tintOf(grid, { game = true } = {}) {
  if (!game) return { mode: "plain", factor: NGUI_GREY };
  for (const entry of grid?.children || []) {
    const icon = (entry.children || []).find((c) => c.name === "Disable")?.children?.find((c) => c.name === "Icon");
    const rgb = rgbOf(icon?.widgets?.find((w) => "sprite" in w)?.color);
    // a grey tint is a brightness factor; a coloured one (none so far) is taken by its mean
    if (rgb) return { mode: "game", factor: Math.round((rgb.reduce((a, b) => a + b, 0) / 3) * 10000) / 10000 };
  }
  return { mode: "ngui", factor: NGUI_GREY };
}
