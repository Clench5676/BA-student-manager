// Drafts and picker ordering are independent of DOM and game playback.
import { order, normalizeView, fold, terms } from "./roster-order.js";
import { PORTRAIT_ANCHOR, hallScale } from "./student-hall-framing.js";

const copy = (value) => structuredClone(value);
export const sourceKey = (source) => `${source.variant}:${source.source}`;
function canonicalDraft(value) {
  const result = copy(value); result.portraitScale = hallScale(result.portraitScale);
  for (const group of ["portraits", "memorials"]) {
    const kept = new Map();
    result[group] = result[group].filter((entry) => {
      if (!entry.variant || !entry.source) return true;
      const key = sourceKey(entry), first = kept.get(key);
      if (!first) { kept.set(key, entry); return true; }
      if (group === "memorials" && entry.id === result.active) first.id = entry.id;
      return false;
    });
  }
  return result;
}
export function createDraft(saved) {
  let base = canonicalDraft(saved), draft = null, kind = null;
  const content = (value) => JSON.stringify({ ...value, revision: 0 });
  return {
    current: () => draft || base,
    saved: () => base,
    kind: () => kind,
    begin(next) { if (!draft) { draft = copy(base); kind = next; } return draft; },
    dirty: () => !!draft && content(draft) !== content(base),
    cancel() { draft = null; kind = null; },
    accept(value) { base = canonicalDraft(value); draft = null; kind = null; },
    add(choice, uuid = () => crypto.randomUUID()) {
      if (!draft) throw new Error("No Hall draft");
      const entries = choice.kind === "spr" ? draft.portraits : draft.memorials;
      if (entries.some((entry) => sourceKey(entry) === sourceKey(choice))) return null;
      const entry = { id: uuid(), variant: choice.variant, source: choice.source };
      if (choice.kind === "spr") {
        const n = draft.portraits.length;
        Object.assign(entry, { x: PORTRAIT_ANCHOR.x + (((n + 2) % 5) - 2) * 240, y: PORTRAIT_ANCHOR.y, scale: 1 }); draft.portraits.push(entry);
      } else { draft.memorials.push(entry); draft.active ||= entry.id; }
      return entry;
    },
    remove(id) {
      if (!draft) return false;
      const list = kind === "layout" ? draft.portraits : draft.memorials;
      if (list.length <= 1) return false;
      const index = list.findIndex((entry) => entry.id === id); if (index < 0) return false;
      list.splice(index, 1);
      if (draft.active === id) draft.active = list[Math.min(index, list.length - 1)]?.id || null;
      return true;
    },
    move(id, before) {
      if (!draft) return false;
      const list = draft.memorials, from = list.findIndex((e) => e.id === id), to = list.findIndex((e) => e.id === before);
      if (from < 0 || to < 0 || from === to) return false;
      const [entry] = list.splice(from, 1); list.splice(to, 0, entry); return true;
    },
    layer(id, direction) {
      if (!draft || kind !== "layout") return false;
      const list = draft.portraits, from = list.findIndex((entry) => entry.id === id);
      if (from < 0) return false;
      const to = direction === "front" ? list.length - 1 : direction === "back" ? 0
        : Math.max(0, Math.min(list.length - 1, from + direction));
      if (from === to) return false;
      const [entry] = list.splice(from, 1); list.splice(to, 0, entry); return true;
    },
    flip(id) {
      if (!draft || kind !== "layout") return false;
      const entry = draft.portraits.find((item) => item.id === id);
      if (!entry) return false;
      entry.mirror = !entry.mirror; return true;
    },
  };
}

