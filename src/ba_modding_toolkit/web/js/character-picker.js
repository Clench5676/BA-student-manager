// Character ownership uses roster search/order rules and the existing FilterSort popup.
import * as Display from "./display.js";
import { order, normalizeView } from "./roster-order.js";
import { L, T, language } from "./i18n.js";
import { studentName } from "./names.js";

export function assignmentChoices(data, view, query = "") {
  return order(data, normalizeView(view), { query, label: L,
    collator: new Intl.Collator(language(), { numeric: true, sensitivity: "base" }) });
}

export async function characterPicker({ data, selected, dialog, el, button, inputControl, checkbox, radioOptions, onSelect }) {
  let view = normalizeView({ sort: "name", order: "asc" }), query = "", page = 0, family = null;
  let choice = selected || null;
  await dialog(T("import.assignCharacter"), { action: T("picker.ok"), cancel: T("popup.cancel"),
    onAction: () => choice ? onSelect(choice) : false }, (area) => {
    const search = inputControl(T("import.search"), "", { width: 1370, search: true }); area.appendChild(search.wrap);
    const tools = el("div"); Object.assign(tools.style, { display: "flex", flexWrap: "wrap", gap: "12px", margin: "14px 0" });
    const filters = button(T("display.title"), "characterDisplay", { width: 255, scale: 0.34 });
    const direction = button(T("roster.asc"), "characterOrder", { width: 170, scale: 0.34 });
    const mods = button(T("seg.all"), "characterMods", { width: 180, scale: 0.34 });
    const recruit = button(T("seg.all"), "characterRecruit", { width: 230, scale: 0.34 });
    const merged = checkbox(T("roster.merge"), false, (value) => { view.merged = value; family = null; page = 0; draw(); });
    Object.assign(merged.label.style, { position: "relative", width: "460px", height: "55px" });
    tools.append(filters, direction, mods, recruit, merged.label); area.appendChild(tools);
    const list = el("div"); Object.assign(list.style, { maxHeight: "440px", overflowY: "auto" }); area.appendChild(list);
    const pages = el("div"); Object.assign(pages.style, { display: "flex", justifyContent: "space-between" });
    const previous = button("‹", "characterPrevious", { width: 100, scale: 0.34 });
    const next = button("›", "characterNext", { width: 100, scale: 0.34 }); pages.append(previous, next); area.appendChild(pages);
    const label = (variant) => studentName(variant, L(variant.names)?.full || variant.key);
    const draw = () => {
      const cards = assignmentChoices(data, view, query);
      const values = cards.slice(page * 24, page * 24 + 24).flatMap((card) => {
        if (!view.merged) return [[card.key, card.name]];
        const variants = data.families.find((item) => item.key === card.family)?.variants || [];
        return [[`family:${card.family}`, card.name], ...(family === card.family
          ? variants.map((variant) => [variant.key, label(variant)]) : [])];
      });
      list.replaceChildren();
      radioOptions(list, values, choice, (value) => {
        if (value.startsWith("family:")) { family = value.slice(7); draw(); }
        else choice = value;
      }, { columns: 2 });
      previous.disabled = page === 0; next.disabled = (page + 1) * 24 >= cards.length;
      previous.refresh(); next.refresh();
    };
    const searchChanged = () => { query = search.input.value; page = 0; family = null; draw(); };
    search.input.addEventListener("input", (event) => { if (!event.isComposing) searchChanged(); });
    search.input.addEventListener("compositionend", searchChanged);
    search.clear?.addEventListener("click", () => { search.input.value = ""; searchChanged(); });
    previous.addEventListener("click", () => { page--; list.scrollTop = 0; draw(); });
    next.addEventListener("click", () => { page++; list.scrollTop = 0; draw(); });
    direction.addEventListener("click", () => {
      view.order = view.order === "asc" ? "desc" : "asc"; direction.caption = T(`roster.${view.order}`);
      direction.setAttribute("aria-label", direction.caption); direction.refresh(); page = 0; draw();
    });
    const segment = (control, key, values, labels) => control.addEventListener("click", () => {
      const index = (values.indexOf(view[key]) + 1) % values.length; view[key] = values[index];
      control.caption = T(labels[index]); control.setAttribute("aria-label", control.caption); control.refresh(); page = 0; draw();
    });
    segment(mods, "mods", ["all", "mods", "none"], ["seg.all", "seg.mods", "seg.noMods"]);
    segment(recruit, "recruit", ["all", "yes", "no"], ["seg.all", "seg.recruit", "seg.noRecruit"]);
    filters.addEventListener("click", () => Display.open({ view, count: (draft) => assignmentChoices(data, draft, query).length,
      onDone: (draft) => { if (draft) { view = normalizeView({ ...view, ...draft }); page = 0; draw(); } } }));
    draw();
  });
}
