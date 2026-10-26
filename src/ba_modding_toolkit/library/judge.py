"""How the library judges game files and entries: pure rules, kept apart from the reads so they can be tested on
their own (the table-driven tests of the entry states read nothing).

Terms (docs/web-ui.md, library): an *entry* is one game core of a variant in one install (a portrait or one memorial
lobby core); what its files *carry* is the library source that wrote them while they are unchanged since, else
official, unknown or damaged; *configured* is the source the user chose for it; *enabled* is the Enable Mods switch.
"""

from __future__ import annotations

import hashlib
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from ..naming import parse_filename, spine_kind
from ..searching import SEARCH_DIR_SUFFIXES

LIBRARY_SOURCES = ("mod:", "variant:")
CRC_STATES = ("ok", "fixed", "needs_fix")
KINDS = ("spr", "lobby", "model", "other")
MODEL_CATEGORIES = {"character", "characters", "npcs"}


def supports_kind(kind: str) -> bool:
    """Whether files of this kind can be stored and switched by the library."""
    return kind in KINDS


def now() -> str:
    """The current time as the library records it (ISO 8601, UTC)."""
    return datetime.now(timezone.utc).isoformat()


def seconds(value: Any) -> float | None:
    """A recorded time as seconds since the epoch: an ISO text, or nanoseconds (a file's modification time)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value / 1e9
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except ValueError:
        return None


def kind_of(core: str, category: str | None = None) -> str | None:
    """The kind of a character asset slot, using the bundle category for 3D models."""
    if category and category.lower() in MODEL_CATEGORIES and spine_kind(core) is None and re.fullmatch(r"[a-z0-9][a-z0-9_]*", core.lower()):
        if core.lower() != "mxcommon" and not core.lower().startswith("mxcommon_"):
            return "model"
    return spine_kind(core, category)


def kind_of_file(name: str) -> str | None:
    """Classify a bundle using its category as well as its core."""
    parsed = parse_filename(name)
    return kind_of(parsed.core, parsed.category) or (
        "other" if name.endswith(".bundle") and parsed.prefix and parsed.crc else None)


def core_of(name: str) -> str:
    """The character core, or a generic file slot keyed by prefix and resource type, without date or CRC."""
    if kind_of_file(name) == "other":
        return "other:" + hashlib.sha256(repr(part_of(name)).encode()).hexdigest()
    return parse_filename(name).core.lower()


def other_target(names: Iterable[str]) -> str:
    """A bundle set's address; its individual target slots remain independently configurable."""
    slots = sorted({core_of(name) for name in names})
    return "other-set:" + hashlib.sha256("\0".join(slots).encode()).hexdigest()


def part_of(name: str) -> tuple[str, str | None]:
    """Which part of its core a bundle file is, whatever its date and CRC: its prefix and resource type."""
    parsed = parse_filename(name)
    # Collection batches coexist across dates; a later batch does not replace an earlier batch's portraits.
    if name.lower().startswith("uis-01_common-14_charactercollect-"):
        return parsed.prefix + parsed.date + ":", parsed.res_type
    return parsed.prefix, parsed.res_type


def date_of(name: str) -> str:
    return parse_filename(name).date


def install_root(folder: Path) -> Path:
    """The install root of a game folder setting, resolved: a setting that names a resource folder (one of the
    subfolders the search looks in, searching.SEARCH_DIR_SUFFIXES) maps to the folder it is in."""
    folder = Path(folder).resolve()
    for suffix in sorted(filter(None, SEARCH_DIR_SUFFIXES), key=len, reverse=True):
        parts = tuple(part.lower() for part in Path(suffix).parts)
        if len(folder.parts) > len(parts) and tuple(part.lower() for part in folder.parts[-len(parts):]) == parts:
            return Path(*folder.parts[:-len(parts)])
    return folder


def install_key(root: Path) -> str:
    """The key everything per install is stored under: its root, case-folded on Windows."""
    return os.path.normcase(str(root))


