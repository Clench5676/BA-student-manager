"""Resolve uploaded bundles from their asset names before storing them."""

from __future__ import annotations

import re
from pathlib import Path

from ..bundle import Bundle
from ..errors import ServiceError
from ..naming import parse_filename
from .judge import kind_of

# Match complete Spine core names, including asset names followed by a page or role.
CORE = re.compile(r"(?<![a-z0-9_])([a-z][a-z0-9_]*?_(?:spr|home(?:_gl|_teen)?))(?=$|[^a-z0-9])", re.I)


def content_cores(path: Path) -> set[str]:
    """Read names only, without decoding textures, meshes or skeleton payloads."""
    bundle = Bundle.load(path)
    if bundle is None:
        raise ServiceError("bundle_invalid", file=path)
    names = set(bundle.env.container)
    for obj in bundle.env.objects:
        name = obj.peek_name()
        if name:
            names.add(name)
        if obj.container:
            names.add(obj.container)
    names = {name.replace("\\", "/").lower() for name in names}
    container_kinds: dict[str, set[str]] = {}
    for name in names:
        kind = "home" if "spinelobbies/" in name else "spr" if "spinecharacters/" in name else None
        if kind and name.endswith((".skel", ".atlas")):
            container_kinds.setdefault(Path(name).stem, set()).add(kind)
    cores = set()
    for normalized in names:
        found = CORE.findall(normalized)
        cores.update(match.lower() for match in found)
        if not found and normalized.lower().endswith((".skel", ".atlas")):
            stem = Path(normalized).stem.lower()
            if re.fullmatch(r"[a-z][a-z0-9_]*", stem):
                kinds = container_kinds.get(stem) or {
                    "home" if kind_of(parse_filename(path.name).core) == "lobby" else "spr"}
                cores.update(f"{stem}_{kind}" for kind in kinds)
    return cores


def identify(path: Path, name: str, catalog) -> tuple[str, str, str]:
    """Return the stored filename, variant and kind. Content wins over a renamed filename;
    conflicting content or an unknown content core refuses the whole upload."""
    parsed = parse_filename(name)
    resolve = getattr(catalog, "variant_for_asset_core", catalog.variant_for_core)
    declared = resolve(parsed.core.lower())
    cores = content_cores(path)
    resolved = [(core, resolve(core)) for core in sorted(cores)]
    if any(variant is None for _, variant in resolved):
        raise ServiceError("mod_target_unknown", file=path)
    targets = {(variant.key, kind_of(core)) for core, variant in resolved}
    if len(targets) > 1:
        raise ServiceError("mod_target_ambiguous", file=path)
    if not targets:
        if declared is None or kind_of(parsed.core) is None:
            raise ServiceError("mod_target_unknown", file=path)
        target, kind, variant = declared.key, kind_of(parsed.core), declared
    else:
        target, kind = targets.pop()
        variant = resolved[0][1]
    core = (variant.spr if kind == "spr" else variant.lobby) or (resolved[0][0] if resolved else parsed.core)
    category = "spinecharacters" if kind == "spr" else "spinelobbies"
    prefix = parsed.prefix.replace(f"-{parsed.core}-", f"-{core}-", 1)
    if parsed.category:
        prefix = prefix.replace(f"-{parsed.category}-", f"-{category}-", 1)
    return prefix + name[len(parsed.prefix):], target, kind
