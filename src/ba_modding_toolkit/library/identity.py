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
CONTAINER = re.compile(r"(?:^|/)(spinebackground|spinelobbies|spinecharacters)/([a-z0-9_]+)(?:/|\.)", re.I)


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
    parsed = parse_filename(path.name.removesuffix(".backup"))
    special_file = kind_of(parsed.core, parsed.category) == "lobby" and (
        parsed.category != "spinelobbies" or kind_of(parsed.core) != "lobby")
    special = {}
    for name in names:
        match = CONTAINER.search(name)
        if match and (match[1] == "spinebackground" or (
                match[2] == parsed.core.lower() and kind_of(parsed.core, match[1]) == "lobby"
                and (match[1] != "spinelobbies" or kind_of(parsed.core) != "lobby"))):
            special[name] = match[2]
    container_kinds: dict[str, set[str]] = {}
    for name in names:
        kind = "home" if "spinelobbies/" in name else "spr" if "spinecharacters/" in name else None
        if kind and name.endswith((".skel", ".atlas")):
            container_kinds.setdefault(Path(name).stem, set()).add(kind)
    cores = set(special.values())
    for normalized in names:
        if normalized in special or (special and "/" not in normalized):
            continue
        if special_file and "/" not in normalized:
            if Path(normalized).stem == parsed.core.lower() and normalized.endswith((".skel", ".atlas")):
                cores.add(parsed.core.lower())
            continue
        found = CORE.findall(normalized)
        cores.update(match.lower() for match in found)
        if not found and normalized.lower().endswith((".skel", ".atlas")):
            stem = Path(normalized).stem.lower()
            if special:
                # Special scenes often use several unrelated skeleton names. Their containers own those layers.
                continue
            if special_file:
                # Bare layer names do not identify a scene. The filename still owns texture-only parts too.
                if stem == parsed.core.lower():
                    cores.add(stem)
                continue
            if re.fullmatch(r"[a-z][a-z0-9_]*", stem):
                if stem == parsed.core.lower() and kind_of(parsed.core, parsed.category) == "lobby":
                    cores.add(stem)
                    continue
                kinds = container_kinds.get(stem) or {
                    "home" if kind_of(parsed.core, parsed.category) == "lobby" else "spr"}
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
    targets = {(variant.key, "lobby" if getattr(variant, "spine_category", None) else kind_of(core))
               for core, variant in resolved}
    if len(targets) > 1:
        raise ServiceError("mod_target_ambiguous", file=path)
    if not targets:
        kind = kind_of(parsed.core, parsed.category)
        if declared is None or kind is None:
            raise ServiceError("mod_target_unknown", file=path)
        target, variant = declared.key, declared
    else:
        target, kind = targets.pop()
        variant = resolved[0][1]
    core = (variant.spr if kind == "spr" else variant.lobby) or (resolved[0][0] if resolved else parsed.core)
    category = getattr(variant, "spine_category", None) or ("spinecharacters" if kind == "spr" else "spinelobbies")
    prefix = parsed.prefix.replace(f"-{parsed.core}-", f"-{core}-", 1)
    if parsed.category:
        prefix = prefix.replace(f"-{parsed.category}-", f"-{category}-", 1)
    return prefix + name[len(parsed.prefix):], target, kind
