"""Small UI state kept between launches: the asset consent, recently opened variants, the user's own aliases of the
students and the web UI's own preferences (voice volume, the mod library folder). Kept apart from config.toml, which
the classic GUI rewrites with only its own keys.

Several app instances may share one data folder: every change is applied to the file as it is at that moment (read
again under a lock the instances share), so one instance never erases what another wrote, and reads pick up the
other instances' writes."""

from __future__ import annotations

import contextlib
import copy
import json
import logging
import math
import os
import tempfile
import threading
import unicodedata
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

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
    "kind": ("student", "npc"),
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


@contextlib.contextmanager
def _file_lock(path: Path) -> Iterator[None]:
    """An exclusive lock on a lock file, shared with the other processes using it (fcntl.flock, msvcrt.locking on
    Windows). Without a lock file (an unwritable folder) the change goes ahead unlocked; writing then fails as before."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(path, "a+b")  # noqa: SIM115 - held for the lock's lifetime
    except OSError:
        logger.warning("cannot lock %s", path, exc_info=True)
        yield
        return
    with handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)  # retries for 10 s, then raises
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _recent_of(data: dict[str, Any]) -> list[str]:
    value = data.get("recent")
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


class UiState:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock_path = self.path.with_name(f"{self.path.name}.lock")
        self._lock = threading.RLock()
        self._data: dict[str, Any] = {}
        self._seen: tuple[int, int] | None = None  # the file's (mtime, size) when it was last read or written
        self._current()

    def _signature(self) -> tuple[int, int] | None:
        try:
            st = self.path.stat()
        except OSError:
            return None
        return st.st_mtime_ns, st.st_size

    def _read(self) -> dict[str, Any] | None:
        """The file's content now; None when it is missing or unreadable."""
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _current(self) -> dict[str, Any]:
        """The state as the file holds it now (another instance may have written it); what was last known while the
        file is missing or unreadable."""
        with self._lock:
            signature = self._signature()
            if signature is not None and signature != self._seen:
                data = self._read()
                if data is not None:
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
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix=f".{self.path.name}.", suffix=".tmp", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as out:
                    out.write(json.dumps(data, ensure_ascii=False, indent=1))
                os.replace(name, self.path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(name)
                raise
            self._data, self._seen = data, self._signature()

    @property
    def consent(self) -> bool | None:
        """None until the user answered the consent popup; then True (cache allowed) or False."""
        value = self._current().get("consent")
        return value if isinstance(value, bool) else None

    def set_consent(self, granted: bool) -> None:
        self._update(lambda data: data.__setitem__("consent", bool(granted)))

    def recent(self) -> list[str]:
        return _recent_of(self._current())

    def visit(self, variant_key: str) -> None:
        def change(data: dict[str, Any]) -> None:
            recent = [v for v in _recent_of(data) if v != variant_key]
            data["recent"] = [variant_key, *recent][:RECENT_MAX]

        self._update(change)

    # --- the user's own aliases, by family key ---

    def aliases(self) -> dict[str, list[str]]:
        """Every student's own aliases ({family key: [alias]}), cleaned as custom_aliases does; students without any
        are left out."""
        table = self._current().get("aliases")
        if not isinstance(table, dict):
            return {}
        out = {}
        for family, value in table.items():
            names = custom_aliases(value)
            if isinstance(family, str) and names:
                out[family] = names
        return out

    def set_aliases(self, family: str, names: list[str]) -> list[str]:
        """Keep a student's own aliases (none: forget the student's entry) and return them as kept. Only this
        student's entry of the file changes."""
        kept = custom_aliases(names)

        def change(data: dict[str, Any]) -> None:
            table = data.get("aliases")
            if not isinstance(table, dict):
                table = data["aliases"] = {}
            if kept:
                table[family] = kept
            else:
                table.pop(family, None)

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


# The memorial lobby's fullscreen zoom-out limit (web/js/lobby.js zoomBounds): the game's view, the art every clip keeps
# painted (Full Art), the box of the scene's art over its poses (Unlocked), or a custom number of game views across.
LOBBY_ZOOM_MODES = ("game", "art", "unlocked", "custom")
LOBBY_ZOOM_CUSTOM = (1.0, 4.0)  # the custom limit's range; lobby.js never zooms out further (ZOOM_OUT_MAX)
LOBBY_ZOOM_CUSTOM_DEFAULT = 2.0


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def lobby_zoom(mode: Any, custom: Any, legacy: Any = None) -> dict[str, Any]:
    """The zoom-out setting as stored, every field valid: the mode, else the boolean the setting was before (`legacy`,
    lobby_zoom_out: on is Full Art, off the game's view), and the custom limit in 0.1 steps within its range."""
    lo, hi = LOBBY_ZOOM_CUSTOM
    return {
        "mode": mode if isinstance(mode, str) and mode in LOBBY_ZOOM_MODES else "art" if legacy is True else "game",
        "custom": round(min(hi, max(lo, float(custom))), 1) if is_number(custom) else LOBBY_ZOOM_CUSTOM_DEFAULT,
    }
