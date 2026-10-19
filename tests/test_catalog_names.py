"""Variant names in every language: the curated name table and the shipped catalog."""

from collections import defaultdict
import csv
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex

import pytest

from ba_modding_toolkit.catalog import DEFAULT_DATA
from ba_modding_toolkit.catalog._names import (
    BASE_SHORT, FILE_ID, LANGUAGES, NAMES, NAMING, PART_SEPARATORS, SEPARATORS, TWINS, csv_bases,
    remark, usable,
)

FIXTURES = Path(__file__).parent / "fixtures" / "catalog"
ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((FIXTURES / "name_table.json").read_text(encoding="utf-8"))
KIVO = json.loads((FIXTURES / "kivo_sample.json").read_text(encoding="utf-8"))
CJK = re.compile(r"[　-ヿ㐀-鿿＀-￯]")
SOURCES = {"derived", "curated", "fallback", "official", "translated"}
# Variants still named alike in a language, with why they are not told apart yet:
# Hina's pajama sprite and Ein, Sof and Ohr were exported a second time with the same Kivo
# remark; np0081 and np0082 are the NPC-era school sprites of Asuna and Karin (Kivo's
# "NPC era" remark sits on a second character map row the builder does not use); the
# Japanese game names both forms of Shun (Swimsuit) alike.
KNOWN_TWINS = {
    lang: {frozenset(pair) for pair in (("np0009", "np0205"), ("np0129", "np0270"), ("np0130", "np0271"),
                                        ("np0131", "np0272"), ("np0081", "ch0281"), ("np0082", "ch0282"))}
    for lang in LANGUAGES
}
KNOWN_TWINS["ja"].add(frozenset(("ch0355", "np0288")))


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
        assert set(entry) - {"source", "basis", "cn"} <= set(LANGUAGES), entry
        for lang in set(entry) & set(LANGUAGES):
            assert entry[lang] and not foreign(entry[lang], lang), (lang, entry)
    for entry in NAMING["glossary"].values():
        assert all(entry.get(lang) for lang in ("en", "ja", "zh-TW")), entry
    # the CN server's wording (an alias, never shown) is Simplified Chinese and says where it is from
    worded = [entry for entry in [*NAMING["glossary"].values(), *NAMES.values()] if "cn" in entry]
    assert len(worded) >= 15
    for entry in worded:
        assert entry["cn"] and "cn:" in entry["basis"], entry
        entry["cn"].encode("gb2312")  # Simplified Chinese only


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


def kivo_given(name: str) -> str:
    """Kivo's given_name: its list name is the family and given name joined by a space."""
    return name.split(" ", 1)[-1]


def test_shipped_zh_cn_names_follow_kivo_wording(shipped: dict):
    """Base names and costume words are Kivo's community wording, never the CN server's."""
    for key, kivo in KIVO["variants"].items():
        entry = shipped["variants"][key]
        name = entry["names"]["zh-CN"]
        given, server = kivo_given(kivo["name"]), kivo_given(kivo["name_cn"])
        assert shipped["students"][str(entry["student_id"])]["names"]["zh-CN"] == given, key
        assert name["full"].startswith((given, kivo["name"].replace(" ", ""))), key
        parts = name["short"].split(SEPARATORS["zh-CN"])
        for word, cn_word in ((kivo["skin"], kivo["skin_cn"]), (kivo["remark"], None)):
            if word:
                assert word in parts, (key, word)
            if cn_word and cn_word != word:
                assert cn_word not in parts, (key, cn_word)
        if server != given:
            assert not name["full"].startswith(server + "\uff08") and name["full"] != server, key


def test_shipped_aliases_keep_the_cn_servers_names(shipped: dict):
    """The CN server's names that Kivo's wording replaced stay findable as aliases (never shown)."""
    for key, kivo in KIVO["variants"].items():
        entry = shipped["variants"][key]
        student = shipped["students"][str(entry["student_id"])]
        given, server = kivo_given(kivo["name"]), kivo_given(kivo["name_cn"])
        if server != given:
            assert server in student.get("aliases", []), key
        if kivo["skin_cn"] and kivo["skin_cn"] != kivo["skin"]:
            assert any(kivo["skin_cn"] in alias for alias in entry.get("aliases", [])), key
    # the names the user knew from before the switch: Airi, Aru, Arona, Momoi, Fuuka, Haruka, Kanna, Neru, Tsumugi
    students = {"airi": "\u7231\u7406", "aru": "\u7231\u9732", "arona": "\u963f\u6d1b\u5a1c", "momoi": "\u6843",
                "fuuka": "\u98ce\u9999", "haruka": "\u6625\u9999", "ch0170": "\u5eb7\u5a1c",
                "neru": "\u59ae\u9732", "ch0252": "\u4337"}
    for key, server in students.items():
        sid = str(shipped["variants"][key]["student_id"])
        assert server in shipped["students"][sid]["aliases"], key
        assert server in shipped["variants"][key]["aliases"], key
    # and the CN server's costume words: New Year, Armed, Bunny, Casual, Track
    words = {"aru_newyear": "\u65b0\u5e74", "np0267": "\u6b66\u88c5", "ch0099": "\u90a6\u59ae",
             "ch0082": "\u4fbf\u670d", "np0045": "\u4f53\u64cd\u670d", "utahaturret": "\u5c0f\u96f7"}
    for key, word in words.items():
        assert any(word in alias for alias in shipped["variants"][key]["aliases"]), key


