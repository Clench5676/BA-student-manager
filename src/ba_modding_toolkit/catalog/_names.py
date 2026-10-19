"""Shared name formatting for generated data and newer character maps.

Simplified Chinese follows Kivo's community wording: zh-CN names and skins come from the
character map's Kivo columns (name_kivo, skin_kivo), and the CN server's (name_cn, skin_cn)
only fill in where Kivo has none. The other languages use their own columns.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

LANGUAGES = {"zh-CN": "cn", "zh-TW": "tw", "en": "en", "ja": "jp"}
NAMING = json.loads((Path(__file__).parent / "data" / "naming.json").read_text(encoding="utf-8"))
BASE_SHORT: dict[str, str] = NAMING["base_short"]
SEPARATORS: dict[str, str] = NAMING["separators"]
# Curated base names keyed by the zh-CN base the character map yields; each lists only the
# languages the map lacks or gets wrong, plus whether that wording is official or translated.
NAMES: dict[str, dict[str, str]] = NAMING["names"]
# Variant words for sprites whose Kivo remark would leave them named like another sprite,
# keyed by file id; Kivo's own remark wins once it has one.
TWINS: dict[str, dict[str, str]] = NAMING["twins"]
PART_SEPARATORS = r"[,\uff0c\u3001\u00b7\u30fb]"
FILE_ID = re.compile(r"_|spr$|^(?:np|ch)\d+$", re.IGNORECASE)


def column(row: dict[str, str], field: str, lang: str) -> str:
    """Return a character map name or skin in one language; zh-CN prefers Kivo's wording."""
    if lang == "zh-CN":
        return row.get(f"{field}_kivo") or row.get(f"{field}_cn", "")
    return row.get(f"{field}_{LANGUAGES[lang]}", "")


def clean(value: str, lang: str) -> str:
    """Normalize brackets, separators and the Terror asterisk without translating game wording.

    Every language but English writes the Terror asterisk full width (U+FF0A).
    """
    value = re.sub(r"[\u00b7\u30fb\uff0c\u3001]|,\s*", SEPARATORS[lang], value.strip())
    if lang == "en":
        return re.sub(r"\s*[\uff08(](.*)[\uff09)]$", r" (\1)", value)
    value = value.replace("*", "\uff0a")
    return re.sub(r"\s*[\uff08(](.*)[\uff09)]$", "\uff08" + r"\1" + "\uff09", value)


def given_name(value: str) -> str:
    """Extract the given name from a character map's surname-first name."""
    return value.strip().rsplit(maxsplit=1)[-1] if value.strip() else ""


def short_name(full: str, lang: str) -> str:
    """Return the variant part, including the official Terror suffix convention."""
    match = re.search(r"[\uff08(](.*)[\uff09)]$|[\uff0a*](.+)$", full)
    return next(part for part in match.groups() if part is not None) if match else BASE_SHORT[lang]


def compose(base: str, parts: list[str], lang: str) -> dict[str, str]:
    """Compose a full display name and its variant chip label."""
    inner = SEPARATORS[lang].join(dict.fromkeys(clean(part, lang) for part in parts if part))
    full = f"{base} ({inner})" if lang == "en" else f"{base}\uff08{inner}\uff09"
    return {"full": full if inner else base, "short": inner or BASE_SHORT[lang]}


def usable(value: str) -> bool:
    """Whether a character map name is real text rather than empty or a file id."""
    return bool(value.strip()) and not FILE_ID.search(value.strip())


def remark(row: dict[str, str]) -> str:
    """Return the row's Kivo remark, or the curated word that tells a twin sprite apart."""
    return row.get("spine_remark") or TWINS.get(row.get("file_id", "").lower(), {}).get("remark", "")


def _parts(row: dict[str, str], lang: str) -> list[tuple[str, dict | str | None]]:
    """Return the variant words of a row with their origin.

    The origin is "csv" for a localized character map skin, the glossary entry that
    supplied the word, or None when the raw Kivo text had to be kept. Glossary keys are
    Kivo's words, so zh-CN keeps the raw Kivo text. A zh-TW skin that only repeats the
    Kivo text counts as missing when the glossary writes it otherwise.
    """
    raw_skin = row.get("skin_kivo") or row.get("skin_cn", "")
    glossary = NAMING["glossary"]
    parts = []
    for raw, localized in ((raw_skin, column(row, "skin", lang)), (remark(row), "")):
        if not raw and not localized:
            continue
        if localized and not (lang == "zh-TW" and localized == raw
                              and glossary.get(raw, {}).get(lang, localized) != localized):
            parts.append((localized, "csv"))
            continue
        for part in re.split(PART_SEPARATORS, raw):
            if not part:
                continue
            translation = part if lang == "zh-CN" else glossary.get(part, {}).get(lang)
            parts.append((translation or part, glossary.get(part) if translation else None))
    return parts


