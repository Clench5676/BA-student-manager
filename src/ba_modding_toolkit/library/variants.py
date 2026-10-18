"""Adapt official Spine assets to another variant's existing asset slots."""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path

from ..bundle import Bundle
from ..errors import ServiceError
from ..models import AssetType, LogFunc, Obj, ReplaceAssetType, SaveOptions


def adapt_variant_sources(sources: list[Path], targets: list[Path], directory: Path,
                          asset_types: set[ReplaceAssetType], log: LogFunc) -> list[Path]:
    """Rename source assets to target slots for the core's name/type matcher.

    Unity object IDs and character-specific names differ across variants. Adapt
    temporary source copies, including atlas page references, so the core can
    transplant the payloads without changing the target's object references.
    Different numbers of texture pages or skeletons cannot fit those references
    and are rejected before any game file is written.
    """
    allowed = {AssetType.Texture2D, AssetType.TextAsset, AssetType.Mesh, AssetType.AnimationClip}
    if "ALL" not in asset_types:
        allowed = {value for value in allowed if value.name in asset_types}
    bundles = []
    source_slots: dict[tuple[str, str], list[Obj]] = defaultdict(list)
    target_slots: dict[tuple[str, str], list[str]] = defaultdict(list)

    def role(obj: Obj) -> tuple[str, str]:
        # TextAsset extensions distinguish the skeleton from its atlas. Textures
        # are paired in name order, preserving numbered texture page order.
        name = obj.peek_name() or ""
        return obj.type.name, Path(name).suffix.lower() if obj.type == AssetType.TextAsset else ""

    for path in sources:
        bundle = Bundle.load(path, log)
        if bundle is None:
            raise ServiceError("bundle_invalid", file=path)
        bundles.append(bundle)
        for obj in bundle.env.objects:
            if obj.type in allowed:
                source_slots[role(obj)].append(obj)
    for path in targets:
        bundle = Bundle.load(path, log)
        if bundle is None:
            raise ServiceError("bundle_invalid", file=path)
        for obj in bundle.env.objects:
            if obj.type in allowed:
                target_slots[role(obj)].append(obj.peek_name() or "")

    if not source_slots or source_slots.keys() != target_slots.keys() or any(
            len(values) != len(target_slots[key]) or len(set(target_slots[key])) != len(values)
            or len({obj.peek_name() for obj in values}) != len(values)
            for key, values in source_slots.items()):
        raise ServiceError("variant_incompatible")
    texture_names = {}
    adapted = []
    for key, objects in source_slots.items():
        for obj, target_name in zip(sorted(objects, key=lambda o: o.peek_name() or ""), sorted(target_slots[key])):
            old_name = obj.peek_name() or ""
            if obj.type == AssetType.Texture2D:
                texture_names[old_name.casefold() + ".png"] = target_name + ".png"
            adapted.append((obj, target_name))
    for obj, name in adapted:
        data = obj.read()
        data.m_Name = name
        if obj.type == AssetType.TextAsset and name.lower().endswith(".atlas"):
            # Page names occupy their own lines. Preserve region names, spacing
            # and line endings; only rewrite known texture page filenames.
            data.m_Script = "".join(
                texture_names.get(line.rstrip("\r\n").casefold(), line.rstrip("\r\n"))
                + line[len(line.rstrip("\r\n")):] for line in data.m_Script.splitlines(keepends=True))
        data.save()

    directory.mkdir(parents=True, exist_ok=True)
    result = []
    for i, bundle in enumerate(bundles):
        folder = directory / str(i)
        folder.mkdir()
        output = folder / bundle.path.name
        success, _ = bundle.save(output, SaveOptions(perform_crc=False, compression="none"))
        if not success:
            raise ServiceError("mod_apply_failed", file=bundle.path)
        result.append(output)
    return result
