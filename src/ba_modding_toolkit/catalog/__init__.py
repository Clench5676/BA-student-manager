"""Offline roster filtered by installed portraits and special Spine slots."""

from __future__ import annotations

import copy
import json
import logging
import threading
from pathlib import Path
from typing import Iterable, Protocol

from ..errors import ServiceError
from ..naming import parse_filename
from ._data import base_rank, csv_entry, read_character_map
from ._names import BASE_SHORT, LANGUAGES, apply_thai_names, cn_aliases, cn_base, cn_words, csv_bases, csv_names, name_head
from .models import CoreMap, Family, Variant
from .special import SPECIAL_PREFIX, describe

__all__ = ["Catalog", "CoreMap", "Family", "Variant"]
DEFAULT_DATA = Path(__file__).parent / "data" / "catalog.json"
logger = logging.getLogger(__name__)
HOME_SUFFIXES = ("_home", "_home_gl", "_home_teen")
SERVERS = ("japan", "global")  # the keys of the shipped release flags, as Settings.server_region() names them


def _names_list(value: object) -> bool:
    """Whether a catalog field holds a list of non-empty names (the aliases)."""
    return isinstance(value, list) and all(isinstance(name, str) and name.strip() for name in value)


class GameSource(Protocol):
    """The two game asset queries used by the catalog."""

    def spine_cores(self, kind: str) -> dict[str, list[Path]]:
        """Return installed cores and their bundle parts."""
        ...

    def collection_names(self) -> dict[str, list[str]]:
        """Return available background and portrait texture names."""
        ...

    def model_cores(self) -> set[str]:
        """Return the lower-case dev names of installed 3D chibi prefabs (optional for a game source)."""
        ...


def model_core(key: str, aliases: list[str], cores: set[str]) -> str | None:
    """The 3D chibi of a variant: its key, the key + '_original' (base variants, e.g. hoshino_original), then the
    dev aliases, then the aliases + '_original'. Dependencies are never matched by name (the CAB index resolves
    them)."""
    aliases = [alias.lower() for alias in aliases]
    candidates = [key, key + "_original", *aliases, *(alias + "_original" for alias in aliases)]
    return next((name for name in candidates if name in cores), None)


