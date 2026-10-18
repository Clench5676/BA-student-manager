"""Cheap bundle discovery and resource version calculation."""

from __future__ import annotations

import hashlib
import json
import os
import struct
from pathlib import Path

from ..naming import parse_filename


def bundle_paths(resource_dirs: list[Path]) -> list[Path]:
    """List bundle files once, preserving resource directory precedence."""
    found: dict[str, Path] = {}
    for directory in resource_dirs:
        with os.scandir(directory) as entries:
            for entry in entries:
                if entry.name.endswith(".bundle") and entry.is_file():
                    found.setdefault(entry.name, Path(entry.path))
    return [found[name] for name in sorted(found)]


def resource_version(resource_dirs: list[Path]) -> str:
    """Hash the Windows catalog, falling back to sorted file names and sizes."""
    checked: set[Path] = set()
    for directory in resource_dirs:
        for parent in (directory, *directory.parents):
            catalog = parent / "Catalog" / "Windows" / "catalog_Windows.hash"
            if catalog in checked:
                continue
            checked.add(catalog)
            if catalog.is_file():
                return hashlib.sha1(catalog.read_bytes()).hexdigest()
    listing = []
    for directory in resource_dirs:
        with os.scandir(directory) as entries:
            listing.extend((entry.name, entry.stat().st_size) for entry in entries if entry.is_file())
    return hashlib.sha1(json.dumps(sorted(listing), separators=(",", ":")).encode()).hexdigest()


def group_bundles(paths: list[Path], category: str) -> dict[str, list[Path]]:
    """Group all dated bundle parts by parsed category and lower-case core."""
    groups: dict[str, list[Path]] = {}
    for path in sorted(paths):
        parsed = parse_filename(path.name)
        if parsed.category == category:
            groups.setdefault(parsed.core.lower(), []).append(path)
    return groups


def is_atlas(path: Path) -> bool:
    """Whether a bundle belongs to the UI atlas family."""
    return "uis-atlas-" in path.name


def is_texture(path: Path) -> bool:
    """Whether a bundle belongs to the shared UI texture families."""
    name = path.name
    return ("addressableasset-uis-_mxprolog-" in name
            or "uis-00_images-_mxload-" in name
            or "uis-00_images-formation-" in name
            or "uis-00_images-imagefont-" in name
            or name.startswith(("uis-01_common-09_popupimage-", "uis-01_common-13_campaignimage-")))


def is_prefab(path: Path) -> bool:
    """Whether a bundle can contain a UI prefab root (Resources/UI holds the loading screen, UILoading)."""
    return (path.name.startswith(("ui-_mxload-prefabs-", "ui-uiassetobject-"))
            or (path.name.startswith("prologdepengroup-") and "-addressableasset-ui-" in path.name)
            or (path.name.startswith("prologgroup-") and "-resources-ui-" in path.name))


def is_loading_art(path: Path) -> bool:
    """Whether a bundle holds the loading screen illustrations (UIs/01_Common/12_Loading)."""
    return "-uis-01_common-12_loading-" in path.name


def cab_names(path: Path) -> list[str]:
    """Lower-case CAB names of a UnityFS bundle, from its header and blocks info only (no data block is read).

    Raises ValueError for a file that is not a readable UnityFS bundle.
    """
    from UnityPy.helpers.CompressionHelper import DECOMPRESSION_MAP

    try:
        with open(path, "rb") as stream:
            head = stream.read(4096)
            end = head.index(b"\0")
            if head[:end] != b"UnityFS":
                return []
            pos = end + 1
            version = struct.unpack_from(">I", head, pos)[0]
            pos = head.index(b"\0", pos + 4) + 1  # player version
            pos = head.index(b"\0", pos) + 1      # engine version
            _, compressed, size, flags = struct.unpack_from(">qIII", head, pos)
            pos += 20
            if version >= 7:
                pos = (pos + 15) & ~15
            if flags & 0x80:  # blocks info at the end of the file
                stream.seek(-compressed, os.SEEK_END)
            else:
                stream.seek(pos)
            info = stream.read(compressed)
        if flags & 0x3F:
            info = DECOMPRESSION_MAP[flags & 0x3F](info, size)
        pos = 16  # data hash
        pos += 4 + struct.unpack_from(">i", info, pos)[0] * 10
        count = struct.unpack_from(">i", info, pos)[0]
        pos += 4
        names = []
        for _ in range(count):
            pos += 20  # offset, size, flags
            end = info.index(b"\0", pos)
            names.append(info[pos:end].decode("utf-8", "replace").lower())
            pos = end + 1
        return names
    except (struct.error, KeyError, IndexError, UnicodeError) as exc:
        raise ValueError(f"not a readable UnityFS bundle: {path}") from exc


def is_model_dependency(path: Path) -> bool:
    """Families that hold 3D chibi prefabs, meshes, materials, textures, shaders and shared animators."""
    name = path.name
    return ("characters" in name or "-_mx-npcs-" in name or name.startswith("character-")
            or "-_mx-shaders-" in name or "-_mx-program-animators-" in name)


def is_lobby_prefab(path: Path) -> bool:
    """Whether a bundle holds memorial lobby prefabs (UILobbyElement/Lobby<Name>.prefab)."""
    return path.name.startswith("ui-uilobbyelement-")


def is_layout_texture(path: Path) -> bool:
    """Texture-only families additionally referenced by the detail prefab.

    These supply names for embedded campaign widgets and UI effects, rather
    than expanding the shared UITexture index to character or gameplay art.
    """
    return (path.name.startswith(("uis-01_common-25_campaign-", "uis-02_tactics-02_skillicon-"))
            or "-effectsfreezed-texture-" in path.name)
