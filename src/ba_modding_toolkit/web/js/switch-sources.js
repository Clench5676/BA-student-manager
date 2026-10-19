// What the detail screen's switch cards offer and what the game shows now, for the portrait ("spr") and the memorial
// lobby ("lobby"): pure functions of the family that family.get returns, tested in Node
// (tests/js/switch_sources.test.mjs). Switching writes the chosen source into the game's files (actions.apply); the
// library keeps what it replaces (docs/web-ui.md, library).

// the core of a variant's skeleton of a kind: its portrait or its memorial lobby
export const coreOf = (v, kind = "spr") => (kind === "lobby" ? v.lobby : v.spr) || null;

// the game file parts of one kind ("spr" portrait, "lobby" memorial lobby, "model" the 3D chibi's prefab bundles,
// newest first)
export const partsOf = (v, kind = "spr") => (kind === "model" ? v.modelFiles || [] : (v.state?.files || []).filter((f) => f.kind === kind));

// what the variant's game files of a kind carry now: the one non-official source among its parts (a mod often
// replaces one part), "official", or "unknown" when they carry several
export function appliedOf(v, kind = "spr") {
  const sources = new Set(partsOf(v, kind).map((f) => f.applied).filter((a) => a !== "official"));
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
// its own mods of that kind, the other variants' official files (those with their own skeleton of that kind), then
// the other variants' mods of that kind. Each: { key, kind ("self" | "mod" | "variant"), core, variant, id, mod,
// origin (the variant a mod was made for) }.
export function candidates(fam, v, kind = "spr") {
  const mods = fam.variants.flatMap((o) => o.modList || []).filter((m) => m.kind === kind);
  const own = coreOf(v, kind);
  const others = fam.variants.filter((o) => o.key !== v.key && coreOf(o, kind) && coreOf(o, kind) !== own);
  const mod = (m) => ({ key: `m:${m.id}`, kind: "mod", id: m.id, mod: m, core: null, origin: fam.variants.find((o) => o.key === m.target) || null });
  return [
    { key: "self", kind: "self", core: own, variant: v },
    ...mods.filter((m) => m.target === v.key).map(mod),
    ...others.map((o) => ({ key: `v:${o.key}`, kind: "variant", core: coreOf(o, kind), variant: o })),
    ...mods.filter((m) => m.target !== v.key).map(mod),
  ];
}
