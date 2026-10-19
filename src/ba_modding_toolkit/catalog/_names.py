"""Shared name formatting for generated data and newer character maps.

Simplified Chinese follows Kivo's community wording: zh-CN names and skins come from the
character map's Kivo columns (name_kivo, skin_kivo), and the CN server's (name_cn, skin_cn)
only fill in where Kivo has none. The other languages use their own columns. The CN server's
names stay findable: they are the aliases the roster search matches (cn_words, cn_base,
cn_name).
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable
import json
import re
from pathlib import Path

# name language -> the character map column suffix (name_kr, skin_kr) and SchaleDB table (students.kr.json)
LANGUAGES = {"zh-CN": "cn", "zh-TW": "tw", "en": "en", "ja": "jp", "ko": "kr"}
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

    Chinese and Japanese write the Terror asterisk full width (U+FF0A) and full-width brackets; English and Korean
    keep the half-width ones, Korean without a space before the bracket, as the game writes them (Azusa(Swimsuit),
    Shiroko*Terror in Hangul). A Korean middle dot joins the words of one name (Kanryou and Tsukumogami): a space takes
    its place.
    """
    if lang == "ko":
        value = re.sub(r"\s*[\u00b7\u30fb]\s*", " ", value)
        value = re.sub(r"\s*[\uff0c\u3001]\s*|\s*,\s*", SEPARATORS[lang], value.strip())
    value = re.sub(r"[\u00b7\u30fb\uff0c\u3001]|,\s*", SEPARATORS[lang], value.strip())
    if lang == "en":
        return re.sub(r"\s*[\uff08(](.*)[\uff09)]$", r" (\1)", value)
    if lang == "ko":
        return re.sub(r"\s*[\uff08(](.*)[\uff09)]$", r"(\1)", value.replace("\uff0a", "*"))
    value = value.replace("*", "\uff0a")
    return re.sub(r"\s*[\uff08(](.*)[\uff09)]$", "\uff08" + r"\1" + "\uff09", value)


def given_name(value: str) -> str:
    """Extract the given name from a character map's surname-first name."""
    return value.strip().rsplit(maxsplit=1)[-1] if value.strip() else ""


def bracketed(base: str, inner: str, lang: str) -> str:
    """A base name with its variant words in the language's brackets: Hoshino (Swimsuit) in English, half-width
    brackets with no space in Korean, full-width brackets in Chinese and Japanese."""
    if lang == "en":
        return f"{base} ({inner})"
    if lang == "ko":
        return f"{base}({inner})"
    return f"{base}\uff08{inner}\uff09"


def short_name(full: str, lang: str) -> str:
    """Return the variant part, including the official Terror suffix convention."""
    match = re.search(r"[\uff08(](.*)[\uff09)]$|[\uff0a*](.+)$", full)
    return next(part for part in match.groups() if part is not None) if match else BASE_SHORT[lang]


def compose(base: str, parts: list[str], lang: str) -> dict[str, str]:
    """Compose a full display name and its variant chip label."""
    inner = SEPARATORS[lang].join(dict.fromkeys(clean(part, lang) for part in parts if part))
    full = bracketed(base, inner, lang)
    return {"full": full if inner else base, "short": inner or BASE_SHORT[lang]}


def usable(value: str) -> bool:
    """Whether a character map name is real text rather than empty or a file id."""
    return bool(value.strip()) and not FILE_ID.search(value.strip())


def remark(row: dict[str, str]) -> str:
    """Return the row's Kivo remark, or the curated word that tells a twin sprite apart."""
    return row.get("spine_remark") or TWINS.get(row.get("file_id", "").lower(), {}).get("remark", "")


def _glossary_wins(raw: str, localized: str, lang: str) -> bool:
    """Whether the glossary's word for a Kivo skin replaces the character map's own: a zh-TW skin that only repeats
    the Kivo text, and a ko skin the game words otherwise (the map's words for Battle Ready, New Year and Camp give way
    to the game's own)."""
    word = NAMING["glossary"].get(raw, {}).get(lang)
    if word is None or word == localized:
        return False
    return lang == "ko" or (lang == "zh-TW" and localized == raw)


