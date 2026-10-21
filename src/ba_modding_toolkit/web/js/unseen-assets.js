// A mod stays new until its configured preview or its switch-popup card has been shown.
import { candidates, previewKey } from "./switch-sources.js";

export const hasUnseen = (variant, kind = null) => (variant?.modList || []).some((mod) => mod.fresh && (!kind || mod.kind === kind));

const assetId = (mod) => mod.repaired_from || mod.id;
function shownAsset(family, variant, kind, enabled) {
  const key = previewKey(variant, kind, enabled);
  return family.variants.flatMap((entry) => entry.modList || []).find((mod) => mod.kind === kind && `m:${mod.id}` === key);
}

export function shownUnseen(family, variant, kind, enabled = true) {
  const shown = shownAsset(family, variant, kind, enabled);
  return shown ? family.variants.flatMap((entry) => entry.modList || []).filter((mod) => mod.fresh && assetId(mod) === assetId(shown)) : [];
}

export function switchUnseen(family, variant, kind, enabled = true) {
  const shown = shownAsset(family, variant, kind, enabled);
  return candidates(family, variant, kind).some((source) => source.kind === "mod" && source.mod.fresh && assetId(source.mod) !== (shown && assetId(shown)));
}

export function clearUnseen(family, ids) {
  const seen = new Set(ids);
  for (const variant of family?.variants || []) {
    for (const mod of variant.modList || []) if (seen.has(mod.id)) mod.fresh = false;
    variant.fresh = hasUnseen(variant);
  }
}
