"""Thai uses the Global client's terms and the UI's Latin separator conventions."""

import json
import re
from pathlib import Path

from ba_modding_toolkit import i18n

LOCALES = Path(i18n.__file__).parent / "locales"


def strings():
    return json.loads((LOCALES / "th-TH.json").read_text(encoding="utf-8"))


def test_thai_is_offered_with_its_native_name():
    assert "th-TH" in i18n.offered_languages(LOCALES)
    assert strings()["webui"]["languageName"] == "ไทย"


def test_thai_uses_the_official_memorial_lobby_term():
    assert strings()["webui"]["tab"]["lobby"] == "ล็อบบี้ความทรงจำ"


def test_thai_uses_half_width_punctuation_without_han_or_kana():
    def leaves(node):
        for value in node.values():
            yield from leaves(value) if isinstance(value, dict) else [value]

    assert [text for text in leaves(strings()) if re.search(
        "[\uff08\uff09\uff0c\u3001\u3002\u300c\u300d\u300e\u300f\u30fb\u00b7\u3040-\u30ff\u3400-\u9fff]", text
    )] == []
