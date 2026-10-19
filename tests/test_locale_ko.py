"""The Korean locale file: offered, and written with the Global client's Korean conventions (half-width brackets and
", " as in 호시노(수영복), Hangul and Latin only)."""

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
    assert strings()["webui.languageName"] == "한국어"


def test_korean_uses_half_width_punctuation():
    """No CJK full-width brackets, commas or full stops, and never a middle dot (UI text rules)."""
    assert {key: text for key, text in strings().items() if re.search(r"[（），、。「」『』・·]", text)} == {}


def test_korean_has_no_han_or_kana():
    assert {key: text for key, text in strings().items() if re.search(r"[぀-ヿ㐀-鿿]", text)} == {}