def distinguishing_folders(roots: dict[str, Path]) -> dict[str, str]:
    """For installs of one server: the shortest trailing part of each root's path that tells it from the others, the
    folder name first ({key: "BlueArchive"}, or "Steam/BlueArchive" when the names are the same)."""
    out = {}
    for key, root in roots.items():
        parts = root.parts
        for count in range(1, len(parts) + 1):
            tail = parts[-count:]
            if all(other.parts[-count:] != tail for k, other in roots.items() if k != key):
                out[key] = "/".join(tail)
                break
        else:
            out[key] = str(root)
    return out


def says_official(record: dict | None) -> bool:
    """Whether a record says the library wrote official bytes: its flag, else (an older build's record) its source."""
    if not record:
        return False
    flag = record.get("official")
    return flag if isinstance(flag, bool) else record.get("source") == "official"


def crc_state(crc: int, trailing: int | None, name: str) -> str:
    """The CRC state of bytes against the CRC in a target's name: ok (matches, no trailing bytes), fixed (matches
    with trailing bytes, the CRC fix), else needs_fix."""
    parsed = parse_filename(name)
    matches = bool(parsed.crc) and crc == int(parsed.crc)
    if matches and trailing == 0:
        return "ok"
    return "fixed" if matches and trailing else "needs_fix"


def carried_of(parts: Iterable[tuple[str, bool]]) -> str:
    """What an entry's files carry, from its non-official parts only ((carried, official) per part): "official" when
    there are none, their one source, else "unknown" (several sources, or any part unknown). A mod replaces its kind
    as a unit and the library records every part, the ones it left official included: after a repair puts back the
    one modded part, the others still match their records, and the entry must not look modded."""
    sources = {carried for carried, official in parts if not official}
    if not sources:
        return "official"
    if len(sources) != 1 or "unknown" in sources:
        return "unknown"
    return next(iter(sources))


def classify(enabled: bool, configured: str | None, carried: str, *, files: bool = True, damaged: bool = False,
             configured_exists: bool = True, carried_exists: bool = True, drifted_present: bool = False,
             drifted_gone: bool = False, marker: bool = False, written: float | None = None,
             since: float | None = None, toggled: float | None = None) -> tuple[str, str | None]:
    """The state of an entry, first match wins, and the source a take-over configures (else None).

    ``carried`` is what the non-official parts carry ("official" when there are none, "unknown" when they carry
    several sources or any part is unknown, "removed" for a mod the user removed). ``written`` is the latest write
    time of the parts carrying it, ``since`` when the configuration was set and ``toggled`` the switch's last change.
    A take-over ("takeover") is classified again by the caller with the new configuration."""
    if damaged:
        return "damaged", None
    if configured and not files:
        return "missing", None
    if carried == "unknown":
        return ("changed" if configured else "untracked"), None
    if configured and not configured_exists:
        return "source_missing", None
    if carried.startswith(LIBRARY_SOURCES) and carried_exists and carried != configured:
        newest = max(value for value in (since, toggled, float("-inf")) if value is not None)
        if configured is None or (written is not None and written > newest):
            return "takeover", carried
    if enabled and configured and carried in ("official", configured):
        if marker or drifted_gone:
            return "updated", None
        if drifted_present:
            return "reset", None
    if enabled:
        if (configured and carried == configured) or (not configured and carried == "official"):
            return "ok", None
    elif carried == "official":
        return "ok", None
    return "pending", None


def leaves(state: str, enabled: bool) -> bool:
    """The leaving rule of the switch's unfinished list: whether an entry in this state needs nothing more from a
    toggle or Retry under the current intent."""
    if state in ("ok", "missing", "damaged", "source_missing"):
        return True
    # an On never writes over an outside change; while mods are off the next Off or Retry adopts it
    return enabled and state in ("untracked", "changed")
