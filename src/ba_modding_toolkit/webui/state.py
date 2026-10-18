"""Small UI state kept between launches: the asset consent, recently opened variants and the web UI's own
preferences (voice volume, the mod library folder). Kept apart from config.toml, which the classic GUI rewrites
with only its own keys."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

RECENT_MAX = 50

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


class UiState:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._data = data
        except (OSError, ValueError):
            self._data = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    @property
    def consent(self) -> bool | None:
        """None until the user answered the consent popup; then True (cache allowed) or False."""
        value = self._data.get("consent")
        return value if isinstance(value, bool) else None

    def set_consent(self, granted: bool) -> None:
        with self._lock:
            self._data["consent"] = bool(granted)
            self._save()

    def recent(self) -> list[str]:
        value = self._data.get("recent")
        return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []

    def visit(self, variant_key: str) -> None:
        with self._lock:
            recent = [v for v in self.recent() if v != variant_key]
            self._data["recent"] = [variant_key, *recent][:RECENT_MAX]
            self._save()

    # --- preferences ---

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get("prefs", {}).get(key, default)

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data.setdefault("prefs", {})[key] = value
            self._save()
