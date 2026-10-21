# i18n.py
import json
import locale
import sys
from collections.abc import Iterable
from functools import reduce, lru_cache
from pathlib import Path
from typing import Any

def get_locale_dir() -> Path:
    """
    获取 locales 目录路径
    优先级：
    1. 打包环境：exe 同级目录下的 locales 文件夹
    2. 开发环境：包内部的 locales 文件夹
    """
    # 1. 优先查找 exe 同级目录下的 locales 文件夹（打包环境下 EXE_DIR 为 exe 所在目录）
    from .utils import EXE_DIR
    external_locales = EXE_DIR / "locales"
    if external_locales.is_dir():
        return external_locales

    # 2. 开发环境，或打包环境未提供外部 locales
    # 查找代码包内部的 locales 文件夹
    internal_locales = Path(__file__).parent / "locales"
    return internal_locales

def get_system_language() -> str | None:
    """
    获取标准化后的系统语言代码 (如: zh-CN, en-US)
    如果无法检测，默认返回 en-US
    """
    try:
        # 获取系统默认 locale，例如 ('zh_CN', 'UTF-8')
        loc = locale.getdefaultlocale()[0]
        # None without LANG, or "C" after Python's C locale coercion (LC_CTYPE=C.UTF-8)
        if sys.platform == "darwin" and loc in (None, "C", "POSIX"):
            loc = _get_macos_language()
        return loc.replace("_", "-")
    except Exception:
        print("Error: Failed to detect system language.")
        return None

def _get_macos_language() -> str | None:
    """Return the preferred macOS UI language (e.g. zh-Hans-CN).

    Apps launched from Finder get no LANG etc., so locale cannot detect the language.
    """
    import subprocess
    result = subprocess.run(["defaults", "read", "-g", "AppleLanguages"], capture_output=True, text=True)
    # Output looks like: ( "zh-Hans-CN", en )
    languages = [item.strip().strip('"') for item in result.stdout.strip().strip("()").split(",")]
    return next((lang for lang in languages if lang), None)

