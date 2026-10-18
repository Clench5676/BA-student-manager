"""Build the offline catalog from local character maps and SchaleDB exports.

Optional prototype names, wiki proposals and variant metadata override derived
values. Variant words and base names that the character map leaves untranslated
come from the curated glossary and name table in catalog/data/naming.json, and
name_sources says whether that wording is official or translated. No game assets
are extracted or written by this command.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import logging
from pathlib import Path
import re
import sys

# Support direct invocation from a source checkout without installing the script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from ba_modding_toolkit.catalog._data import base_rank, csv_entry, read_character_map
from ba_modding_toolkit.catalog._names import (
    LANGUAGES, NAMING, clean, compose, csv_bases, csv_names, csv_sources, given_name, short_name,
)

logger = logging.getLogger(__name__)

PATH_ALIASES = {"shiroko_ridingsuit": "shiroko_cycling", "reizyo": "reijo"}
PORTRAIT_ALIASES = {
    "shiroko_ridingsuit": "Shiroko_ridingsuit", "saya_casual": "Saya_casual",
    "izumi_swimsuit": "Izumi_swimsuit", "erika": "erika", "ch0219": "Ch0219",
    "ch0355": "CH0355", "np0288": "CH0355_01",
}
STORY_ALIASES = {"hoshino_firstyear": "ch0241", "hoshino_terror": "np0186"}
CORE_ALIASES = {"airi": ["airi0"]}
SERVER_INDEX = {"ja": 0, "en": 1, "zh-TW": 1, "zh-CN": 2}
# SchaleDB IsReleased is [Japan, Global, China]; the keys are Settings.server_region() values
RELEASE_INDEX = {"japan": 0, "global": 1}


def read_json(path: Path | None) -> dict:
    """Load optional override data without requiring the prototype at runtime."""
    return json.loads(path.read_text(encoding="utf-8")) if path is not None else {}


def load_schaledb(directory: Path) -> dict[str, dict[str, dict]]:
    """Load localized student tables keyed by the SchaleDB student id."""
    result = {}
    for lang, suffix in LANGUAGES.items():
        data = read_json(directory / f"students.{suffix}.json")
        rows = data.values() if isinstance(data, dict) else data
        result[lang] = {str(row["Id"]): row for row in rows}
    return result


def match_student(row: dict, students: dict[str, dict]) -> list[dict]:
    """Match file ids, shared dev forms, then localized given-name and skin pairs."""
    key = row["file_id"].lower()
    matches = [student for student in students.values()
               if key in (student["PathName"].lower(), student["DevName"].lower(),
                          re.sub(r"_\d+$", "", student["DevName"].lower()))
               or PATH_ALIASES.get(key) == student["PathName"].lower()]
    if not matches and not row.get("spine_remark"):
        base = given_name(row.get("name_en", ""))
        full = compose(base, [row.get("skin_en", "")], "en")["full"]
        matches = [student for student in students.values() if clean(student["Name"], "en") == full]
    if len(matches) > 1:
        base = given_name(row.get("name_en", ""))
        preferred = [student for student in matches if student.get("PersonalName") == base]
        matches = preferred or matches
    return sorted(matches, key=lambda student: (student.get("DefaultOrder", student["Id"]), student["Id"]))


def portrait_name(entry: dict, student: dict) -> str:
    """Resolve collection texture names, including legacy and shared-form names."""
    key = entry["file_id"].lower()
    stem = PORTRAIT_ALIASES.get(key)
    if stem is None:
        file_id = student["DevName"] if key.startswith("np") else entry["file_id"]
        stem = file_id.upper() if re.fullmatch(r"CH\d+", file_id, re.I) else "_".join(
            part.capitalize() for part in file_id.split("_"))
    return f"Student_Portrait_{stem}_Collection"


def build_catalog(csv_path: Path, schaledb: Path, names_path: Path | None = None,
                  wiki_path: Path | None = None, variants_path: Path | None = None) -> dict:
    """Merge local source tables and return deterministic, asset-free metadata."""
    rows = read_character_map(csv_path)
    localized = load_schaledb(schaledb)
    names, wiki, curated = read_json(names_path), read_json(wiki_path), read_json(variants_path)
    entries, row_map, matches, conflicts = {}, {}, {}, []
    for row in sorted(rows, key=lambda item: item["file_id"].lower()):
        key = row["file_id"].lower()
        if key in entries:
            conflicts.append({"type": "duplicate_file_id", "key": key})
            continue
        row_map[key] = row
        entry = entries[key] = csv_entry(row)
        found = match_student(row, localized["en"])
        if not found:
            continue
        student = found[0]
        matches[key] = student
        if len(found) > 1:
            conflicts.append({"type": "shared_skeleton", "key": key, "schale_ids": [s["Id"] for s in found]})
        entry.update(playable=True, kind="playable", bg=student.get("CollectionBG"),
                     portrait=portrait_name(entry, student), school=student.get("School"),
                     schale_id=student["Id"], order=student.get("DefaultOrder", student["Id"]))
        # per-server release, used at runtime when the install has no collection portrait for the variant
        flags = student.get("IsReleased") or []
        if flags:
            entry["released"] = {server: bool(flags[i]) for server, i in RELEASE_INDEX.items() if i < len(flags)}
        aliases = {student["PathName"].lower(), student["DevName"].lower(),
                   re.sub(r"_\d+$", "", student["DevName"].lower())}
        aliases.update(CORE_ALIASES.get(key, []))
        entry["core_aliases"] = sorted(aliases - {key})
        entry["fallbacks"] = {}
        for lang in LANGUAGES:
            source = localized[lang].get(str(student["Id"]))
            if source and source.get("Name"):
                full = clean(source["Name"], lang)
                entry["names"][lang] = {"full": full, "short": short_name(full, lang)}
                released = source.get("IsReleased", [])
                entry["name_sources"][lang] = "derived"
                if len(released) > SERVER_INDEX[lang] and not released[SERVER_INDEX[lang]]:
                    entry["fallbacks"][lang] = "schaledb_unreleased"
            else:
                entry["fallbacks"][lang] = "missing_schaledb_name"

    # Research keys are descriptive; runtime keys always come from file ids.
    research = {key: key for key in entries}
    research.update({alias: key for key, entry in entries.items() for alias in entry.get("core_aliases", [])})
    research.update({re.sub(r"_(tank|dealer)$", "", alias): key
                     for alias, key in list(research.items())})
    research.update({key: value for key, value in STORY_ALIASES.items() if value in entries})
    for key in NAMING["story_parts"]:
        tail = key.rsplit("_", 1)[-1]
        if tail in entries:
            research[key] = tail
    family_overrides = {}
    for family in curated.get("families", []):
        variants = family["variants"]
        base_variant = next((variant for variant in variants if variant["kind"] == "playable"
                             and not variant.get("kivoSkin")), variants[0])
        base_key = base_variant["sprFile"].lower().removesuffix("_spr")
        if base_key not in entries:
            conflicts.append({"type": "missing_curated_base", "key": base_key})
            continue
        sid = str(entries[base_key]["student_id"])
        family_overrides[sid] = {"base": base_key, "names": names.get("families", {}).get(family["base"]),
                                 "school": family.get("schoolKey")}
        for index, variant in enumerate(variants):
            key = variant["sprFile"].lower().removesuffix("_spr")
            research[variant["key"]] = key
            if key not in entries:
                entries[key] = csv_entry({"file_id": variant["sprFile"].removesuffix("_spr"), "student_id": sid})
            entry = entries[key]
            entry.update(student_id=sid, kind=variant["kind"], playable=variant["kind"] == "playable",
                         bg=variant.get("collectionBG"), school=family.get("schoolKey"),
                         research_key=variant["key"], research_order=variant.get("releaseOrder", index))
            if variant.get("rosterPortraitSource") == "collection":
                entry["portrait"] = Path(variant["rosterPortrait"]).stem
            else:
                entry["portrait"] = None
            if not entry["playable"]:
                entry["fallbacks"] = {lang: "story_variant" for lang in LANGUAGES}
                entry.pop("released", None)

    grouped = defaultdict(list)
    for key, entry in entries.items():
        grouped[str(entry["student_id"])].append(key)
    students = {}
    school_ids = {row_map[key].get("school_id"): entry["school"] for key, entry in entries.items()
                  if entry["playable"] and key in row_map and entry["school"]}
    for sid, keys in sorted(grouped.items()):
        override = family_overrides.get(sid, {})
        base_key = override.get("base") or min(keys, key=lambda key: base_rank(entries[key]))
        base_entry = entries[base_key]
        schale_base = matches.get(base_key)
        bases = csv_bases(row_map.get(base_key, {"file_id": base_key}))
        if schale_base:
            for lang in LANGUAGES:
                source = localized[lang].get(str(schale_base["Id"]), {})
                bases[lang] = clean(source.get("PersonalName") or bases[lang], lang)
        bases.update(override.get("names") or {})
        school = override.get("school") or school_ids.get(row_map.get(base_key, {}).get("school_id")) or base_entry["school"]
        students[sid] = {"base": base_key, "names": bases, "school": school}
        pages = {entries[key].get("page_id"): entries[key] for key in keys if entries[key]["playable"]}
        for key in keys:
            entry = entries[key]
            entry["school"] = school
            if entry["playable"]:
                continue
            if key in row_map:
                entry["names"], entry["fallbacks"] = csv_names(row_map[key], bases)
                entry["name_sources"] = csv_sources(row_map[key], bases, entry["fallbacks"])
            if "research_key" not in entry:
                page = pages.get(entry.get("page_id"))
                entry["kind"] = "extra-spr" if page else "npc"
                entry["bg"] = (page or base_entry).get("bg")
        curated_playables = all("research_order" in entries[key] for key in keys if entries[key]["playable"])
        ordered = sorted(keys, key=lambda key: (key != base_key, not entries[key]["playable"],
                                                entries[key]["order"] if entries[key]["playable"] and
                                                not curated_playables else
                                                entries[key].get("research_order", float("inf")), key))
        for order, key in enumerate(ordered):
            entries[key]["order"] = order

    for research_key, parts in NAMING["story_parts"].items():
        key = research.get(research_key)
        if key not in entries:
            continue
        entry = entries[key]
        bases = students[str(entry["student_id"])]["names"]
        for lang in LANGUAGES:
            words = [part if lang == "zh-CN" else NAMING["glossary"][part][lang] for part in parts]
            entry["names"][lang] = compose(bases[lang], words, lang)
            entry["fallbacks"][lang] = "story_variant"
            entry["name_sources"][lang] = "fallback"
    for research_key, values in NAMING["terror"].items():
        key = research.get(research_key)
        if key in entries:
            entries[key]["names"] = {lang: {"full": full, "short": short} for lang, (full, short) in values.items()}
            entries[key]["fallbacks"] = {lang: "story_variant" for lang in LANGUAGES}
            entries[key]["name_sources"] = {lang: "fallback" for lang in LANGUAGES}

    for research_key, values in names.get("variants", {}).items():
        key = research.get(research_key)
        if key not in entries:
            conflicts.append({"type": "unresolved_curated_name", "key": research_key})
            continue
        entry = entries[key]
        entry["research_key"] = research_key
        for lang, value in values.items():
            entry["names"][lang] = {field: clean(value[field], lang) for field in ("full", "short")}
            entry["name_sources"][lang] = "curated"
    for research_key, value in wiki.items():
        key = research.get(research_key)
        if key not in entries:
            conflicts.append({"type": "unresolved_wiki_name", "key": research_key})
            continue
        for lang, full in value.get("proposed", {}).items():
            entries[key]["names"][lang] = {"full": clean(full, lang),
                                           "short": clean(value["proposedShort"][lang], lang)}
            entries[key]["name_sources"][lang] = "curated"
    for entry in entries.values():
        entry.pop("research_order", None)
    kinds = Counter(entry["kind"] for entry in entries.values())
    sources = Counter(source for entry in entries.values() for source in entry["name_sources"].values())
    fallback_count = sum(len(entry["fallbacks"]) for entry in entries.values())
    summary = {"kinds": dict(kinds), "names": dict(sources), "fallbacks": fallback_count,
               "conflicts": conflicts}
    return {"version": 1, "students": students, "variants": entries, "summary": summary,
            "rules": names.get("rules", {})}


def validate_game(data: dict, directory: Path) -> list[dict[str, str]]:
    """Report missing collection textures by reading names with UnityPy only."""
    import UnityPy
    from ba_modding_toolkit.searching import get_search_dirs

    textures = set()
    bundles = sorted({path for root in get_search_dirs(directory)
                      for path in root.glob("uis-01_common-14_charactercollect-*.bundle")})
    if not bundles:
        logger.warning("No collection bundles found in %s", directory)
    for path in bundles:
        environment = UnityPy.load(str(path))
        textures.update(obj.peek_name().lower() for obj in environment.objects if obj.type.name == "Texture2D")
    mismatches = [{"key": key, "field": field, "name": entry[field]}
                  for key, entry in sorted(data["variants"].items()) for field in ("bg", "portrait")
                  if entry.get(field) and entry[field].lower() not in textures]
    for mismatch in mismatches:
        logger.warning("Collection mismatch: %s", json.dumps(mismatch, sort_keys=True))
    return mismatches


def main(argv: list[str] | None = None) -> int:
    """Write compact sorted JSON and log source counts, conflicts and mismatches."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--schaledb", type=Path, required=True)
    parser.add_argument("--names", type=Path)
    parser.add_argument("--wiki", type=Path)
    parser.add_argument("--variants", type=Path)
    parser.add_argument("--game", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    data = build_catalog(args.csv, args.schaledb, args.names, args.wiki, args.variants)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n",
                        encoding="utf-8")
    logger.info("Catalog: %d students, %d variants; %s", len(data["students"]), len(data["variants"]),
                json.dumps(data["summary"], sort_keys=True))
    if args.game:
        mismatches = validate_game(data, args.game)
        logger.info("Collection validation: %d mismatches", len(mismatches))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
