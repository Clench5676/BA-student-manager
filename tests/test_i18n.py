"""The UI languages: which are offered, which one a system language picks, and what stands in for a missing string
(Python side, web UI RPC and the front end's name language)."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from ba_modding_toolkit import i18n
from ba_modding_toolkit.i18n import (
    UI_LANGUAGES, I18n, fallback_language, is_traditional_chinese, match_language, offered_languages,
)
from ba_modding_toolkit.webui import api as webui_api

NODE = shutil.which("node")
JS_TESTS = Path(__file__).parent / "js" / "i18n.test.mjs"
SHIPPED = Path(i18n.__file__).parent / "locales"


def test_ui_languages_in_order():
    assert UI_LANGUAGES == ("zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "th-TH")


@pytest.mark.parametrize("tag, expected", [
    ("zh-TW", True), ("zh_TW", True), ("zh-Hant", True), ("zh-Hant-HK", True), ("zh-HK", True), ("zh_MO", True),
    ("zh-CN", False), ("zh-Hans-CN", False), ("zh-SG", False), ("zh", False), ("ja-JP", False), ("zh-tw-x", True),
])
def test_traditional_chinese_tags(tag, expected):
    assert is_traditional_chinese(tag) is expected


@pytest.mark.parametrize("lang, expected", [
    ("zh-CN", "zh-CN"), ("zh-SG", "zh-CN"), ("zh-Hans-CN", "zh-CN"), ("zh", "zh-CN"),
    # a Traditional Chinese screen takes English, not Simplified Chinese, for a string it lacks
    ("zh-TW", "en-US"), ("zh-Hant-HK", "en-US"),
    ("ja-JP", "en-US"), ("ko-KR", "en-US"), ("th-TH", "en-US"), ("en-US", "en-US"), ("debug", "en-US"),
])
def test_fallback_language(lang, expected):
    assert fallback_language(lang) == expected


ALL = list(UI_LANGUAGES)
TODAY = ["zh-CN", "en-US"]


@pytest.mark.parametrize("system, available, expected", [
    ("zh-Hans-CN", ALL, "zh-CN"), ("zh_CN", ALL, "zh-CN"), ("zh-SG", ALL, "zh-CN"),
    ("zh-Hant-TW", ALL, "zh-TW"), ("zh_TW", ALL, "zh-TW"), ("zh-Hant-HK", ALL, "zh-TW"), ("zh-MO", ALL, "zh-TW"),
    ("ja_JP", ALL, "ja-JP"), ("ja", ALL, "ja-JP"), ("ko-KR", ALL, "ko-KR"), ("ko", ALL, "ko-KR"),
    ("th_TH", ALL, "th-TH"), ("th-TH", ALL, "th-TH"), ("th", ALL, "th-TH"), ("TH-th", ALL, "th-TH"),
    ("th-Thai-TH", ALL, "th-TH"),
    ("en-GB", ALL, "en-US"), ("fr-FR", ALL, "en-US"), (None, ALL, "en-US"), ("", ALL, "en-US"),
    # a language whose locale file does not exist yet: the whole zh-CN screen for Traditional Chinese, else English
    ("zh-Hant-TW", TODAY, "zh-CN"), ("ja-JP", TODAY, "en-US"), ("ko-KR", TODAY, "en-US"),
    ("th-TH", TODAY, "en-US"),
    ("zh-Hans-CN", ["en-US", "zh-TW"], "en-US"),
])
def test_system_language_picks_an_available_ui_language(system, available, expected):
    assert match_language(system, available) == expected


@pytest.mark.parametrize("code", ["ko-KR", "th-TH"])
def test_default_language_follows_the_system_and_the_locale_files(monkeypatch, tmp_path, code):
    monkeypatch.delenv("BAMT_LANG", raising=False)
    monkeypatch.setattr(i18n, "get_locale_dir", lambda: tmp_path)
    for existing in TODAY:
        (tmp_path / f"{existing}.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(i18n, "get_system_language", lambda: code)
    assert i18n.get_default_language() == "en-US"
    (tmp_path / f"{code}.json").write_text("{}", encoding="utf-8")
    assert i18n.get_default_language() == code
    monkeypatch.setenv("BAMT_LANG", "zh-CN")
    assert i18n.get_default_language() == "zh-CN"


def test_offered_languages_are_the_known_ones_with_a_locale_file(tmp_path):
    assert offered_languages(tmp_path) == []
    for code in ("th-TH", "ko-KR", "en-US", "fr-FR", "zh-CN"):
        (tmp_path / f"{code}.json").write_text("{}", encoding="utf-8")
    assert offered_languages(tmp_path) == ["zh-CN", "en-US", "ko-KR", "th-TH"]  # UI_LANGUAGES order
    assert offered_languages(SHIPPED)[:1] == ["zh-CN"] and "en-US" in offered_languages(SHIPPED)


def write_locale(folder: Path, code: str, data: dict) -> None:
    (folder / f"{code}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_strings_fall_back_key_by_key(tmp_path):
    write_locale(tmp_path, "zh-CN", {"a": "简", "b": "简b"})
    write_locale(tmp_path, "en-US", {"a": "en", "b": "en b"})
    write_locale(tmp_path, "zh-TW", {"a": "繁"})
    assert I18n("zh-TW", str(tmp_path)).t("a") == "繁"
    assert I18n("zh-TW", str(tmp_path)).t("b") == "en b"  # English, never Simplified Chinese
    assert I18n("zh-SG", str(tmp_path)).t("b") == "简b"
    assert I18n("ko-KR", str(tmp_path)).t("a") == "en"  # no ko-KR file yet: all English
    assert I18n("ja-JP", str(tmp_path)).t("missing") == "missing"


def test_web_ui_strings_of_a_new_language(monkeypatch, tmp_path):
    write_locale(tmp_path, "zh-CN", {"webui": {"languageName": "简体中文", "x": "简"}})
    write_locale(tmp_path, "en-US", {"webui": {"languageName": "English", "x": "en"}})
    write_locale(tmp_path, "ko-KR", {"webui": {"languageName": "한국어"}})
    monkeypatch.setattr(webui_api, "get_locale_dir", lambda: tmp_path)
    assert webui_api.ui_strings("ko-KR") == {"webui.languageName": "한국어", "webui.x": "en"}


def test_web_ui_strings_can_check_a_locale_without_fallback(tmp_path):
    from ba_modding_toolkit.webui.strings import ui_strings

    write_locale(tmp_path, "en-US", {"webui": {"shared": "English fallback"}})
    write_locale(tmp_path, "ko-KR", {"webui": {"own": "Locale value", "invalid": 42}})
    assert ui_strings("ko-KR", tmp_path) == {"webui.shared": "English fallback", "webui.own": "Locale value"}
    assert ui_strings("ko-KR", tmp_path, fallback=False) == {"webui.own": "Locale value"}
    assert ui_strings("th-TH", tmp_path, fallback=False) == {}


def test_thai_strings_selection_and_classic_language_list(tmp_path):
    write_locale(tmp_path, "en-US", {"name": "English", "missing": "English fallback"})
    write_locale(tmp_path, "th-TH", {"name": "ไทย"})
    manager = I18n("en-US", str(tmp_path))
    assert "th-TH" in manager.get_available_languages()
    manager.set_language("th-TH")
    assert manager.lang == "th-TH"
    assert manager.t("name") == "ไทย"
    assert manager.t("missing") == "English fallback"


def test_thai_system_locale_detection(monkeypatch):
    monkeypatch.setattr(i18n.locale, "getdefaultlocale", lambda: ("th_TH", "UTF-8"))
    assert i18n.get_system_language() == "th-TH"


def test_lines_language_of_each_ui_language():
    assert webui_api.LINE_LANGS == {"zh-CN": "zh-CN", "zh-TW": "zh-TW", "en-US": "en", "ja-JP": "ja", "ko-KR": "ko", "th-TH": "th"}
    assert set(webui_api.LINE_LANGS) == set(UI_LANGUAGES)


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_name_language_in_node():
    """The front end's names follow the UI language (web/js/i18n.js NAME_LANG, L)."""
    result = subprocess.run([NODE, "--test", str(JS_TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
