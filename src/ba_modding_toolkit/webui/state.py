"""Small UI state kept between launches: the asset consent, recently opened variants, seen mods, the user's own
aliases of the variants and the web UI's own preferences (voice volume, the mod library folder, scan and Spine consents,
the mod switch's and the classic hand-off's flags, the data directory's id). Kept apart from config.toml, which the
classic GUI rewrites with only its own keys.

Several app instances may share one data folder: every change is applied to the file as it is at that moment (read
again under a lock the instances share), so one instance never erases what another wrote, and reads pick up the
other instances' writes, under the same lock: Windows cannot replace a file another process has open."""

from __future__ import annotations

import contextlib
import copy
import json
import logging
import math
import os
import secrets
import tempfile
import threading
import unicodedata
from collections.abc import Callable
from pathlib import Path
from typing import Any

# the lock and the replace shared with the mod library (ba_modding_toolkit.filelock), under their old names
from ..filelock import file_lock as _file_lock, replace as _replace

logger = logging.getLogger(__name__)

RECENT_MAX = 50
# the user's own aliases of a student (the roster search matches them): at most this many, each this many characters
ALIAS_MAX, ALIAS_LENGTH = 8, 24


def alias_text(value: Any) -> str:
    """One alias as it is kept: NFC text without control or format characters, every run of whitespace one space,
    trimmed; '' for anything but text."""
    if not isinstance(value, str):
        return ""
    text = "".join(ch for ch in unicodedata.normalize("NFC", value)
                   if ch.isspace() or not unicodedata.category(ch).startswith("C"))
    return " ".join(text.split())


def alias_key(text: str) -> str:
    """What makes two aliases the same one: case and width ignored."""
    return unicodedata.normalize("NFKC", text).casefold()


def custom_aliases(value: Any) -> list[str]:
    """A student's own aliases as the page gets them: cleaned (alias_text), without empty, too long and repeated ones,
    in their order, at most ALIAS_MAX."""
    out: list[str] = []
    seen: set[str] = set()
    for item in value if isinstance(value, list) else []:
        text = alias_text(item)
        if text and len(text) <= ALIAS_LENGTH and alias_key(text) not in seen:
            seen.add(alias_key(text))
            out.append(text)
    return out[:ALIAS_MAX]

# The student list's view (web/js/roster-order.js keeps the same rules): merge toggle, the two segment filters, the
# display settings' sort, order and filter groups.
ROSTER_SORTS = ("recent", "added", "name", "mods", "default")
ROSTER_NATURAL = {"recent": "desc", "added": "desc", "name": "asc", "mods": "desc", "default": "asc"}
ROSTER_FILTERS = {
    "favorite": ("yes", "no"),
    "portrait": ("official", "replaced"),
    "lobby": ("yes", "no"),
    "model": ("yes", "no"),
}


def roster_view(value: Any) -> dict[str, Any]:
    """A stored or sent roster view with every field valid; unknown fields and options are dropped."""
    src = value if isinstance(value, dict) else {}

    def pick(key: str, allowed: tuple[str, ...], fallback: str) -> str:
        v = src.get(key)
        return v if isinstance(v, str) and v in allowed else fallback

    sort = pick("sort", ROSTER_SORTS, "recent")
    given = src.get("filters") if isinstance(src.get("filters"), dict) else {}
    filters = {}
    for group, options in ROSTER_FILTERS.items():
        chosen = given.get(group)
        on = [o for o in options if isinstance(chosen, list) and o in chosen]
        if on:
            filters[group] = on
    return {
        "merged": src.get("merged") is True,
        "mods": pick("mods", ("all", "mods", "none"), "all"),
        "recruit": pick("recruit", ("all", "yes", "no"), "all"),
        "sort": sort,
        "order": pick("order", ("asc", "desc"), ROSTER_NATURAL[sort]),
        "filters": filters,
    }


def _recent_of(data: dict[str, Any]) -> list[str]:
    value = data.get("recent")
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def _seen_mods_of(data: dict[str, Any]) -> set[str] | None:
    value = data.get("seen_mods")
    if not isinstance(value, list) or any(not isinstance(v, str) or not v for v in value):
        return None
    return set(value)


