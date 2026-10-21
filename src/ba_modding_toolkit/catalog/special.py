"""Names and stable keys for non-student Spine slots, from shipped metadata only."""

from functools import lru_cache
import json
from pathlib import Path

from ._names import LANGUAGES

SPECIAL_PREFIX = "special:"
LOCALES = {"en": "en-US", "ja": "ja-JP", "ko": "ko-KR", "th": "th-TH", "zh-CN": "zh-CN", "zh-TW": "zh-TW"}
PEOPLE = {"arona": "arona", "plana": "np0035", "aoi": "np0032"}


@lru_cache(maxsize=1)
def words() -> dict[str, dict[str, str]]:
    folder = Path(__file__).parents[1] / "locales"
    return {lang: json.loads((folder / f"{locale}.json").read_text(encoding="utf-8"))["webui"]["special"]
            for lang, locale in LOCALES.items()}


def describe(core: str, entries: dict, students: dict) -> tuple[str, dict, dict]:
    """Use the character map for known people; preserve unknown slot names verbatim."""
    lower = core.lower()
    person = next((name for name in PEOPLE if lower == name or lower.startswith(name + "_")), None)
    prefix = person
    entry = entries.get(PEOPLE[person]) if person else None
    if entry is None:
        matches = [(alias.lower(), entry) for key, entry in entries.items()
                   for alias in [key, *entry.get("core_aliases", [])]
                   if lower == alias.lower() or lower.startswith(alias.lower() + "_")]
        if matches:
            prefix, entry = max(matches, key=lambda item: len(item[0]))
            person = next((name for name, key in PEOPLE.items() if entries.get(key) is entry), None)
    student = students[str(entry["student_id"])] if entry else None
    family = student["base"] if student else PEOPLE[person] if person else "special"
    base = {lang: student["names"][lang] if student else words()[lang][person] if person
            else words()[lang]["title"] for lang in LANGUAGES}
    # Only translate the known role tokens; new event/background names stay searchable by their exact core.
    tail = lower[len(prefix):].lstrip("_") if prefix else lower
    tail = tail or "background"
    tokens = [{"nighttime": "night"}.get(token, token) for token in tail.split("_")]
    labels = {lang: " - ".join(words()[lang][token] for token in tokens) if tokens and all(
        token in words()[lang] for token in tokens) else core for lang in LANGUAGES}
    names = {lang: {"full": f"{base[lang]} - {labels[lang]}", "short": labels[lang]} for lang in LANGUAGES}
    return family, base, names
