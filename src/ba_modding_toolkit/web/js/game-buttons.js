// Complete option and disabled button branches; captions and dimensions are the only substitutions.
import * as NGUI from "./ngui.js";
import { resizeButton } from "./button-layout.js";
import { clone } from "./util.js";

let layouts, loading;
export function ready() {
  return loading ||= Promise.all([NGUI.layout("UIPopup_Option_PC"), NGUI.layout("UIPopup_FilterSort")])
    .then(([option, filter]) => { layouts = { option, filter }; })
    .catch((err) => { loading = null; throw err; });
}

export function disabledButton(filter, original) {
  const tree = clone(NGUI.find(filter, "Center/Popup/Btn_Section/Btn_Disable"));
  tree.name = original.name;
  tree.pos = [...original.pos];
  tree.scale = [...original.scale];
  tree.active = true;
  const body = NGUI.find(tree, "BG (1)"), oldBody = NGUI.find(original, "BG (1)") || original;
  const size = oldBody.widgets.find((w) => "sprite" in w);
  resizeButton(body, size.w_, size.h_);
  body.pos = oldBody !== original ? [...oldBody.pos] : [0, 0];
  for (const w of tree.widgets) if ("w_" in w) Object.assign(w, { w_: size.w_, h_: size.h_ });
  const oldLabel = NGUI.find(original, "Label_Locale"), caption = NGUI.find(tree, "Label_Locale");
  if (oldLabel) {
    const color = caption.widgets[0].color;
    caption.pos = [...oldLabel.pos];
    Object.assign(caption.widgets[0], oldLabel.widgets[0], { color });
  }
  return tree;
}

export const disable = (original) => disabledButton(layouts.filter, original);

export function optionButton(option, filter, name, x, y, caption, { w = 300, h = 112, enabled = true, fs = 44, min = 30, depth = 10, semantic = "secondary" } = {}) {
  let tree = clone(NGUI.find(option, "Center/Popup/List/Sound_Setting/ETCSetting/ButtonBg"));
  tree.name = name;
  tree.pos = [x, y];
  resizeButton(tree, w, h);
  const label = NGUI.find(tree, "Label_Locale");
  NGUI.fitLabel(label.widgets[0], caption, fs, min, w - 60);
  label.widgets[0].w_ = w - 30;
  label.widgets[0].h_ = h - 20;
  if (!enabled) tree = disabledButton(filter, tree);
  const shift = (n, d = 0) => {
    for (const widget of n.widgets) if ("sprite" in widget || "text" in widget) widget.depth = depth + ("text" in widget ? 2 : d);
    for (const child of n.children || []) shift(child, d + 1);
  };
  tree.actionSemantic=enabled?semantic:"secondary";
  shift(tree);
  return tree;
}

export const smallButton = (...args) => optionButton(layouts.option, layouts.filter, ...args);

// A complete Sort/Btn_Ok in a DOM flow (preview licence prompts); plain text remains available without assets.
export async function skinPrimary(button, caption) {
  button.textContent = caption;
  try {
    const sort = await NGUI.layout("UIPopup_Sort");
    const tree = clone(NGUI.find(sort, "Center/Popup/Btn/Btn_Ok"));
    tree.pos = [0, 0];
    tree.active = true;
    tree.actionSemantic="confirm";
    NGUI.fitLabel(NGUI.find(tree, "Label_Locale").widgets[0], caption, 64, 40, 420);
    const next = document.createElement("div"), scale = 0.4;
    await NGUI.render(tree, next, { scale, origin: [110, 42] });
    await NGUI.decoded([...(next.children || [])], Infinity);
    Object.assign(button.style, { position: "relative", display: "block", margin: "18px auto 0", width: "220px", height: "84px" });
    button.setAttribute("aria-label", caption);
    button.replaceChildren(...next.childNodes);
  } catch (err) { console.warn("preview button without game assets", err); }
}
