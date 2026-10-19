"""Every shipped translation against en-US.json: the same keys, the same placeholders, and strings that format with
the values en-US's string takes."""

import json
import re
from pathlib import Path

import pytest

from ba_modding_toolkit import i18n

LOCALES = Path(i18n.__file__).parent / "locales"
PLACEHOLDER = re.compile(r"\{([^{}]*)\}")
# zh-CN predates this check: its mod update summary also names the asset count (the code passes it anyway), and its
# render message leaves out the path
KNOWN_DIFFERENCES = {("zh-CN", "log.mod_update.all_processes_complete"), ("zh-CN", "log.spine.render_file_not_found")}


def flatten(node: dict, prefix: str = "") -> dict[str, str]:
    flat = {}
    for key, value in node.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            flat.update(flatten(value, path))
        else:
            flat[path] = value
    return flat


def strings(code: str) -> dict[str, str]:
    return flatten(json.loads((LOCALES / f"{code}.json").read_text(encoding="utf-8")))


EN = strings("en-US")
TRANSLATIONS = sorted(path.stem for path in LOCALES.glob("*.json") if path.stem != "en-US")


def test_japanese_is_shipped():
    assert "ja-JP" in TRANSLATIONS and "ja-JP" in i18n.offered_languages(LOCALES)


@pytest.mark.parametrize("code", TRANSLATIONS)
def test_same_keys_as_en_us(code):
    flat = strings(code)
    assert sorted(set(EN) - set(flat)) == [], "missing"
    assert sorted(set(flat) - set(EN)) == [], "not in en-US"
    assert all(isinstance(value, str) and value for value in flat.values())


@pytest.mark.parametrize("code", TRANSLATIONS)
def test_same_placeholders_as_en_us(code):
    flat = strings(code)
    differ = {key: (sorted(PLACEHOLDER.findall(EN[key])), sorted(PLACEHOLDER.findall(flat[key])))
              for key in EN.keys() & flat.keys() if (code, key) not in KNOWN_DIFFERENCES
              and sorted(PLACEHOLDER.findall(EN[key])) != sorted(PLACEHOLDER.findall(flat[key]))}
    assert differ == {}


@pytest.mark.parametrize("code", TRANSLATIONS)
def test_strings_format_with_en_us_values(code):
    """No stray brace: each string formats (str.format, as I18n.t does) with the values en-US's string takes."""
    flat = strings(code)
    for key, text in flat.items():
        values = {name: "x" for name in PLACEHOLDER.findall(EN.get(key, "")) + PLACEHOLDER.findall(text)}
        if values:
            text.format(**values)


def test_japanese_uses_no_middle_dot():
    """UI text rules: never the middle dot as a separator, in either width."""
    assert {key for key, text in strings("ja-JP").items() if "·" in text or "・" in text} == set()
