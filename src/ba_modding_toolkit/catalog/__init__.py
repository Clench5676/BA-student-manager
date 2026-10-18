"""Offline student catalog filtered by the user's installed portrait skeletons."""

from __future__ import annotations

import copy
import json
import logging
import threading
from pathlib import Path
from typing import Protocol

from ..errors import ServiceError
from ..naming import parse_filename
from ._data import base_rank, csv_entry, read_character_map
from ._names import BASE_SHORT, LANGUAGES, csv_bases, csv_names
from .models import Family, Variant

__all__ = ["Catalog", "Family", "Variant"]
DEFAULT_DATA = Path(__file__).parent / "data" / "catalog.json"
logger = logging.getLogger(__name__)
HOME_SUFFIXES = ("_home", "_home_gl", "_home_teen")


class GameSource(Protocol):
    """The two game asset queries used by the catalog."""

    def spine_cores(self, kind: str) -> dict[str, list[Path]]:
        """Return installed cores and their bundle parts."""
        ...

    def collection_names(self) -> dict[str, list[str]]:
        """Return available background and portrait texture names."""
        ...


class Catalog:
    """Build and cache a thread-safe roster; reload after the game scan changes.

    Returned records are independent copies so RPC callers cannot mutate the
    cached snapshot. Only the supplied game object performs game asset access.
    """

    def __init__(self, game: GameSource | None, character_map: Path | None, data: Path = DEFAULT_DATA):
        self.game = game
        self.character_map = Path(character_map) if character_map is not None else None
        self.data = Path(data)
        self._lock = threading.RLock()
        self._snapshot: tuple[dict[str, Family], dict[str, Variant], dict[str, Variant]] | None = None

    def reload(self) -> None:
        """Rebuild the snapshot atomically, retaining the old one if rebuilding fails."""
        with self._lock:
            self._snapshot = self._build()

    def families(self) -> list[Family]:
        """Return families with at least one installed portrait skeleton, sorted by key."""
        with self._lock:
            return copy.deepcopy(list(self._get()[0].values()))

    def family(self, key: str) -> Family:
        """Return a family or raise a structured lookup error."""
        with self._lock:
            result = self._get()[0].get(key.lower())
            if result is None:
                raise ServiceError("catalog_family_not_found", key=key)
            return copy.deepcopy(result)

    def variant(self, key: str) -> Variant:
        """Return an installed variant or raise a structured lookup error."""
        with self._lock:
            result = self._get()[1].get(key.lower())
            if result is None:
                raise ServiceError("catalog_variant_not_found", key=key)
            return copy.deepcopy(result)

    def variant_for_core(self, core: str) -> Variant | None:
        """Resolve an installed portrait or lobby core, ignoring letter case."""
        with self._lock:
            return copy.deepcopy(self._get()[2].get(core.lower()))

    def _get(self) -> tuple[dict[str, Family], dict[str, Variant], dict[str, Variant]]:
        if self._snapshot is None:
            self._snapshot = self._build()
        return self._snapshot

    def _metadata(self) -> tuple[dict, dict, set[str]]:
        try:
            data = json.loads(self.data.read_text(encoding="utf-8"))
            entries = {key.lower(): dict(entry) for key, entry in data["variants"].items()}
            shipped_keys = set(entries)
            students = {str(key): dict(student) for key, student in data["students"].items()}
            for key, entry in entries.items():
                student = students[str(entry["student_id"])]
                if student["base"] not in entries or key != entry["file_id"].lower():
                    raise ValueError("Invalid catalog key")
                if set(entry["names"]) != set(LANGUAGES) or set(student["names"]) != set(LANGUAGES):
                    raise ValueError("Invalid catalog languages")
                for name in entry["names"].values():
                    if not name["full"] or not name["short"]:
                        raise ValueError("Empty catalog name")
                if not isinstance(entry["order"], int) or not isinstance(entry["playable"], bool):
                    raise ValueError("Invalid catalog variant")
            shipped_students = set(students)
            if self.character_map is not None and self.character_map.exists():
                for row in read_character_map(self.character_map):
                    key = row["file_id"].lower()
                    if key in entries:
                        continue
                    entry = csv_entry(row)
                    sid = str(entry["student_id"])
                    student = students.setdefault(sid, {"names": csv_bases(row), "school": entry["school"]})
                    entry["names"], entry["fallbacks"] = csv_names(row, student["names"])
                    entry["order"] = 1 + max((e["order"] for e in entries.values()
                                              if str(e["student_id"]) == sid), default=-1)
                    entries[key] = entry
                    if sid not in shipped_students and ("base" not in student or
                                                        base_rank(entry) < base_rank(entries[student["base"]])):
                        student["base"] = key
            return entries, students, set(entries) - shipped_keys
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            logger.exception("Unable to read catalog metadata")
            raise ServiceError("catalog_data_invalid", path=str(self.data)) from exc

    def _build(self) -> tuple[dict[str, Family], dict[str, Variant], dict[str, Variant]]:
        if self.game is None:
            return {}, {}, {}
        entries, students, added = self._metadata()
        portraits = self.game.spine_cores("spr")
        lobbies = self.game.spine_cores("lobby")
        lobby_names = {core.lower(): core for core in lobbies}
        art = {kind: {name.lower(): name for name in names}
               for kind, names in self.game.collection_names().items()}
        families, variants, cores = {}, {}, {}
        for core, paths in sorted(portraits.items()):
            key = core.lower().removesuffix("_spr")
            if key not in entries:
                added.add(key)
                file_id = core[:-4] if core.lower().endswith("_spr") else core
                entries[key] = {"file_id": file_id, "student_id": f"unknown:{key}",
                                "names": {lang: {"full": file_id, "short": BASE_SHORT[lang]} for lang in LANGUAGES},
                                "playable": False, "order": 0, "school": None}
                students[f"unknown:{key}"] = {"base": key, "names": {lang: file_id for lang in LANGUAGES},
                                             "school": None}
            entry = entries[key]
            student = students[str(entry["student_id"])]
            if key in added:
                portrait = art.get("portrait", {}).get(f"student_portrait_{key}_collection")
                if portrait:
                    entry.update(playable=True, portrait=portrait)
                entry["bg"] = entries[student["base"]].get("bg")
            family_key = student["base"]
            family = families.setdefault(family_key, Family(family_key, student["names"], student.get("school"), []))
            aliases = [key, *(alias for alias in entry.get("core_aliases", [])
                              if alias.lower() not in entries or alias.lower() == key)]
            homes = [lobby_names[alias.lower() + suffix] for alias in aliases for suffix in HOME_SUFFIXES
                     if alias.lower() + suffix in lobby_names]
            dates = [parse_filename(path.name).date for path in paths]
            variant = Variant(key, entry["file_id"], family_key, entry["names"], entry["playable"],
                              entry["order"], core, next(iter(homes), None),
                              art.get("bg", {}).get((entry.get("bg") or "").lower()),
                              art.get("portrait", {}).get((entry.get("portrait") or "").lower()),
                              max(filter(None, dates), default=None), entry.get("page_id") or None)
            family.variants.append(variant)
            variants[key] = variant
            cores[core.lower()] = variant
            for home in homes:
                # A direct file-id match takes precedence over a shared dev alias.
                if home.lower() in (key + suffix for suffix in HOME_SUFFIXES):
                    cores[home.lower()] = variant
                else:
                    cores.setdefault(home.lower(), variant)
        for family in families.values():
            family.variants.sort(key=lambda variant: (variant.key != family.key, not variant.playable,
                                                      variant.order, variant.key))
        return dict(sorted(families.items())), variants, cores