def _parts(row: dict[str, str], lang: str) -> list[tuple[str, dict | str | None]]:
    """Return the variant words of a row with their origin.

    The origin is "csv" for a localized character map skin, the glossary entry that
    supplied the word, or None when the raw Kivo text had to be kept. Glossary keys are
    Kivo's words, so zh-CN keeps the raw Kivo text. A zh-TW skin that only repeats the
    Kivo text, and a ko skin the glossary words otherwise, count as missing (_glossary_wins).
    """
    raw_skin = row.get("skin_kivo") or row.get("skin_cn", "")
    glossary = NAMING["glossary"]
    parts = []
    for raw, localized in ((raw_skin, column(row, "skin", lang)), (remark(row), "")):
        if not raw and not localized:
            continue
        if localized and not _glossary_wins(raw, localized, lang):
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


# --- aliases: the CN server's wording, which the roster search matches although zh-CN shows Kivo's ---

def cn_words(rows: Iterable[dict[str, str]]) -> dict[str, str]:
    """Map each Kivo costume word to the CN server's word where they differ.

    Read from the character map rows whose skin_kivo and skin_cn differ, part by part when
    both have as many parts (the pairing most rows make wins, then the first by code point),
    then the glossary's ``cn`` entries for the words only Kivo's remarks use.
    """
    pairs: dict[str, Counter] = defaultdict(Counter)
    for row in rows:
        kivo = [part for part in re.split(PART_SEPARATORS, row.get("skin_kivo", "")) if part]
        server = [part for part in re.split(PART_SEPARATORS, row.get("skin_cn", "")) if part]
        if len(kivo) == len(server):
            for word, cn in zip(kivo, server):
                if word != cn:
                    pairs[word][cn] += 1
    words = {word: min(found.items(), key=lambda item: (-item[1], item[0]))[0] for word, found in pairs.items()}
    words.update({word: entry["cn"] for word, entry in NAMING["glossary"].items() if entry.get("cn")})
    return dict(sorted(words.items()))


def cn_base(row: dict[str, str]) -> str:
    """Return the CN server's name of a character map row (name_cn; a surname-first name's given name), or ''."""
    name = row.get("name_cn", "").strip()
    if not usable(name):
        return ""
    return clean(given_name(name) if " " in name else name, "zh-CN")


def name_head(full: str) -> str:
    """Return a zh-CN full name without its bracketed variant words."""
    match = re.fullmatch(r"(.*?)\uff08(.*)\uff09", full)
    return match.group(1) if match else full


def cn_name(full: str, base: str, server_base: str, words: dict[str, str]) -> str:
    """Return a zh-CN full name in the CN server's wording.

    The base name it starts with becomes ``server_base`` and each variant word in its
    brackets the server's word (``words``, from cn_words); the rest is kept.
    """
    match = re.fullmatch(r"(.*?)\uff08(.*)\uff09", full)
    head, inner = match.groups() if match else (full, "")
    if head.startswith(base):
        head = server_base + head[len(base):]
    parts = [words.get(part, part) for part in inner.split(SEPARATORS["zh-CN"])] if inner else []
    return compose(head, parts, "zh-CN")["full"]


def cn_aliases(full: str, base: str, server_bases: Iterable[str], words: dict[str, str],
               heads: Iterable[str] = (), extra: Iterable[str] = ()) -> list[str]:
    """Return a variant's aliases, its zh-CN name in the CN server's wording, without the shown name.

    ``server_bases`` are the server's names of the student (the base when it has none), each
    put in place of the base the name starts with; ``heads`` are the server's names of this
    variant's character, put in place of all the name before its brackets; ``extra`` names
    are the server's own and kept as they are. The variant words become the server's words.
    """
    found = {cn_name(full, base, server_base, words) for server_base in (set(server_bases) or {base})}
    head = name_head(full)
    found.update(cn_name(full, head, name, words) for name in heads if name)
    found.update(name for name in extra if name)
    return sorted(found - {full})