class UiState:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock_path = self.path.with_name(f"{self.path.name}.lock")
        self._lock = threading.RLock()
        self._data: dict[str, Any] = {}
        self._seen: tuple[int, int] | None = None  # the file's (mtime, size) when it was last read or written
        prefs = self._current().get("prefs")
        # Manual consent did not authorize automatic checks. Migrate it to Off without opting the user in.
        if isinstance(prefs, dict) and any(key in prefs for key in ("startup_checks", "mod_switch_shown")):
            def migrate(data: dict[str, Any]) -> None:
                prefs = data.get("prefs", {})
                if prefs.pop("startup_checks", None) is False and prefs.get("scan_consent") is True:
                    prefs["scan_consent"] = False
                # The main screens always keep the switch.
                prefs.pop("mod_switch_shown", None)

            self._update(migrate)

    def _signature(self) -> tuple[int, int] | None:
        try:
            st = self.path.stat()
        except OSError:
            return None
        return st.st_mtime_ns, st.st_size

    def _read(self, *, strict: bool = False) -> dict[str, Any] | None:
        """The file's content now; None when missing or unreadable. Strict reads use {} for missing and raise
        for unreadable content."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {} if strict else None
        except (OSError, ValueError):
            if strict:
                raise
            return None
        if strict and not isinstance(data, dict):
            raise ValueError("UI state must be an object")
        return data if isinstance(data, dict) else None

    def _current(self) -> dict[str, Any]:
        """The state as the file holds it now (another instance may have written it); what was last known while the
        file is missing or unreadable. Read under the lock the instances share, so another instance's write never
        meets this one's open file (Windows refuses to replace it)."""
        with self._lock:
            if self._signature() in (None, self._seen):
                return self._data
            try:
                with _file_lock(self._lock_path):
                    signature, data = self._signature(), self._read()
            except OSError:  # the lock not had in time (Windows gives up after 10 s): what was last known
                logger.warning("cannot lock %s", self._lock_path, exc_info=True)
                return self._data
            if signature is not None and data is not None:
                self._data, self._seen = data, signature
            return self._data

    def _update(self, change: Callable[[dict[str, Any]], None]) -> None:
        """Apply one change to the file's current content, read again under the lock the instances share, and write
        it back: keys another instance wrote meanwhile are kept."""
        with self._lock, _file_lock(self._lock_path):
            data = self._read()
            if data is None:
                data = copy.deepcopy(self._data)
            change(data)
            self._write(data)

    def _write(self, data: dict[str, Any]) -> None:
        """Replace the state atomically while both state locks are held."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                out.write(json.dumps(data, ensure_ascii=False, indent=1))
            _replace(name, self.path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(name)
            raise
        self._data, self._seen = data, self._signature()

    def diagnostic_state(self) -> dict | None:
        """Read the last known diagnostic settings without a file lock or disk access."""
        if not self._lock.acquire(blocking=False):
            return None
        try:
            prefs = self._data.get("prefs", {})
            return {"consent": {"uiAssets": self._data.get("consent"), "spine": prefs.get("spine_consent")},
                    "libraryDir": prefs.get("library_dir")}
        finally:
            self._lock.release()

    @property
    def consent(self) -> bool | None:
        """None until the user answered the consent popup; then True (cache allowed) or False."""
        value = self._current().get("consent")
        return value if isinstance(value, bool) else None

    def set_consent(self, granted: bool) -> None:
        self._update(lambda data: data.__setitem__("consent", bool(granted)))

    @property
    def preview_cache(self) -> bool:
        """Enable preview storage by default while preserving an explicit opt-out."""
        return self.get("preview_cache") is not False

    def recent(self) -> list[str]:
        return _recent_of(self._current())

    def preview_sources(self, install: str, variant: str) -> dict[str, str]:
        data = self._current().get("asset_previews", {})
        folder = data.get(install, {}) if isinstance(data, dict) else {}
        sources = folder.get(variant, {}) if isinstance(folder, dict) else {}
        return {kind: source for kind, source in sources.items()
                if kind in ("spr", "lobby", "model") and isinstance(source, str)} if isinstance(sources, dict) else {}

    def preview_snapshot(self, install: str) -> dict[str, dict[str, str]]:
        """Read all saved view choices of one install once, detached from mutable state."""
        data = self._current().get("asset_previews", {})
        folder = data.get(install, {}) if isinstance(data, dict) else {}
        return {variant: {kind: source for kind, source in sources.items()
                          if kind in ("spr", "lobby", "model") and isinstance(source, str)}
                for variant, sources in folder.items() if isinstance(variant, str) and isinstance(sources, dict)
                } if isinstance(folder, dict) else {}

    def set_preview_source(self, install: str, variant: str, kind: str, source: str) -> None:
        """Remember a view choice independently of the library's game configuration."""
        def change(data: dict[str, Any]) -> None:
            data.setdefault("asset_previews", {}).setdefault(install, {}).setdefault(variant, {})[kind] = source
        self._update(change)

    def reconcile_deleted_source(self, source: str, fallback) -> None:
        """Clear a removed preview everywhere; retain Hall placement when another source exists."""
        def change(data):
            for folder in data.get('asset_previews', {}).values():
                for variant, choices in folder.items():
                    for kind, selected in list(choices.items()):
                        if selected == source:
                            replacement = fallback(variant, kind)
                            if replacement:
                                choices[kind] = replacement
                            else:
                                del choices[kind]
            hall = data.get('prefs', {}).get('student_hall')
            if hall:
                changed = False
                replacements = {}
                for group, kind in [('portraits', 'spr'), ('memorials', 'lobby')]:
                    kept = []
                    existing = {(entry['variant'], entry['source']): entry['id'] for entry in hall.get(group, [])
                                if entry.get('source') != source}
                    for entry in hall.get(group, []):
                        if entry.get('source') == source:
                            changed = True
                            replacement = fallback(entry['variant'], kind)
                            if not replacement:
                                continue
                            identity = (entry['variant'], replacement)
                            if identity in existing:
                                replacements[entry['id']] = existing[identity]
                                continue
                            entry['source'] = replacement
                            existing[identity] = entry['id']
                        kept.append(entry)
                    hall[group] = kept
                if changed:
                    hall['active'] = replacements.get(hall.get('active'), hall.get('active'))
                    if not any(entry['id'] == hall.get('active') for entry in hall.get('memorials', [])):
                        hall['active'] = next((entry['id'] for entry in hall.get('memorials', [])), None)
                    hall['revision'] = hall.get('revision', 0) + 1
        self._update(change)

    def visit(self, variant_key: str) -> None:
        def change(data: dict[str, Any]) -> None:
            recent = [v for v in _recent_of(data) if v != variant_key]
            data["recent"] = [variant_key, *recent][:RECENT_MAX]

        self._update(change)

    def seen_mods(self, baseline: Callable[[], list[str]] | None = None) -> set[str] | None:
        """Seen ids, or None when unknown. Only a missing key gets the library's baseline, never an existing list.
        Read strictly: stale or unreadable state must not turn every mod into a new one."""
        try:
            with self._lock, _file_lock(self._lock_path):
                data = self._read(strict=True)
                if "seen_mods" in data or baseline is None:
                    return _seen_mods_of(data)
            # The library has its own lock: take its snapshot without holding either state lock.
            ids = baseline()
            with self._lock, _file_lock(self._lock_path):
                data = self._read(strict=True)
                if "seen_mods" not in data:
                    data["seen_mods"] = sorted(set(ids))
                    self._write(data)
                return _seen_mods_of(data)
        except (OSError, ValueError):
            logger.warning("cannot read seen mods from %s", self.path, exc_info=True)
            return None

    def mark_mods_seen(self, ids: list[str]) -> None:
        """Remember opened mods without changing the shared mod library."""
        def change(data: dict[str, Any]) -> None:
            value = data.get("seen_mods")
            seen = {v for v in value if isinstance(v, str) and v} if isinstance(value, list) else set()
            data["seen_mods"] = sorted(seen.union(ids))

        self._update(change)

    # --- the user's own aliases, by variant key ---

    def aliases(self, legacy_targets: dict[str, str] | None = None) -> dict[str, list[str]]:
        """Every variant's own aliases ({variant key: [alias]}), cleaned as custom_aliases does.
        Ordinary family keys identify the original variant. Special-only families need a catalog-selected target;
        move those entries once under the shared lock, preserving any explicitly saved variant aliases."""
        table = self._current().get("aliases")
        if isinstance(table, dict) and legacy_targets and any(key in table for key in legacy_targets):
            def migrate(data: dict[str, Any]) -> None:
                aliases = data.get("aliases")
                if not isinstance(aliases, dict):
                    return
                for family, variant in legacy_targets.items():
                    if family in aliases:
                        aliases.setdefault(variant, aliases.pop(family))

            self._update(migrate)
            table = self._current().get("aliases")
        if not isinstance(table, dict):
            return {}
        out = {}
        for variant, value in table.items():
            names = custom_aliases(value)
            if isinstance(variant, str) and names:
                out[variant] = names
        return out

    def set_aliases(self, variant: str, names: list[str]) -> list[str]:
        """Keep a variant's own aliases (none: forget its entry) and return them as kept.
        Only this variant's entry of the file changes."""
        kept = custom_aliases(names)

        def change(data: dict[str, Any]) -> None:
            table = data.get("aliases")
            if not isinstance(table, dict):
                table = data["aliases"] = {}
            if kept:
                table[variant] = kept
            else:
                table.pop(variant, None)

        self._update(change)
        return kept

    # --- preferences ---

    def get(self, key: str, default: Any = None) -> Any:
        prefs = self._current().get("prefs")
        return prefs.get(key, default) if isinstance(prefs, dict) else default

    def set(self, key: str, value: Any) -> None:
        def change(data: dict[str, Any]) -> None:
            prefs = data.get("prefs")
            if not isinstance(prefs, dict):
                prefs = data["prefs"] = {}
            prefs[key] = value

        self._update(change)

    def flag(self, key: str) -> bool:
        """A boolean preference of the mod switch and the classic hand-off (FLAGS), its default until set."""
        value = self.get(key)
        return value if isinstance(value, bool) else FLAGS[key]

    @property
    def scan_consent(self) -> bool | None:
        """None until the user answered the scan consent popup; then True (the game folders may be checked) or
        False."""
        value = self.get("scan_consent")
        return value if isinstance(value, bool) else None

    @property
    def spine_consent(self) -> bool | None:
        """None until the user confirms whether they hold their own Spine licence; only True grants use."""
        value = self.get("spine_consent")
        return value if isinstance(value, bool) else None

    def data_id(self, data_dir: Path) -> str:
        """This data directory's id (``data_id``), kept with the data directory's own path (``data_path``): made at
        the first call. When the path recorded with it is another one, the folder was copied or moved: a copy (the
        recorded folder still exists and holds the same id) gets a new id, so it never shares the original's; a moved
        folder keeps its id and records its new path. Only the services call it, when they first build the library,
        so the constructor never adds preferences."""
        here = data_path(data_dir)
        made: list[str] = []

        def change(data: dict[str, Any]) -> None:
            prefs = data.get("prefs")
            if not isinstance(prefs, dict):
                prefs = data["prefs"] = {}
            old, path = prefs.get("data_id"), prefs.get("data_path")
            if _is_data_id(old) and path == here:
                made.append(old)
                return
            if _is_data_id(old) and not (isinstance(path, str) and path and _holds_id(Path(path), old)):
                new = old  # moved (or no path recorded yet): the same data directory
                logger.info("data directory now at %s, keeping its id", here)
            else:
                new = secrets.token_hex(DATA_ID_LENGTH // 2)
                if _is_data_id(old):
                    logger.info("data directory copied from %s: new id", path)
            prefs["data_id"], prefs["data_path"] = new, here
            made.append(new)

        current = self.get("data_id")
        if _is_data_id(current) and self.get("data_path") == here:
            return current
        self._update(change)
        return made[0]


# Boolean preferences and their defaults: the tray or menu bar icon,
# the hand-off prompt before the classic UI opens, and whether the first toggle's explanation was shown
FLAGS = {"tray": False, "classic_prompt": True, "mods_explained": False,
         "startup_update": True}
DATA_ID_LENGTH = 12  # hex digits


def data_path(data_dir: Path) -> str:
    """A data directory's path as ``data_path`` records it: resolved, and case-folded on Windows."""
    return os.path.normcase(str(Path(data_dir).resolve()))


def _is_data_id(value: Any) -> bool:
    return isinstance(value, str) and len(value) == DATA_ID_LENGTH and all(c in "0123456789abcdef" for c in value)


def _holds_id(folder: Path, data_id: str) -> bool:
    """Whether a data directory still exists and its webui.json holds this id (the folder was copied, not moved)."""
    try:
        data = json.loads((folder / "webui.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    prefs = data.get("prefs") if isinstance(data, dict) else None
    return isinstance(prefs, dict) and prefs.get("data_id") == data_id


# The memorial lobby's fullscreen zoom-out limit (web/js/lobby.js zoomBounds): the game's view, the art every clip keeps
# painted (Full Art), the box of the scene's art over its poses (Unlocked), or a custom number of game views across.
LOBBY_ZOOM_MODES = ("game", "art", "unlocked", "custom")
LOBBY_ZOOM_CUSTOM = (1.0, 4.0)  # the custom limit's range; lobby.js never zooms out further (ZOOM_OUT_MAX)
LOBBY_ZOOM_CUSTOM_DEFAULT = 2.0


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def lobby_zoom(mode: Any, custom: Any, legacy: Any = None) -> dict[str, Any]:
    """The zoom-out setting as stored, every field valid: the mode, else the boolean the setting was before (`legacy`,
    lobby_zoom_out: off is the game's view), else Full Art; and the custom limit in 0.1 steps within its range."""
    lo, hi = LOBBY_ZOOM_CUSTOM
    return {
        "mode": mode if isinstance(mode, str) and mode in LOBBY_ZOOM_MODES else "game" if legacy is False else "art",
        "custom": round(min(hi, max(lo, float(custom))), 1) if is_number(custom) else LOBBY_ZOOM_CUSTOM_DEFAULT,
    }
