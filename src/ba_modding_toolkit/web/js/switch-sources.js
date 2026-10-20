// What the detail screen's switch cards offer and what the game shows now, for the portrait ("spr") and the memorial
// lobby ("lobby"): pure functions of the family that family.get returns, tested in Node
// (tests/js/switch_sources.test.mjs). Switching writes the chosen source into the game's files (actions.apply); the
// library keeps what it replaces (docs/web-ui.md, library).

// what the switch card of a detail tab switches: the portrait ("spr") or the memorial lobby ("lobby"); null on the 3D
// tab ("model"), whose card has nothing to switch to (the library keeps no 3D mods): no chevron, no popup
export const switchKindOf = (tab) => (tab === "lobby" ? "lobby" : tab === "portrait" ? "spr" : null);

// the core of a variant's skeleton of a kind: its portrait or its memorial lobby
export const coreOf = (v, kind = "spr") => (kind === "lobby" ? v.lobby : v.spr) || null;

// the game file parts of one kind ("spr" portrait, "lobby" memorial lobby, "model" the 3D chibi's prefab bundles,
// newest first)
export const partsOf = (v, kind = "spr") => (kind === "model" ? v.modelFiles || [] : (v.state?.files || []).filter((f) => f.kind === kind));

// whether a game file part holds official bytes: the server's verdict (family.get's official), else, from a server
// without it, its applied source
export const isOfficial = (f) => (typeof f.official === "boolean" ? f.official : f.applied === "official");

// what the variant's game files of a kind carry now, from their non-official parts only (the library records every
// part of a switched kind, the parts a mod left official included): the one source among them (a mod often replaces
// one part), "official", or "unknown" when they carry several (tests/data/source_rule_cases.json, shared with the
// library's own rule)
export function appliedOf(v, kind = "spr") {
  const sources = new Set(partsOf(v, kind).filter((f) => !isOfficial(f)).map((f) => f.applied));
  return !sources.size ? "official" : sources.size === 1 ? [...sources][0] : "unknown";
}

// the candidate key of what the game shows: "self" (the variant's own official files), "m:<mod id>", "v:<variant
// key>" (another variant's official files, adapted) or "unknown" (changed outside the library)
export function appliedKey(v, kind = "spr") {
  const a = appliedOf(v, kind);
  if (a === "official") return "self";
  if (a.startsWith("mod:")) return `m:${a.slice(4)}`;
  if (a.startsWith("variant:")) return `v:${a.slice(8)}`;
  return "unknown";
}

// a candidate key as an actions.apply source
export const sourceOf = (key) => (key === "self" ? "official" : key.startsWith("m:") ? `mod:${key.slice(2)}` : `variant:${key.slice(2)}`);

// the sources a variant's portrait or lobby can be switched to, in the switch popup's order: its own official files,
// its own mods of that kind, then for the portrait the other variants' official files (those with a portrait of their
// own) and the other variants' portrait mods. Other variants' memorial lobbies and their lobby mods are not offered:
// another student's lobby put under this variant's lobby prefab is untested in the game. Each: { key, kind ("self" |
// "mod" | "variant"), core, variant, id, mod, origin (the variant a mod was made for) }.
export function candidates(fam, v, kind = "spr") {
  const mods = fam.variants.flatMap((o) => o.modList || []).filter((m) => m.kind === kind);
  const own = coreOf(v, kind);
  const across = kind !== "lobby"; // whether other variants' files and mods are offered
  const others = across ? fam.variants.filter((o) => o.key !== v.key && coreOf(o, kind) && coreOf(o, kind) !== own) : [];
  const mod = (m) => ({ key: `m:${m.id}`, kind: "mod", id: m.id, mod: m, core: null, origin: fam.variants.find((o) => o.key === m.target) || null });
  return [
    { key: "self", kind: "self", core: own, variant: v },
    ...mods.filter((m) => m.target === v.key).map(mod),
    ...others.map((o) => ({ key: `v:${o.key}`, kind: "variant", core: coreOf(o, kind), variant: o })),
    ...(across ? mods.filter((m) => m.target !== v.key).map(mod) : []),
  ];
}

// a configured source (family.get's configured[kind]) as a candidate key; null when the kind is not configured
export function configuredKey(v, kind = "spr") {
  const source = v?.configured?.[kind];
  if (typeof source !== "string" || !source || source === "official") return null;
  if (source.startsWith("mod:")) return `m:${source.slice(4)}`;
  if (source.startsWith("variant:")) return `v:${source.slice(8)}`;
  return null;
}

// how the switch popup works (decision 2). With mods on it starts on what the game shows, and Apply writes the choice.
// While mods are off nothing is written: it starts on the configured source (the own files when none), Save only
// configures the choice (it applies when mods are on), and the configured card carries the "Set" chip, apart from In
// Use. The popup applies only a choice other than its start.
//   {start, button: "popup.apply" | "popup.save", set: the configured key while off, else null}
export function popupMode(fam, v, kind = "spr", enabled = true) {
  const inUse = appliedKey(v, kind);
  if (enabled) return { start: inUse, button: "popup.apply", set: null };
  const set = configuredKey(v, kind);
  const start = set && candidates(fam, v, kind).some((c) => c.key === set) ? set : "self";
  return { start, button: "popup.save", set };
}