class Catalog:
    """Build and cache a thread-safe roster; reload after the game scan changes.

    Returned records are independent copies so RPC callers cannot mutate the
    cached snapshot. Only the supplied game object performs game asset access.
    """

    def __init__(self, game: GameSource | None, character_map: Path | None, data: Path = DEFAULT_DATA,
                 server: str = "global"):
        self.game = game
        self.character_map = Path(character_map) if character_map is not None else None
        self.data = Path(data)
        self.server = server  # whose release flags apply when the install has no collection portrait
        self._lock = threading.RLock()
        self._snapshot: tuple[dict[str, Family], dict[str, Variant], dict[str, Variant]] | None = None
        # the shipped data and the character map, parsed once and kept; every use works on a copy (_metadata)
        self._parsed: tuple[dict, dict, set[str]] | None = None

    def reload(self) -> None:
        """Rebuild the snapshot atomically, retaining the old one if rebuilding fails. The shipped data and the
        character map are parsed again; the kept parse and the snapshot are replaced only when both succeed."""
        with self._lock:
            parsed = self._parse() if self.game is not None or self._parsed is not None else None
            snapshot = self._build(parsed)
            if parsed is not None:
                self._parsed = parsed
            self._snapshot = snapshot

    def families(self) -> list[Family]:
        """Return families with installed portraits or special Spine slots, sorted by key."""
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

    def variant_for_asset_core(self, core: str) -> Variant | None:
        """Resolve internal Spine names too: assets can retain a dev name or character ID while their installed
        bundle uses the variant's file ID. Direct file IDs take precedence over shared dev aliases."""
        with self._lock:
            _, variants, cores = self._get()
            lower = core.lower()
            if lower in cores:
                return copy.deepcopy(cores[lower])
            suffix = next((s for s in sorted(("_spr", *HOME_SUFFIXES), key=len, reverse=True)
                           if lower.endswith(s)), None)
            if suffix is None:
                return None
            stem = lower[:-len(suffix)]
            if stem in cores and cores[stem].spine_category:
                return copy.deepcopy(cores[stem])
            entries, _, _ = self._metadata()
            if stem in entries:
                return copy.deepcopy(variants.get(stem))
            matches = [variants[key] for key, entry in entries.items() if key in variants
                       and stem in (alias.lower() for alias in entry.get("core_aliases", []))]
            return copy.deepcopy(matches[0]) if len(matches) == 1 else None

    def model_map(self, cores: Iterable[str]) -> dict[str, str]:
        """Map model dev names to variant keys, independently of the selected install's portraits."""
        available = {core.lower() for core in cores}
        with self._lock:
            entries, _, _ = self._metadata()
            for key in self._get()[1]:
                if not key.startswith(SPECIAL_PREFIX):
                    entries.setdefault(key, {})
            result = {}
            for key, entry in entries.items():
                aliases = [alias.lower() for alias in entry.get("core_aliases", [])
                           if alias.lower() not in entries or alias.lower() == key]
                # Direct file IDs take precedence over shared dev aliases.
                for core in [key, key + "_original", *aliases, *(alias + "_original" for alias in aliases)]:
                    if core in available:
                        result.setdefault(core, key)
            return result

    def variant_for_model_core(self, core: str) -> Variant | None:
        """Resolve model filenames and internal dev names to an installed variant."""
        key = self.model_map([core]).get(core.lower())
        with self._lock:
            return copy.deepcopy(self._get()[1].get(key)) if key else None

    def core_map(self, spr_cores: Iterable[str], lobby_cores: Iterable[str],
                 special_cores: Iterable[str] = ()) -> CoreMap:
        """Map an install's portrait and memorial lobby cores to variant keys by the roster's own rules, for any
        install (the snapshot maps only the current one's). A portrait core's key is the core less "_spr"; a lobby
        core belongs to the installed variant whose key or core alias plus a lobby suffix names it, a direct file-id
        match first. A lobby core with no portrait of its variant in that install takes the variant the data names
        for it the same way, else the core less its suffix. Each call works on a copy of the kept parse, so one
        install's unknown portrait keys never enter another install's map. Backgrounds, nonstandard Spine cores
        and explicit special_cores use separate special:<core> keys."""
        portraits, lobbies = list(spr_cores), list(lobby_cores)
        with self._lock:
            entries, students, added = self._metadata()
            shipped = set(entries)
            keys, homes, _aliases = self._map(entries, students, added, portraits, lobbies, set(special_cores))
        spr = {keys[core.lower()]: core for core in sorted(portraits)}
        lobby = {key: cores[0] for key, cores in homes.items() if cores}
        names = {key: entries[key]["names"] for key in set(keys.values()) if key in shipped}
        names.update({key: describe(core, entries, students)[2] for core, key in keys.items()
                      if key.startswith(SPECIAL_PREFIX)})
        return CoreMap(keys, spr, lobby, names)

    def _get(self) -> tuple[dict[str, Family], dict[str, Variant], dict[str, Variant]]:
        if self._snapshot is None:
            self._snapshot = self._build()
        return self._snapshot

    def _metadata(self) -> tuple[dict, dict, set[str]]:
        """A copy of the kept parse of the shipped data and the character map, parsed on first use: a build adds the
        install's unknown portrait keys to it, which must not leak into another build or another install's map."""
        if self._parsed is None:
            self._parsed = self._parse()
        return copy.deepcopy(self._parsed)

    def _parse(self) -> tuple[dict, dict, set[str]]:
        try:
            data = json.loads(self.data.read_text(encoding="utf-8"))
            entries = {key.lower(): dict(entry) for key, entry in data["variants"].items()}
            shipped_keys = set(entries)
            students = {str(key): dict(student) for key, student in data["students"].items()}
            if any("th" not in record["names"] for record in (*entries.values(), *students.values())):
                apply_thai_names(students, entries)
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
                released = entry.get("released")
                if released is not None and not (isinstance(released, dict) and all(
                        server in SERVERS and isinstance(flag, bool) for server, flag in released.items())):
                    raise ValueError("Invalid catalog release flags")
            for record in (*entries.values(), *students.values()):
                if not _names_list(record.get("aliases", [])):
                    raise ValueError("Invalid catalog aliases")
            shipped_students = set(students)
            if self.character_map is not None and self.character_map.exists():
                rows = read_character_map(self.character_map)
                words = cn_words(rows)
                for row in rows:
                    key = row["file_id"].lower()
                    if key in entries:
                        continue
                    entry = csv_entry(row)
                    sid = str(entry["student_id"])
                    student = students.setdefault(sid, {"names": csv_bases(row), "school": entry["school"]})
                    entry["names"], entry["fallbacks"] = csv_names(row, student["names"])
                    base, server = student["names"]["zh-CN"], cn_base(row)
                    # a new student takes the CN server's name of its rows named by the base alone
                    if (sid not in shipped_students and server and server != base
                            and name_head(entry["names"]["zh-CN"]["full"]) == base):
                        student["aliases"] = sorted({*student.get("aliases", []), server})
                    entry["aliases"] = cn_aliases(entry["names"]["zh-CN"]["full"], base,
                                                  student.get("aliases", []), words, [server])
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

    @staticmethod
    def _map(entries: dict, students: dict, added: set[str], portraits: list[str], lobbies: list[str],
             special_cores: set[str] | None = None
             ) -> tuple[dict[str, str], dict[str, list[str]], dict[str, list[str]]]:
        """The roster's core rules on one install's core names: {lower-case core: variant key}, each key's lobby
        cores in the install (the primary one first) and each portrait key's aliases (its key, then the core aliases
        the rule kept). Unknown portrait keys are added to ``entries``, ``students`` and ``added``, as the roster
        lists them, in the order the alias rule reads them."""
        special_cores = {core.lower() for core in special_cores or ()}
        lobby_names = {core.lower(): core for core in lobbies if core.lower() not in special_cores}
        keys: dict[str, str] = {}
        homes_of: dict[str, list[str]] = {}
        aliases_of: dict[str, list[str]] = {}
        for core in sorted(portraits):
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
            aliases = [key, *(alias for alias in entry.get("core_aliases", [])
                              if alias.lower() not in entries or alias.lower() == key)]
            homes = [lobby_names[alias.lower() + suffix] for alias in aliases for suffix in HOME_SUFFIXES
                     if alias.lower() + suffix in lobby_names]
            aliases_of[key], homes_of[key] = aliases, homes
            keys[core.lower()] = key
            for home in homes:
                # A direct file-id match takes precedence over a shared dev alias.
                if home.lower() in (key + suffix for suffix in HOME_SUFFIXES):
                    keys[home.lower()] = key
                else:
                    keys.setdefault(home.lower(), key)
        # lobby cores of variants without a portrait in this install: the variant the data names for them (its key,
        # else a core alias), else the core less its suffix, so a core gets one key in every install
        aliased: dict[str, str] = {}
        for key, entry in entries.items():
            for alias in entry.get("core_aliases", []):
                if alias.lower() not in entries or alias.lower() == key:
                    aliased.setdefault(alias.lower(), key)
        suffixes = sorted(HOME_SUFFIXES, key=len, reverse=True)
        lobby_only: dict[str, list[tuple[bool, int, str]]] = {}
        for lower, core in sorted(lobby_names.items()):
            suffix = next((s for s in suffixes if lower.endswith(s)), None)
            if lower in keys or suffix is None:
                continue
            stem = lower[:-len(suffix)]
            key = stem if stem in entries else aliased.get(stem, stem)
            keys[lower] = key
            lobby_only.setdefault(key, []).append((stem != key, HOME_SUFFIXES.index(suffix), core))
        for key, found in lobby_only.items():
            homes_of.setdefault(key, []).extend(core for *_, core in sorted(found))
        for core in lobbies:
            lower = core.lower()
            if lower in special_cores or not lower.endswith(HOME_SUFFIXES):
                key = SPECIAL_PREFIX + lower
                keys[lower], homes_of[key] = key, [core]
        return keys, homes_of, aliases_of

    def _build(self, parsed: tuple[dict, dict, set[str]] | None = None
               ) -> tuple[dict[str, Family], dict[str, Variant], dict[str, Variant]]:
        if self.game is None:
            return {}, {}, {}
        entries, students, added = copy.deepcopy(parsed) if parsed is not None else self._metadata()
        portraits = self.game.spine_cores("spr")
        lobbies = self.game.spine_cores("lobby")
        art = {kind: {name.lower(): name for name in names}
               for kind, names in self.game.collection_names().items()}
        collection = art.get("portrait", {})
        if portraits and not collection:
            logger.warning("No collection portraits found; recruitable follows the shipped release flags")
        models = getattr(self.game, "model_cores", set)()
        # the same mapping core_map gives any install, run on the core lists fetched once for this build
        special_cores = {core for core, paths in lobbies.items() if paths and
                         parse_filename(paths[0].name).category != "spinelobbies"}
        keys, homes_of, aliases_of = self._map(entries, students, added, list(portraits), list(lobbies), special_cores)
        families, variants, cores = {}, {}, {}
        for core, paths in sorted(portraits.items()):
            key = keys[core.lower()]
            entry = entries[key]
            student = students[str(entry["student_id"])]
            if key in added:
                portrait = collection.get(f"student_portrait_{key}_collection")
                if portrait:
                    entry.update(playable=True, portrait=portrait)
                entry["bg"] = entries[student["base"]].get("bg")
            family_key = student["base"]
            family = families.setdefault(family_key, Family(family_key, student["names"], student.get("school"), [],
                                                            list(student.get("aliases", []))))
            aliases, homes = aliases_of[key], homes_of[key]
            dates = [parse_filename(path.name).date for path in paths]
            portrait = collection.get((entry.get("portrait") or "").lower())
            variant = Variant(key, entry["file_id"], family_key, entry["names"], entry["playable"],
                              entry["order"], core, next(iter(homes), None),
                              art.get("bg", {}).get((entry.get("bg") or "").lower()), portrait,
                              max(filter(None, dates), default=None), entry.get("page_id") or None,
                              recruitable=self._recruitable(entry, portrait is not None, bool(collection)),
                              model=model_core(key, aliases[1:], models), schale_id=entry.get("schale_id"),
                              aliases=list(entry.get("aliases", [])))
            family.variants.append(variant)
            variants[key] = variant
        for core, paths in sorted(lobbies.items()):
            key = keys.get(core.lower(), "")
            if not key.startswith(SPECIAL_PREFIX):
                continue
            family_key, base, names = describe(core, entries, students)
            family = families.setdefault(family_key, Family(family_key, base, None, []))
            dates = [parse_filename(path.name).date for path in paths]
            category = parse_filename(paths[0].name).category if paths else "spinebackground"
            variant = Variant(key, core, family_key, names, False, len(family.variants), None, core, None, None,
                              max(filter(None, dates), default=None), spine_category=category)
            family.variants.append(variant)
            variants[key] = variant
        cores = {lower: variants[key] for lower, key in keys.items() if key in variants}
        for variant in variants.values():
            if variant.model:
                cores.setdefault(variant.model.lower(), variant)
        for family in families.values():
            # recruitable here first, then playable on another server, then story and NPC variants
            family.variants.sort(key=lambda variant: (variant.key != family.key, not variant.recruitable,
                                                      not variant.playable, variant.order, variant.key))
        return dict(sorted(families.items())), variants, cores

    def _recruitable(self, entry: dict, installed: bool, indexed: bool) -> bool:
        """Whether a playable variant can be recruited on the selected server.

        Each server builds its collection bundles with the students it has released, so an installed collection
        portrait decides. Without one, the shipped flag tells a portrait-name gap (True) from a student not on this
        server yet (False); with no flag either, the install decides unless it has no collection index at all."""
        if not entry["playable"]:
            return False
        if installed:
            return True
        flag = (entry.get("released") or {}).get(self.server)
        return flag if flag is not None else not indexed
