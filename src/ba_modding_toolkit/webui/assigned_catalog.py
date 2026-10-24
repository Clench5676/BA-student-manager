"""Expose saved character ownership without inventing installed asset handles."""

from copy import deepcopy
from typing import Any, Iterable


def families_with_assignments(catalog: Any, assignments: Iterable[str]) -> list:
    """Append only saved assignments to the local roster, using offline cross-server names."""
    families = {family.key: deepcopy(family) for family in catalog.families()}
    present = {variant.key for family in families.values() for variant in family.variants}
    wanted = set(assignments) - present
    if not wanted:
        return list(families.values())
    for available in catalog.assignment_families():
        selected = [variant for variant in available.variants if variant.key in wanted]
        if not selected:
            continue
        if available.key not in families:
            family = deepcopy(available)
            family.variants = []
            families[family.key] = family
        families[available.key].variants.extend(selected)
    for family in families.values():
        family.variants.sort(key=lambda variant: (variant.key != family.key, not variant.recruitable,
                                                  not variant.playable, variant.order, variant.key))
    return [families[key] for key in sorted(families)]


def family_with_assignments(catalog: Any, assignments: Iterable[str], key: str) -> Any:
    for family in families_with_assignments(catalog, assignments):
        if family.key == key.lower():
            return family
    return catalog.family(key)


def stored_asset_fields(variant: Any, mods: Iterable[Any]) -> dict:
    """Preview availability is independent of local installation availability."""
    own = [mod for mod in mods if mod.target == variant.key]
    return {"storedKinds": sorted({mod.kind for mod in own if mod.kind in ("spr", "lobby", "model")}),
            "localKinds": [kind for kind in ("spr", "lobby", "model") if getattr(variant, kind, None)]}
