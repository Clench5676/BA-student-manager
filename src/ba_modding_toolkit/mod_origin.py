"""Conservative Mod origin detection from Unity metadata and the selected install.

A CAB is an identity, not a region tag. It only supplies region evidence when it
matches a recoverable official file in the selected install. Textual resource
suffixes are shared by current Global and Japan releases and prove neither.
"""

from __future__ import annotations

import re
from typing import Any

from .library.integrity import Contents

SERVERS = ("global", "japan")
PLATFORMS = ("android", "ios", "windows")
UNITY_PLATFORMS = {"Android": "android", "iOS": "ios", "iPhone": "ios",
                   "StandaloneWindows": "windows", "StandaloneWindows64": "windows"}
UNKNOWN_PLATFORMS = {"UnknownPlatform", "NoTarget", "Unknown", "0", "-2"}


def platform_of(contents: Contents) -> str | None:
    platforms = {UNITY_PLATFORMS.get(name) for name in contents.platforms - UNKNOWN_PLATFORMS}
    return next(iter(platforms)) if len(platforms) == 1 else None


def server_hints(names: set[str]) -> set[str]:
    hints = set()
    for value in names:
        value = value.lower().replace("\\", "/")
        if "com.nexon.bluearchive" in value or re.search(r"_home_gl(?=$|[^a-z0-9])", value):
            hints.add("global")
        if "com.yostarjp.bluearchive" in value.replace(" ", ""):
            hints.add("japan")
    return hints


def names_of(contents: Contents) -> set[str]:
    return (contents.names | contents.files | contents.references | contents.reference_paths | set(contents.skeletons)
            | set(contents.atlases) | set(contents.textures))


def platform_hints(names: set[str]) -> set[str]:
    return {part.lower() for name in names for part in name.replace("\\", "/").split("/")
            if part.lower() in PLATFORMS}


def target_of(settings: Any, pin: Any, official: Contents | None = None) -> dict:
    """Prefer serialized targets; Settings supplies the install's region and fallback platform."""
    platform = platform_of(official) if official and official.platforms else None
    if platform is None and not (official and official.platforms):
        parts = {part.lower() for directory in pin.dirs for part in directory.parts} if pin else set()
        folder_platforms = parts & {"windows", "android", "ios"}
        platform = next(iter(folder_platforms)) if len(folder_platforms) == 1 else None
        if platform is None and not folder_platforms:
            platform = "android" if settings.is_adb_mode() else "windows"
    names = names_of(official) if official else set()
    if pin:
        names.update(str(directory) for directory in pin.dirs)
    hints = server_hints(names)
    server = next(iter(hints)) if len(hints) == 1 else pin.server if pin else settings.server_region()
    return {"server": server, "platform": platform}


def constraints(names: set[str], selected: Contents, official: Contents, target: dict) -> tuple[dict, str | None]:
    """Reliable evidence constrains each dimension even when the other is unknown."""
    platforms = {UNITY_PLATFORMS.get(name) for name in selected.platforms}
    known = selected.platforms - UNKNOWN_PLATFORMS
    if any(name not in UNITY_PLATFORMS for name in known):
        return {}, "platform_unsupported"
    if len(platforms - {None}) > 1:
        return {}, "source_conflict"
    platform = platform_of(selected)
    if platform is None:
        hints = platform_hints(names_of(selected))
        if len(hints) > 1:
            return {}, "source_conflict"
        platform = next(iter(hints)) if hints else None
    hints = server_hints(names | names_of(selected))
    if not hints:
        cabs = {name for name in selected.files if name.startswith("cab-") and "." not in name}
        if cabs and cabs <= official.files:
            hints.add(target["server"])
    if len(hints) > 1:
        return {}, "source_conflict"
    return {"server": next(iter(hints)) if hints else None, "platform": platform}, None


def source_of(names: set[str], selected: Contents, official: Contents, target: dict) -> tuple[dict | None, str | None]:
    """Return a complete detected source, or a precise unresolved/unsupported reason."""
    evidence, error = constraints(names, selected, official, target)
    if error:
        return None, error
    if not all(evidence.values()):
        return None, "source_unknown"
    return {**evidence, "detected": True}, None


def candidates(names: set[str], selected: Contents, official: Contents | None = None,
               target: dict | None = None) -> list[dict]:
    """Try only unknown dimensions, in Global/Japan and Android/iOS/PC order."""
    evidence, error = constraints(names, selected, official or Contents(), target or {})
    if error:
        return []
    return [{"server": server, "platform": platform, "detected": True}
            for server in SERVERS for platform in PLATFORMS
            if evidence["server"] in (None, server) and evidence["platform"] in (None, platform)]