def test_shipped_aliases_are_sorted_and_never_the_shown_name(shipped: dict):
    records = [(sid, student["names"]["zh-CN"], student.get("aliases")) for sid, student in shipped["students"].items()]
    records += [(key, entry["names"]["zh-CN"]["full"], entry.get("aliases")) for key, entry in shipped["variants"].items()]
    with_aliases = [record for record in records if record[2] is not None]
    assert len(with_aliases) > 200
    for key, shown, aliases in with_aliases:
        assert aliases and aliases == sorted(set(aliases)) and shown not in aliases, key
        assert all(usable(alias) and alias.strip() == alias for alias in aliases), key
    # a Terror form is its own name, never an alias of the student
    shiroko = shipped["students"][str(shipped["variants"]["shiroko"]["student_id"])]
    assert "aliases" not in shiroko


def test_cn_words_pair_kivos_words_with_the_servers():
    from ba_modding_toolkit.catalog._names import cn_words

    armed, battle, bunny, bunny_cn = "\u4e34\u6218", "\u6b66\u88c5", "\u5154\u5973\u90ce", "\u90a6\u59ae"
    rows = [{"skin_kivo": armed, "skin_cn": battle}, {"skin_kivo": f"{bunny},{armed}", "skin_cn": f"{bunny_cn},{battle}"},
            {"skin_kivo": bunny, "skin_cn": "x"}, {"skin_kivo": "a,b", "skin_cn": "c"}, {"skin_kivo": "", "skin_cn": "d"}]
    words = cn_words(rows)
    assert words[armed] == battle and words[bunny] in (bunny_cn, "x")
    assert "a" not in words and "" not in words
    # Kivo's remark words the map never pairs come from the glossary (Track: the server's gym uniform word)
    assert words["\u8fd0\u52a8\u670d"] == "\u4f53\u64cd\u670d"


def test_cn_aliases_put_the_servers_names_in_place():
    from ba_modding_toolkit.catalog._names import cn_aliases, cn_base, cn_name

    momoi, peach = "\u6843\u4e95", "\u6843"
    armed, battle, damaged = "\u4e34\u6218", "\u6b66\u88c5", "\u6218\u635f"
    words = {armed: battle}
    full = f"{momoi}\uff08{armed}\uff0c{damaged}\uff09"
    assert cn_name(full, momoi, peach, words) == f"{peach}\uff08{battle}\uff0c{damaged}\uff09"
    assert cn_name(momoi, momoi, peach, words) == peach
    terror = "\u767d\u5b50\uff0a\u6050\u6016"  # Shiroko*Terror: the base is only the start of the name
    assert cn_name(terror, "\u767d\u5b50", "\u767d\u5b50", words) == terror
    # no server name for the student: the base stays and only the words change
    assert cn_aliases(f"{momoi}\uff08{armed}\uff09", momoi, [], words) == [f"{momoi}\uff08{battle}\uff09"]
    # the variant's own row names all of the head; the server's own name is kept as it is
    assert cn_aliases(terror, "\u767d\u5b50", [], words, heads=[terror], extra=["x"]) == ["x"]
    assert cn_aliases(momoi, momoi, [peach, momoi], words) == [peach]
    assert cn_base({"name_cn": "\u624d\u7fbd \u6843"}) == peach
    assert cn_base({"name_cn": "\u8054\u90a6\u7406\u4e8b\u4f1a\u957f"}) == "\u8054\u90a6\u7406\u4e8b\u4f1a\u957f"
    assert cn_base({"name_cn": "NP0022"}) == cn_base({}) == ""


@pytest.mark.parametrize("case", KIVO["playables"], ids=lambda case: case["student"]["Name"])
def test_generator_names_playables_in_kivo_wording(generator, case):
    assert generator.kivo_name(case["row"], case["student"]) == case["expected"]


def test_shipped_terror_names_use_one_asterisk(shipped: dict):
    names = [(key, lang, text) for key, lang, text in all_names(shipped) if lang != "en"]
    assert not [item for item in names if "*" in item[2]]
    terror = [key for key, entry in shipped["variants"].items() if "\uff0a" in entry["names"]["zh-CN"]["full"]]
    assert {"ch0199", "ch0263", "np0125", "np0186", "np0231", "np0232"} <= set(terror)
    for key in terror:
        assert "*" in shipped["variants"][key]["names"]["en"]["full"], key


def test_shipped_variants_have_distinct_names(shipped: dict):
    for lang in LANGUAGES:
        keys = defaultdict(set)
        for key, entry in shipped["variants"].items():
            keys[entry["names"][lang]["full"]].add(key)
        twins = {frozenset(found) for found in keys.values() if len(found) > 1}
        assert twins == KNOWN_TWINS[lang], lang


def test_twin_words_come_from_the_glossary_and_yield_to_kivo():
    for file_id, twin in TWINS.items():
        assert twin.get("basis"), file_id
        assert all(NAMING["glossary"][part].get(lang) for part in re.split(PART_SEPARATORS, twin["remark"])
                   for lang in ("en", "ja", "zh-TW")), file_id
    assert remark({"file_id": "NP0289"}) == TWINS["np0289"]["remark"]
    assert remark({"file_id": "NP0289", "spine_remark": "Kivo"}) == "Kivo"


@pytest.mark.skipif(not os.environ.get("BAMT_CATALOG_ARGS"), reason="BAMT_CATALOG_ARGS names no build inputs")
def test_generator_reproduces_the_shipped_catalog(generator, tmp_path: Path):
    """Rebuild from the inputs in BAMT_CATALOG_ARGS (--csv, --schaledb, --names, --wiki, --variants)."""
    out = tmp_path / "catalog.json"
    assert generator.main([*shlex.split(os.environ["BAMT_CATALOG_ARGS"]), "--out", str(out)]) == 0
    assert out.read_bytes() == DEFAULT_DATA.read_bytes()
