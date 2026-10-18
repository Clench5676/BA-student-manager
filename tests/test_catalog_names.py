"""Variant names in every language: the curated name table and the shipped catalog."""

import csv
import importlib.util
import json
from pathlib import Path
import re

import pytest

from ba_modding_toolkit.catalog import DEFAULT_DATA
from ba_modding_toolkit.catalog._names import (
    BASE_SHORT, FILE_ID, LANGUAGES, NAMES, NAMING, SEPARATORS, csv_bases, usable,
)

FIXTURES = Path(__file__).parent / "fixtures" / "catalog"
ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((FIXTURES / "name_table.json").read_text(encoding="utf-8"))
CJK = re.compile(r"[　-ヿ㐀-鿿＀-￯]")
SOURCES = {"derived", "curated", "fallback", "official", "translated"}


@pytest.fixture(scope="module")
def shipped() -> dict:
    return json.loads(DEFAULT_DATA.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location("build_catalog_data", ROOT / "scripts" / "build_catalog_data.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def foreign(text: str, lang: str) -> list[str]:
    """Characters of another language's script in a name."""
    if lang == "en":
        return CJK.findall(text)
    return [char for char in text if char in CASES["foreign_script"].get(lang, "")]


def all_names(data: dict):
    for key, entry in data["variants"].items():
        for lang, name in entry["names"].items():
            yield key, lang, name["full"]
            yield key, lang, name["short"]
    for sid, student in data["students"].items():
        for lang, name in student["names"].items():
            yield f"student {sid}", lang, name


def test_shipped_names_use_their_own_script(shipped: dict):
    bad = [(key, lang, text) for key, lang, text in all_names(shipped) if foreign(text, lang)]
    assert not bad
    assert not [(key, lang, text) for key, lang, text in all_names(shipped) if not usable(text)]


def test_shipped_names_keep_no_untranslated_part(shipped: dict):
    for key, entry in shipped["variants"].items():
        assert "untranslated_csv_part" not in entry["fallbacks"].values(), key
        assert set(entry["name_sources"].values()) <= SOURCES, key


def test_shipped_story_names_follow_the_bracket_rules(shipped: dict):
    others = {lang: {sep.strip() for other, sep in SEPARATORS.items() if sep != SEPARATORS[lang]} for lang in LANGUAGES}
    checked = 0
    for key, entry in shipped["variants"].items():
        base = shipped["students"][str(entry["student_id"])]["names"]
        for lang, name in entry["names"].items():
            if entry["playable"] or entry["name_sources"][lang] not in ("official", "translated"):
                continue
            checked += 1
            short = name["short"]
            if short == BASE_SHORT[lang]:
                assert name["full"] == base[lang], (key, lang)
                continue
            bracket = f" ({short})" if lang == "en" else f"（{short}）"
            assert name["full"] == base[lang] + bracket, (key, lang)
            assert not any(sep in short for sep in others[lang] - {SEPARATORS[lang].strip()}), (key, lang)
    assert checked > 400


def test_name_table_entries_fit_their_languages():
    entries = [entry for entry in NAMING["glossary"].values() if "source" in entry] + list(NAMES.values())
    assert len(entries) > 150
    for entry in entries:
        assert entry["source"] in ("official", "translated"), entry
        assert entry.get("basis"), entry
        assert set(entry) - {"source", "basis", "kivo"} <= set(LANGUAGES), entry
        for lang in set(entry) & set(LANGUAGES):
            assert entry[lang] and not foreign(entry[lang], lang), (lang, entry)
    for entry in NAMING["glossary"].values():
        assert all(entry.get(lang) for lang in ("en", "ja", "zh-TW")), entry


def write_cases(path: Path) -> Path:
    fields = sorted({field for row in CASES["rows"] for field in row})
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(CASES["rows"])
    return path


def test_generator_applies_the_name_table(generator, tmp_path: Path):
    entries = generator.build_catalog(write_cases(tmp_path / "map.csv"), FIXTURES)["variants"]
    for key, expected in CASES["expected"].items():
        entry = entries[key]
        assert {field: entry[field] for field in expected} == expected, key


def test_bases_keep_titles_whole_and_skip_file_ids():
    rows = {row["file_id"]: row for row in CASES["rows"]}
    assert csv_bases(rows["CH0277"])["en"] == "Professor Smug"
    assert csv_bases(rows["NP0139"])["en"] == "Niko"
    assert not FILE_ID.search(csv_bases(rows["NP0022"])["ja"])
    assert not usable("NP0022") and not usable("Citizen_animal5_spr") and usable("Arona")