export function pickerData(choices, kind = null) {
  if (kind) choices = choices.filter((choice) => choice.kind === kind);
  const families = new Map(), variants = new Map();
  for (const choice of choices) {
    const family = choice.family || choice.variant;
    if (!families.has(family)) families.set(family, { key: family, base: choice.familyNames || {}, aliases: choice.familyAliases || [], school: choice.school, variants: [] });
    if (!variants.has(choice.variant)) {
      const v = { key: choice.variant, family, names: choice.names || {}, aliases: choice.aliases || [], custom: choice.custom || [],
        fileId: choice.fileId, model: choice.model, portrait: choice.portrait, favorite: !!choice.favorite, recruitable: choice.released ?? choice.recruitable ?? !!choice.core,
        order: choice.order || 0, recent: choice.recent, added: choice.modAdded || choice.added, mods: kind ? 0 : choice.mods || 0,
        modsReported: !kind && Number.isFinite(choice.mods), modNames: [], modCounts: { spr: 0, lobby: 0 } };
      variants.set(choice.variant, v); families.get(family).variants.push(v);
    }
    const v = variants.get(choice.variant);
    v.aliases = [...new Set([...v.aliases, ...(choice.aliases || [])])];
    v.custom = [...new Set([...v.custom, ...(choice.custom || [])])];
    const added = choice.modAdded || choice.added;
    if (added && (!v.added || Date.parse(added) > Date.parse(v.added))) v.added = added;
    if (choice.kind === "spr") v.spr ||= choice.core || choice.source;
    if (choice.kind === "lobby") v.lobby ||= choice.core || choice.source;
    if (choice.source.startsWith("mod:")) {
      if (!v.modsReported) v.mods++; v.modCounts[choice.kind]++; v.modNames.push(choice.label || "");
      if (choice.kind === "spr") v.replaced = choice.source;
    }
  }
  return { families: [...families.values()] };
}
export function studentChoices(choices, view, query, label, locale, kind = null) {
  return order(pickerData(choices, kind), normalizeView(view), { query, label,
    collator: new Intl.Collator(locale, { numeric: true, sensitivity: "base" }) });
}
const namesOf = (data) => Object.values(data || {}).flatMap((name) => typeof name === "string" ? [name] : [name?.full, name?.short]);
function sourceMatches(choice, words) {
  const text = fold([choice.label, choice.variant, choice.fileId, ...(choice.aliases || []), ...(choice.custom || []), ...(choice.familyAliases || []),
    ...namesOf(choice.names), ...namesOf(choice.familyNames)].filter(Boolean).join(" "));
  return !words.length || words.every((word) => text.includes(word));
}
export function portraitRows(choices, view, query, label, locale) {
  const mods = choices.filter((c) => c.kind === "spr");
  const cards = studentChoices(choices, view, query, label, locale, "spr"), words = terms(query);
  return cards.map((student) => ({ student, key: view.merged ? student.family : student.key,
    choices: mods.filter((c) => {
      const belongs = view.merged ? (c.family || c.variant) === student.family : c.variant === student.key;
      return belongs && sourceMatches(c, words);
    }) })).filter((row) => row.choices.length);
}
export function memorialChoices(choices, students, selected, view, query, viewed = {}, label = (names) => names?.en, locale = "en") {
  const keyOf = (choice) => view.merged ? choice.family || choice.variant : choice.variant;
  const visible = new Set(students.map((student) => view.merged ? student.family : student.key)), words = terms(query);
  const selectedKey = view.merged ? students.find((student) => student.key === selected)?.family || selected : selected;
  const list = choices.filter((choice) => choice.kind === "lobby" && visible.has(keyOf(choice))
    && (!selected || keyOf(choice) === selectedKey) && sourceMatches(choice, words));
  const mods = new Map(students.map((student) => [view.merged ? student.family : student.key, student.mods || 0]));
  const index = new Map(choices.map((choice, i) => [choice, i]));
  const value = (choice) => viewed[sourceKey(choice)] ?? (choice.viewed != null ? -choice.viewed : choice.recent != null ? -1000 - choice.recent : -Infinity);
  const time = (choice) => { const parsed = Date.parse(choice.modAdded || choice.added || ""); return Number.isFinite(parsed) ? parsed : -Infinity; };
  const title = (choice) => [label(choice.names)?.full || choice.variant, choice.label].filter(Boolean).join(" - ");
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const difference = (a, b) => a === b ? 0 : a - b;
  const direction = view.order === "asc" ? 1 : -1;
  return list.sort((a, b) => {
    const result = view.sort === "recent" ? difference(value(a), value(b))
      : view.sort === "added" ? difference(time(a), time(b))
      : view.sort === "name" ? collator.compare(title(a), title(b))
      : view.sort === "mods" ? difference(mods.get(keyOf(a)), mods.get(keyOf(b)))
      : difference(a.order || 0, b.order || 0) || index.get(a) - index.get(b);
    return direction * result || index.get(a) - index.get(b);
  });
}

export function contentBounds(rootBox, toolbarBoxes = [], navBox = null) {
  const scale = rootBox?.width > 0 ? 1920 / rootBox.width : 1, top = rootBox?.top || 0;
  const toolbarBottom = Math.max(180, ...toolbarBoxes.filter((box) => box.height > 0).map((box) => (box.bottom - top) * scale));
  const navTop = navBox?.height > 0 ? (navBox.top - top) * scale : 976;
  return { left: 24, top: toolbarBottom + 16, right: 1896, bottom: Math.min(1044, navTop - 16) };
}
