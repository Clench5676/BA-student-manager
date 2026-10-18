"""Shared name formatting for generated data and newer character maps."""

from __future__ import annotations

import json
import re
from pathlib import Path

LANGUAGES = {"zh-CN": "cn", "zh-TW": "tw", "en": "en", "ja": "jp"}
NAMING = json.loads((Path(__file__).parent / "data" / "naming.json").read_text(encoding="utf-8"))
BASE_SHORT: dict[str, str] = NAMING["base_short"]
SEPARATORS: dict[str, str] = NAMING["separators"]


def clean(value: str, lang: str) -> str:
    """Normalize brackets and separators without translating game wording."""
    value = re.sub(r"[\u00b7\u30fb\uff0c\u3001]|,\s*", SEPARATORS[lang], value.strip())
    if lang == "en":
        return re.sub(r"\s*[\uff08(](.*)[\uff09)]$", r" (\1)", value)
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


def csv_names(row: dict[str, str], bases: dict[str, str]) -> tuple[dict, dict]:
    """Use localized CSV skins, then the curated glossary, then raw source text.

    Raw Kivo wording is retained when no approved translation is available. The
    returned fallback map identifies languages that still need official wording.
    """
    names, fallbacks = {}, {}
    raw_skin = row.get("skin_cn") or row.get("skin_kivo", "")
    remark = row.get("spine_remark", "")
    for lang, suffix in LANGUAGES.items():
        parts = []
        for raw, localized in ((raw_skin, row.get(f"skin_{suffix}", "")), (remark, "")):
            if not raw and not localized:
                continue
            if localized:
                parts.append(localized)
                continue
            for part in re.split(r"[,\uff0c\u3001\u00b7\u30fb]", raw):
                if not part:
                    continue
                glossary = NAMING["glossary"]
                term = next((key for key, entry in glossary.items() if entry.get("kivo", key) == part), part)
                translation = term if lang == "zh-CN" else glossary.get(term, {}).get(lang)
                parts.append(translation or part)
                if not translation:
                    fallbacks[lang] = "untranslated_csv_part"
        names[lang] = compose(bases[lang], parts, lang)
        if not row.get(f"name_{suffix}"):
            fallbacks.setdefault(lang, "missing_csv_name")
        if remark or raw_skin:
            fallbacks.setdefault(lang, "story_variant")
    return names, fallbacks


def csv_bases(row: dict[str, str]) -> dict[str, str]:
    """Read given names with the prototype's CN, Kivo, then source-language fallback."""
    fallback = row.get("name_cn") or row.get("name_kivo") or row.get("name_jp") or row.get("file_id", "")
    return {lang: clean(given_name(row.get(f"name_{suffix}") or fallback), lang)
            for lang, suffix in LANGUAGES.items()}
