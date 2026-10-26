"""Tk-free application settings.

Reads and writes the same ``config.toml`` as the classic GUI (``gui/configs.py``): the same groups, keys and defaults,
so both GUIs share one file. Unknown groups and keys found in the file are kept when saving.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import toml

from . import devmode, utils
from .data_paths import APP_DIR_NAME, OLD_APP_DIR_NAME, default_cache_dir, migrate_cache_dir
from .models import AnimCheckOptions, SaveOptions, SkelConvertOptions
from .naming import CharacterInternalIDMap
from .utils import EXE_DIR, get_BA_path, parse_hex_bytes

CONFIG_FILE = EXE_DIR / "config.toml"

logger = logging.getLogger(__name__)
_ignored_game_dirs: set[str] = set()  # dev mode: game folders outside the dev roots, logged once each


@dataclass(frozen=True)
class Field:
    group: str
    default: Any  # a value, or a callable returning one
    # the value's type (bool, int or str): values read from the file are coerced to it, so a callable default (game
    # detection) runs only when the key is missing; inferred from a plain default, required for a callable one
    kind: type | None = None

    def __post_init__(self) -> None:
        if self.kind is None:
            if callable(self.default):
                raise TypeError("a field with a callable default needs its kind")
            object.__setattr__(self, "kind", type(self.default))


def _default_file_source() -> str:
    if get_BA_path("global"):
        return "windows_global"
    if get_BA_path("japan"):
        return "windows_japan"
    return "windows_global"


# key -> field, in the order of gui/configs.py
FIELDS: dict[str, Field] = {
    # Directories
    "file_source": Field("Directories", _default_file_source, str),
    "game_resource_dir": Field("Directories", lambda: get_BA_path("global") or "", str),
    "game_resource_dir_japan": Field("Directories", lambda: get_BA_path("japan") or "", str),
    "game_dir_android_global": Field("Directories", "/storage/emulated/0/Android/data/com.nexon.bluearchive/files/PUB/Resource/"),
    "game_dir_android_japan": Field("Directories", "/storage/emulated/0/Android/data/com.Yostar JP.BlueArchive/files/"),
    "mod_backup_path": Field("Directories", lambda: str(EXE_DIR / "output" / "backup"), str),
    # AppSettings
    "language": Field("AppSettings", ""),
    "output_dir": Field("AppSettings", lambda: str(EXE_DIR / "output"), str),
    "max_workers": Field("AppSettings", 4),
    # SaveOptions
    "extra_bytes": Field("SaveOptions", "0x08080808"),
    "enable_crc_correction": Field("SaveOptions", "auto"),
    "create_backup": Field("SaveOptions", True),
    "compression_method": Field("SaveOptions", "lzma"),
    "skip_unchanged": Field("SaveOptions", True),
    # ResourceTypes
    "replace_texture2d": Field("ResourceTypes", True),
    "replace_textasset": Field("ResourceTypes", True),
    "replace_mesh": Field("ResourceTypes", True),
    "replace_animationclip": Field("ResourceTypes", True),
    "replace_all": Field("ResourceTypes", False),
    # SpineConverter
    "spine_converter_path": Field("SpineConverter", ""),
    "enable_spine_conversion": Field("SpineConverter", False),
    "target_spine_version": Field("SpineConverter", "4.2.33"),
    # SpineDowngrade
    "enable_spine_downgrade": Field("SpineDowngrade", False),
    "spine_downgrade_version": Field("SpineDowngrade", "3.8.75"),
    "scale_atlas": Field("SpineDowngrade", False),
    # SpineViewer
    "spine_viewer_path": Field("SpineViewer", ""),
    "check_animations": Field("SpineViewer", False),
    "preview_thumbnail_size": Field("SpineViewer", 768),
    "mod_install_render_preview": Field("SpineViewer", True),
    # BACIIMap
    "bacii_map_path": Field("BACIIMap", lambda: str(EXE_DIR / "Addons" / "BA-Characters-Internal-ID.csv"), str),
    "character_index_column": Field("BACIIMap", "file_id"),
    "character_name_field": Field("BACIIMap", CharacterInternalIDMap.DEFAULT_NAME_FIELD),
    # Tabs
    "enable_spine38_namefix": Field("Tabs", False),
    "enable_bleed": Field("Tabs", False),
    "unpack_atlas": Field("Tabs", False),
    "enable_spine_preview": Field("Tabs", False),
    "render_preview": Field("Tabs", False),
    # Tools
    "report_format": Field("Tools", "list"),
    "report_render_preset": Field("Tools", "low"),
    # ADB
    "adb_path": Field("ADB", "adb"),
    "adb_device": Field("ADB", ""),
    "adb_cache_dir": Field("ADB", lambda: str(EXE_DIR / "Addons" / "adb_cache"), str),
}


def _default(key: str) -> Any:
    d = FIELDS[key].default
    return d() if callable(d) else d


def _coerce(key: str, value: Any) -> Any:
    """Bring a value read from the file to the field's type, without running a callable default."""
    kind = FIELDS[key].kind
    try:
        if kind is bool:
            return value if isinstance(value, bool) else str(value).strip().lower() in ("1", "true", "yes", "on")
        if kind is int:
            return int(value)
        if kind is str:
            return str(value)
    except (TypeError, ValueError):
        return _default(key)
    return value