# The UI languages the app knows, in the order the language choices list them. A
# language is offered once its locale file exists.
UI_LANGUAGES = ("zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "th-TH")
DEFAULT_LANGUAGE = "en-US"
# Chinese written in Traditional characters: the script subtag, else the regions that write it
_TRADITIONAL = ("zh-hant", "zh-tw", "zh-hk", "zh-mo")


def is_traditional_chinese(lang: str) -> bool:
    """Whether a language tag is Chinese in Traditional characters (zh-TW, zh-Hant-HK, zh_MO, ...)."""
    tag = lang.replace("_", "-").lower()
    return any(tag == t or tag.startswith(t + "-") for t in _TRADITIONAL)


def fallback_language(lang: str) -> str:
    """The language whose strings stand in, key by key, for the ones a locale file lacks.

    Simplified Chinese falls back to zh-CN; every other language, Traditional Chinese included, to en-US. A
    Traditional Chinese screen with a few Simplified strings (in Kivo's wording, too) reads as a wrong translation,
    an English string reads as an untranslated one and stands out to the translator; CLDR, likewise, gives zh-Hant
    the root locale as its parent, not zh.
    """
    tag = lang.replace("_", "-").lower()
    if (tag == "zh" or tag.startswith("zh-")) and not is_traditional_chinese(tag):
        return "zh-CN"
    return DEFAULT_LANGUAGE


def match_language(system_lang: str | None, available: Iterable[str]) -> str:
    """The UI language for a system language tag (zh-Hans-CN, zh_TW, ja-JP, ko, ...), among the available ones.

    Traditional Chinese (zh-Hant, zh-TW, zh-HK, zh-MO) takes zh-TW, else the whole zh-CN screen, which reads better
    than an English one (a whole screen, unlike a string here and there, is consistent in itself); other Chinese
    takes zh-CN, Japanese ja-JP, Korean ko-KR, Thai th-TH; anything else, and a language whose locale file does not
    exist yet, en-US.
    """
    available = set(available)
    tag = (system_lang or "").replace("_", "-").lower()
    primary = tag.split("-")[0]
    if primary == "zh":
        wanted = ["zh-TW", "zh-CN"] if is_traditional_chinese(tag) else ["zh-CN"]
    else:
        wanted = [code for code in UI_LANGUAGES if code.split("-")[0].lower() == primary]
    return next((code for code in wanted if code in available), DEFAULT_LANGUAGE)


def offered_languages(locales_dir: Path | None = None) -> list[str]:
    """The UI languages to offer, in UI_LANGUAGES order: those whose locale file exists."""
    folder = locales_dir or get_locale_dir()
    return [code for code in UI_LANGUAGES if (folder / f"{code}.json").is_file()]


def get_default_language() -> str:
    """
    根据系统语言获取默认语言设置
    优先级：BAMT_LANG 环境变量 > 系统语言检测
    """
    # 优先检查环境变量
    import os
    env_lang = os.environ.get("BAMT_LANG")
    if env_lang:
        return env_lang

    system_lang = get_system_language()
    # 如果系统语言是中文，使用zh-CN，否则使用en-US
    # The system language picks among the UI languages whose locale file exists (match_language)
    return match_language(system_lang, offered_languages())

class I18n:
    def __init__(self, lang: str | None = None, locales_dir: str | None = None):
        self.fallback_lang = DEFAULT_LANGUAGE
        self.lang = lang or get_default_language()
        self.locales_dir = Path(locales_dir) if locales_dir else get_locale_dir()
        self.translations: dict[str, Any] = {}
        self.fallback_translations: dict[str, Any] = {}
        
        self.load_translations()

    def load_translations(self) -> None:
        """
        加载翻译文件
        支持 Debug 模式和 key 级别回退：
        - zh-* 语言：回退到 zh-CN → key
        - 其他语言：回退到 en-US → key
        Traditional Chinese (zh-TW, zh-Hant-*) falls back to en-US, not zh-CN: see fallback_language.
        """
        # print(f"Loading locales from: {self.locales_dir}")
        
        if self.lang == "debug":
            self.translations = {}
            self.fallback_translations = {}
            self._get_template.cache_clear()
            print("I18n: Debug mode enabled.")
            return

        fallback_code = fallback_language(self.lang)

        main_path = self.locales_dir / f"{self.lang}.json"
        fallback_path = self.locales_dir / f"{fallback_code}.json"

        main_exists = main_path.exists()
        fallback_exists = fallback_path.exists()

        if main_exists:
            # print(f"I18n: Loaded language '{self.lang}'.")
            pass
        elif fallback_exists:
            print(f"I18n: Language '{self.lang}' not found, using fallback '{fallback_code}'.")
        else:
            print(f"I18n Warning: Language '{self.lang}' not found, fallback '{fallback_code}' not found either.")

        self.translations = self._load_translation_file(main_path)
        self.fallback_translations = self._load_translation_file(fallback_path)

        if not self.translations and not self.fallback_translations:
            print(f"Warning: No translation files found for '{self.lang}' or '{fallback_code}'.")

        self._get_template.cache_clear()

    def _load_translation_file(self, path: Path) -> dict[str, Any]:
        """加载单个翻译文件"""
        if not path.exists():
            return {}
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"Warning: Failed to load translations from {path}: {e}")
            return {}

    @lru_cache(maxsize=1024)
    def _get_template(self, key: str) -> str:
        """
        内部方法：查找翻译，支持 key 级别回退
        """
        keys = key.split(".")

        # 在主语言中查找
        main_value = self._get_nested_value(self.translations, keys)
        if main_value is not None:
            return str(main_value)

        # 主语言没有这个 key，去回退语言查找
        fallback_value = self._get_nested_value(self.fallback_translations, keys)
        if fallback_value is not None:
            return str(fallback_value)

        # 都找不到，返回 key 本身
        return key

    def _get_nested_value(self, data: dict[str, Any], keys: list[str]) -> Any:
        """从嵌套字典中获取值"""
        try:
            return reduce(lambda d, k: d[k], keys, data)
        except (KeyError, TypeError):
            return None

    def t(self, _key: str, **kwargs: Any) -> str:
        """
        获取翻译文本，支持参数替换
        用法: t("log.success", msg="更新成功")
        对应的 JSON: { "log": { "success": "成功: {msg}" } }
        """
        template = self._get_template(_key)
        
        # 如果没有传参数，直接返回
        if not kwargs:
            return template
        
        # Debug 模式或键缺失时，返回键名和参数
        if self.lang == "debug" or template == _key:
            return f"{_key}({', '.join(f'{k}={v}' for k, v in kwargs.items())})"
            
        try:
            # 使用 python 标准的 format 方法进行替换
            return template.format(**kwargs)
        except KeyError as e:
            # 如果 JSON 里写了 {name} 但代码没传 name 参数，避免崩溃，返回原始模板或报错信息
            print(f"Warning: Missing format argument {e} for key '{_key}'")
            return template
        except Exception as e:
            print(f"Warning: Formatting error for key '{_key}': {e}")
            return template

    def set_language(self, lang: str) -> None:
        """切换语言并重新加载"""
        if self.lang != lang:
            self.lang = lang
            self.load_translations()

    def get_available_languages(self) -> list[str]:
        """获取可用的语言列表"""
        languages = []
        
        if self.locales_dir.exists():
            for json_file in self.locales_dir.glob("*.json"):
                lang_code = json_file.stem
                languages.append(lang_code)
        
        languages.sort()
        
        if "debug" not in languages:
            languages.append("debug")
        
        return languages

# 创建全局 i18n 实例
i18n_manager = I18n()
t = i18n_manager.t
