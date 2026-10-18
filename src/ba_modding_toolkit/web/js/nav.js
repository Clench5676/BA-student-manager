// The lobby-style bottom navigation and the top bar. Entries without a new screen open the classic GUI on that tab.
import * as NGUI from "./ngui.js";
import { rpc, spriteUrl } from "./api.js";
import { T } from "./i18n.js";
import { $, toast } from "./util.js";

const ITEMS = [
  { label: "nav.students", icon: "Common_Icon_Student", route: "#/roster" },
  { label: "nav.modUpdate", icon: "Common_Icon_Edit", classic: "mod_update" },
  { label: "nav.batch", icon: "Common_Icon_IDCard", classic: "batch_update" },
  { label: "nav.install", icon: "Common_Icon_All_Download", classic: "mod_install" },
  { label: "nav.crc", icon: "School_Icon_Schedule", classic: "crc_tool" },
  { label: "nav.pack", icon: "Common_Icon_Craft", classic: "asset_packer" },
  { label: "nav.extract", icon: "Common_Icon_Inventory_Equip", classic: "asset_extractor" },
  { label: "nav.adb", icon: "Common_Icon_MoMoTalk", classic: "adb_push" },
  { label: "nav.tools", icon: "Common_Icon_Setting_Game", classic: "tools" },
];

// labels: 26 px, down to 18 px so they stay on one line in their 176 px slot
const navSize = (str) => { for (let fs = 26; fs > 18; fs -= 1) if (NGUI.textWidth(str, fs) / NGUI.fontSizeFor(str, 1) <= 172) return fs; return 18; };

export function renderNav(active = 0) {
  const host = $("nav");
  host.innerHTML = "";
  ITEMS.forEach((item, i) => {
    const b = document.createElement("button");
    b.className = `nav-item${i === active ? " active" : ""}`;
    const icon = document.createElement("i");
    icon.className = "nav-icon";
    icon.style.backgroundImage = `url("${spriteUrl("Common", item.icon)}")`;
    const span = document.createElement("span");
    span.textContent = T(item.label);
    span.style.fontSize = `${navSize(T(item.label))}px`;
    b.append(icon, span);
    b.addEventListener("click", async () => {
      if (item.route) { location.hash = item.route; return; }
      try { await rpc("app.openClassic", { tab: item.classic }); } catch (err) { toast(T(`error.${err.code}`, err.params), { kind: "error" }); }
    });
    host.appendChild(b);
  });
}

export function setTitle(text, onBack) {
  document.querySelector(".topbar .title").textContent = text;
  const back = document.querySelector(".topbar .back");
  back.onclick = onBack || null;
  back.style.visibility = onBack ? "visible" : "hidden";
}
