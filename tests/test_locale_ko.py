"""The Korean locale file: offered, and written with the Global client's Korean conventions (half-width brackets and
", " as in Hoshino(Swimsuit), Hangul and Latin only)."""

import json
import re
from pathlib import Path

from ba_modding_toolkit import i18n

LOCALES = Path(i18n.__file__).parent / "locales"


def strings() -> dict[str, str]:
    def flatten(node: dict, prefix: str = "") -> dict[str, str]:
        flat = {}
        for key, value in node.items():
            path = f"{prefix}.{key}" if prefix else key
            flat.update(flatten(value, path) if isinstance(value, dict) else {path: value})
        return flat
    return flatten(json.loads((LOCALES / "ko-KR.json").read_text(encoding="utf-8")))


def test_korean_is_offered():
    assert "ko-KR" in i18n.offered_languages(LOCALES)
    assert strings()["webui.languageName"] == "\ud55c\uad6d\uc5b4"  # Korean, in Korean


def test_korean_uses_half_width_punctuation():
    """No CJK full-width brackets, commas or full stops, and never a middle dot (UI text rules)."""
    assert {key: text for key, text in strings().items() if re.search("[\uff08\uff09\uff0c\u3001\u3002\u300c\u300d\u300e\u300f\u30fb\u00b7]", text)} == {}


def test_korean_has_no_han_or_kana():
    assert {key: text for key, text in strings().items() if re.search("[\u3040-\u30ff\u3400-\u9fff]", text)} == {}
