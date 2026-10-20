import * as NGUI from "./ngui.js";
import { T } from "./i18n.js";
import { $, S } from "./util.js";
import { closable, hit as hitNode, popupFrame } from "./popup.js";

const { node, label, find } = NGUI;

// Compare assets on the existing popup frame, in a detail or stage-level host.
export async function show(result, title = T("act.compare"), hostId = "popup") {
  const host = $(hostId);
  const t = popupFrame(title, 1900, 1180);
  const popup = find(t, "Popup");
  const rows = (result.assets || []).filter((d) => d.status !== "same").slice(0, 12);
  const color = { changed: "#d9822b", added: "#1f9a52", removed: "#c0392b" };
  if (!rows.length) popup.children.push(node("None", [0, 120], [label(T("compare.none"), 44, "#2d4664/1.00", 1600, 60, { depth: 8 })]));
  rows.forEach((d, i) => {
    const y = 400 - i * 64;
    popup.children.push(node(`R_${i}`, [-820, y], [label(`${d.type} - ${d.name}`, 38, "#2d4664/1.00", 1300, 50, { pivot: 3, depth: 8, ellipsis: true })]),
      node(`S_${i}`, [820, y], [label(T(`compare.${d.status}`), 38, `${color[d.status] || "#2d4664"}/1.00`, 300, 50, { pivot: 5, depth: 8 })]));
  });
  host.hidden = false;
  const next = document.createElement("div");
  const view = await NGUI.render(t, next, { scale: S, origin: [960, 540], z: 10 });
  let finish;
  const closed = new Promise((resolve) => { finish = resolve; });
  const done = () => { host.hidden = true; host.innerHTML = ""; finish(); };
  hitNode(next, view, "Center/Popup/Base/BG/Btn_Close", done, { name: T("display.close"), action: "close" });
  closable(view, host, done);
  host.replaceChildren(...next.childNodes);
  return closed;
}

