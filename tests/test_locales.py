"""Every shipped locale file against en-US.json: the same keys in the same structure and the same placeholders, so no
string falls back to English by accident and no translation asks for an argument the code does not pass."""

import json
import string
from pathlib import Path

import pytest

from ba_modding_toolkit import i18n

LOCALES = Path(i18n.__file__).parent / "locales"
REFERENCE = "en-US"
TRANSLATIONS = sorted(p.stem for p in LOCALES.glob("*.json") if p.stem != REFERENCE)

# Placeholder differences that predate this test, each checked against its caller: the zh-CN string leaves out
# {path}, which the caller passes (extra arguments are ignored), and asks for {count}, which the caller passes too.
KNOWN_PLACEHOLDER_DIFFERENCES = {
    ("zh-CN", "log.spine.render_file_not_found"),
    ("zh-CN", "log.mod_update.all_processes_complete"),
}


def load(code: str) -> dict:
    return json.loads((LOCALES / f"{code}.json").read_text(encoding="utf-8"))


def flatten(tree: dict, prefix: str = "") -> dict[str, object]:
    out = {}
    for key, value in tree.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, path))
        else:
            out[path] = value
    return out


def placeholders(text: str) -> list[str]:
    return sorted(name for _, name, _, _ in string.Formatter().parse(text) if name is not None)


def test_there_are_translations():
    assert "zh-CN" in TRANSLATIONS


@pytest.mark.parametrize("code", TRANSLATIONS)
def test_same_keys_as_en_us(code):
    reference, translation = flatten(load(REFERENCE)), flatten(load(code))
    assert sorted(set(reference) - set(translation)) == [], "missing"
    assert sorted(set(translation) - set(reference)) == [], "not in en-US"


@pytest.mark.parametrize("code", TRANSLATIONS)
def test_every_string_is_text(code):
    for key, value in flatten(load(code)).items():
        assert isinstance(value, str) and value.strip(), key


@pytest.mark.parametrize("code", TRANSLATIONS)
def test_same_placeholders_as_en_us(code):
    reference, translation = flatten(load(REFERENCE)), flatten(load(code))
    wrong = {key: (placeholders(reference[key]), placeholders(text)) for key, text in translation.items()
             if key in reference and placeholders(text) != placeholders(reference[key])
             and (code, key) not in KNOWN_PLACEHOLDER_DIFFERENCES}
    assert wrong == {}


@pytest.mark.parametrize("code", [REFERENCE, *TRANSLATIONS])
def test_no_middle_dot_separators(code):
    """UI text rules: never · or ・."""
    assert [key for key, text in flatten(load(code)).items() if "·" in text or "・" in text] == []


@pytest.mark.parametrize("code", [REFERENCE, *TRANSLATIONS])
def test_language_names_itself(code):
    name = load(code)["webui"]["languageName"]
    assert name and (code == REFERENCE or name != load(REFERENCE)["webui"]["languageName"])
