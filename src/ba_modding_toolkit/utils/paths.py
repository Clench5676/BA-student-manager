"""Game discovery and isolated data paths, independent of GUI initialization."""
import shutil
import sys
from pathlib import Path
from typing import Literal
from .. import devmode
from ..data_paths import migrate_data_dir
from ..game_paths import find_game_dirs

_ba_path_cache: dict[str, str | None] = {}
BARegion = Literal["auto", "global", "japan"]

def get_BA_path(region: BARegion = "auto") -> str | None:
    """获取游戏安装路径，带缓存机制

    Args:
        region: 区服，"auto"（默认）时优先返回 global 的结果，找不到则回退 japan

    Returns:
        游戏安装路径，如果未找到则返回 None
    """
    if region in _ba_path_cache:
        return _ba_path_cache[region]

    if region in ("global", "japan"):
        game_dirs = find_game_dirs(region)
        result = str(game_dirs[0]) if game_dirs else None
    else:  # auto
        result = get_BA_path("global") or get_BA_path("japan")
        return result  # auto 不缓存，保持对注册表变化的响应

    _ba_path_cache[region] = result
    return result

def _get_exe_dir(override: Path | None = None) -> Path:
    """Return the directory for config and user data.

    A macOS .app usually lives somewhere read-only (/Applications, a mounted DMG,
    App Translocation), so app bundles use ~/Library/Application Support/bluearchive-modding-patching-tool
    instead and copy the Addons bundled in the app (character ID map etc.) there on first launch.
    Windows onefile builds copy their bundled Addons next to the original executable instead.

    ``override`` (``BAMT_DATA_DIR``, see devmode) replaces the folder in every case; a build still copies its
    bundled Addons there, so it runs as shipped.
    """
    if "__compiled__" not in globals() or not hasattr(__compiled__, "containing_dir"):
        if override is None:
            return Path(__file__).resolve().parents[3]
        override.mkdir(parents=True, exist_ok=True)
        return override
    if getattr(__compiled__, "macos_bundle_mode", False):
        data_dir = override if override is not None else migrate_data_dir(Path.home() / "Library" / "Application Support")
        bundled_addons = Path(sys.executable).parent / "Addons"
    else:
        data_dir = override or Path(__compiled__.containing_dir).resolve()
        # Module files live in the onefile extraction tree; containing_dir is the portable install.
        bundled_addons = Path(__file__).resolve().parents[2] / "Addons"
    data_dir.mkdir(parents=True, exist_ok=True)
    if bundled_addons.is_dir() and not (data_dir / "Addons").exists():
        try:
            shutil.copytree(bundled_addons, data_dir / "Addons")
        except OSError as e:
            import logging

            logging.getLogger(__name__).warning("Could not copy bundled Addons to %s: %s", data_dir, e)
    return data_dir

DATA_DIR_OVERRIDE = devmode.data_dir()
EXE_DIR = _get_exe_dir(DATA_DIR_OVERRIDE)
# Module paths stay inside the onefile extraction tree when resources are bundled there.
PACKAGE_DIR = Path(__file__).resolve().parents[1]