class Settings:
    """The settings in ``config.toml``. Thread-safe; ``reload_if_changed`` picks up saves made by the classic GUI.

    In dev mode (devmode) the file must lie inside the dev roots, and a game folder outside them is not used.
    """

    def __init__(self, path: Path = CONFIG_FILE):
        devmode.check_read(path)
        self.path = Path(path)
        self._lock = threading.RLock()
        self._values: dict[str, Any] = {}
        self._extra: dict[str, dict] = {}  # groups and keys this schema does not know, kept on save
        self._mtime: float | None = None
        self._listeners: list[Callable[[], None]] = []
        self.load()

    # --- file ---

    def load(self) -> None:
        with self._lock:
            data: dict[str, dict] = {}
            if self.path.exists():
                try:
                    data = toml.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, toml.TomlDecodeError):
                    data = {}
            values, known = {}, set()
            detected: dict[str, str] = {}

            def detect(region: str) -> str:
                if region not in detected:
                    detected[region] = get_BA_path(region) or ""
                return detected[region]

            for key, f in FIELDS.items():
                group = data.get(f.group, {})
                if key in group:
                    values[key] = _coerce(key, group[key])
                elif key == "file_source":
                    values[key] = "windows_global" if detect("global") else "windows_japan" if detect("japan") else "windows_global"
                elif key in ("game_resource_dir", "game_resource_dir_japan"):
                    values[key] = detect("japan" if key.endswith("japan") else "global")
                else:
                    values[key] = _default(key)
                known.add((f.group, key))
            extra: dict[str, dict] = {}
            for group, entries in data.items():
                if not isinstance(entries, dict):
                    continue
                for k, v in entries.items():
                    if (group, k) not in known:
                        extra.setdefault(group, {})[k] = v
            self._values, self._extra = values, extra
            self._mtime = self._stat()

    def save(self) -> None:
        with self._lock:
            data: dict[str, dict] = {g: dict(v) for g, v in self._extra.items()}
            for key, f in FIELDS.items():
                data.setdefault(f.group, {})[key] = self._values[key]
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".toml.tmp")
            tmp.write_text(toml.dumps(data), encoding="utf-8")
            os.replace(tmp, self.path)
            self._mtime = self._stat()

    def reload_if_changed(self) -> bool:
        """Reload when the file changed on disk since the last load or save. Returns whether it reloaded."""
        with self._lock:
            if self._stat() == self._mtime:
                return False
            self.load()
        for listener in list(self._listeners):
            listener()
        return True

    def on_change(self, listener: Callable[[], None]) -> None:
        self._listeners.append(listener)

    def _stat(self) -> float | None:
        try:
            return self.path.stat().st_mtime
        except OSError:
            return None

    # --- values ---

    def get(self, key: str) -> Any:
        with self._lock:
            return self._values[key]

    def set(self, key: str, value: Any) -> None:
        if key not in FIELDS:
            raise KeyError(key)
        with self._lock:
            self._values[key] = _coerce(key, value)

    def as_dict(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._values)

    # --- derived values (mirrors the builders in gui/app.py) ---

    def is_adb_mode(self) -> bool:
        return str(self.get("file_source")).startswith("adb_")

    def server_region(self) -> str:
        return "japan" if self.get("file_source") in ("windows_japan", "adb_japan") else "global"

    def game_dir(self) -> Path | None:
        """The local game folder for the current file source, or None in ADB mode or when it is not set."""
        source = self.get("file_source")
        key = {"windows_global": "game_resource_dir", "windows_japan": "game_resource_dir_japan"}.get(source)
        value = self.get(key) if key else ""
        if not value:
            return None
        if not devmode.allows_read(value):
            if value not in _ignored_game_dirs:
                _ignored_game_dirs.add(value)
                logger.warning("Game folder outside the dev roots, not used: %s", value)
            return None
        return Path(value)

    def resource_dirs(self) -> list[Path]:
        """The existing resource folders of the local game (empty when there is none)."""
        from .searching import get_search_dirs

        base = self.game_dir()
        return get_search_dirs(base) if base and base.exists() else []

    def asset_types(self) -> set[str]:
        if self.get("replace_all"):
            return {"ALL"}
        names = {"replace_texture2d": "Texture2D", "replace_textasset": "TextAsset",
                 "replace_mesh": "Mesh", "replace_animationclip": "AnimationClip"}
        return {v for k, v in names.items() if self.get(k)}

    def save_options(self, perform_crc: bool) -> SaveOptions:
        return SaveOptions(perform_crc=perform_crc, extra_bytes=parse_hex_bytes(self.get("extra_bytes")),
                           compression=self.get("compression_method"))

    def crc_needed(self, target: Path | None) -> bool:
        setting = self.get("enable_crc_correction")
        if setting == "true":
            return True
        if setting == "false" or target is None:
            return False
        from .bundle import Bundle

        return Bundle.check_need_crc(target)

    def spine_options(self, upgrade: bool = True) -> SkelConvertOptions:
        if upgrade:
            return SkelConvertOptions(enabled=self.get("enable_spine_conversion"),
                                      converter_path=Path(self.get("spine_converter_path")),
                                      target_version=self.get("target_spine_version"))
        return SkelConvertOptions(enabled=self.get("enable_spine_downgrade"),
                                  converter_path=Path(self.get("spine_converter_path")),
                                  target_version=str(self.get("spine_downgrade_version")).strip())

    def anim_check_options(self) -> AnimCheckOptions:
        return AnimCheckOptions(enabled=self.get("check_animations"), viewer_path=Path(self.get("spine_viewer_path")))

    def output_subdir(self, name: str) -> Path:
        path = Path(self.get("output_dir")) / name
        devmode.check_read(path)
        path.mkdir(parents=True, exist_ok=True)
        return path


def user_cache_dir() -> Path:
    """Where light game UI assets may be cached after the user agreed (never next to the program).

    With ``BAMT_DATA_DIR`` (devmode) the cache is ``<BAMT_DATA_DIR>/cache``, never the released app's.
    """
    return default_cache_dir(utils.DATA_DIR_OVERRIDE, utils.EXE_DIR)


def managed_cache_dir(parent: str | None = None) -> Path:
    """Use Settings' selected cache parent, shared by the App and CLI."""
    if not parent:
        return user_cache_dir()
    chosen = Path(parent)
    devmode.check_read(chosen)
    return migrate_cache_dir(chosen / OLD_APP_DIR_NAME / "cache", chosen / APP_DIR_NAME / "cache")