def csv_names(row: dict[str, str], bases: dict[str, str]) -> tuple[dict, dict]:
    """Use localized CSV skins, then the curated glossary, then raw source text.

    Raw Kivo wording is retained when no approved translation is available. The
    returned fallback map identifies languages that still need official wording.
    """
    names, fallbacks = {}, {}
    story = bool(row.get("skin_cn") or row.get("skin_kivo") or remark(row))
    for lang in LANGUAGES:
        parts = _parts(row, lang)
        if any(origin is None for _, origin in parts):
            fallbacks[lang] = "untranslated_csv_part"
        names[lang] = compose(bases[lang], [word for word, _ in parts], lang)
        if not usable(column(row, "name", lang)):
            fallbacks.setdefault(lang, "missing_csv_name")
        if story:
            fallbacks.setdefault(lang, "story_variant")
    return names, fallbacks


def _origin(origin: dict | str | None, lang: str) -> str:
    """Classify one variant word as official, translated or fallback wording."""
    if origin is None:
        return "fallback"
    if origin == "csv":
        return "official"
    source = origin.get("source", "translated")
    if lang == "zh-CN" and source != "official":
        return "fallback"  # the zh-CN word is the Kivo description itself
    return source


def csv_sources(row: dict[str, str], bases: dict[str, str], fallbacks: dict[str, str]) -> dict[str, str]:
    """Label where each language's name of a character map row comes from.

    Names built with the curated name table or with a glossary entry that states its
    source are "official" when every word is the game's own (character map skins,
    official glossary words, official table names), "translated" when any word is a
    curated translation and "fallback" while raw text remains. Other names keep the
    generic labels: "derived" without a fallback, else "fallback" (this includes names
    that only use the older glossary entries, which state no source).
    """
    entry = name_entry(row)
    sources = {}
    for lang in LANGUAGES:
        parts = _parts(row, lang)
        tabled = lang in entry and bases[lang] == clean(entry[lang], lang)
        if not tabled and not any(isinstance(origin, dict) and "source" in origin for _, origin in parts):
            sources[lang] = "fallback" if lang in fallbacks else "derived"
            continue
        origins = {entry["source"] if tabled else "official" if usable(column(row, "name", lang)) else "fallback"}
        origins.update(_origin(origin, lang) for _, origin in parts)
        sources[lang] = next(label for label in ("fallback", "translated", "official") if label in origins)
    return sources


def has_surname(row: dict[str, str]) -> bool:
    """Whether the row's Kivo name is a surname-first personal name (assumed without one)."""
    name = (row.get("name_kivo") or row.get("name_cn") or row.get("name_jp") or "").strip()
    return " " in name or not name


def name_entry(row: dict[str, str]) -> dict[str, str]:
    """Return the curated name table entry for a row's zh-CN base name, if any."""
    cn = column(row, "name", "zh-CN")
    return NAMES.get(clean(given_name(cn) if has_surname(row) else cn, "zh-CN"), {})


def csv_bases(row: dict[str, str]) -> dict[str, str]:
    """Read given names in each language, falling back to Kivo, CN, then Japanese text.

    zh-CN is Kivo's given name (its given_name field, the part after the space). Only
    surname-first names are cut to the given name, so titles such as "Professor Smug"
    stay whole. Empty names and file ids fall back, and the curated name table replaces
    the languages it lists.
    """
    fallback = row.get("name_kivo") or row.get("name_cn") or row.get("name_jp") or row.get("file_id", "")
    split = given_name if has_surname(row) else str.strip
    entry = name_entry(row)
    bases = {}
    for lang in LANGUAGES:
        value = column(row, "name", lang)
        bases[lang] = clean(entry.get(lang) or split(value if usable(value) else fallback), lang)
    return bases
