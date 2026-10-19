import sys
import types
from pathlib import Path

import pytest

from ba_modding_toolkit import game_paths
from ba_modding_toolkit.game_paths import (
    STEAM_APP_ID,
    reg_value,
    steam_app_dirs,
    vdf_values,
    wine_prefix_candidates,
    wine_to_host,
)

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="Wine prefixes only exist outside Windows")


@pytest.fixture(autouse=True)
def search_as_usual(monkeypatch):
    """These tests check the search itself, which the development hooks (devmode) replace; they search fake prefixes
    and libraries in tmp_path only."""
    for name in ("BAMT_GAME_DIRS_GLOBAL", "BAMT_GAME_DIRS_JAPAN"):
        monkeypatch.delenv(name, raising=False)

LIBRARY_FOLDERS = r'''"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"apps"
		{
			"228980"		"0"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"apps"
		{
			"3557620"		"27729644633"
		}
	}
}
'''

APP_MANIFEST = f'''"AppState"
{{
	"appid"		"{STEAM_APP_ID}"
	"name"		"Blue Archive"
	"installdir"		"BlueArchive"
}}
'''

SYSTEM_REG = r'''WINE REGISTRY Version 2
;; All keys relative to \\Machine

[Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 3557620] 1790795416
#time=1db3f0c2a1b2c3d
"DisplayName"="Blue Archive"
"InstallLocation"="C:\\Program Files (x86)\\Steam\\steamapps\\common\\BlueArchive"

[Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{6FA797CF-6B76-4B6D-87EE-768F92008720}] 1790796559
"InstallLocation"="C:\\Other"
'''


def make_game_dir(path: Path) -> Path:
    (path / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource").mkdir(parents=True)
    return path


def make_steam_library(library: Path) -> Path:
    """Create a Steam library holding Blue Archive and return the game directory"""
    steamapps = library / "steamapps"
    steamapps.mkdir(parents=True, exist_ok=True)
    (steamapps / f"appmanifest_{STEAM_APP_ID}.acf").write_text(APP_MANIFEST, encoding="utf-8")
    return make_game_dir(steamapps / "common" / "BlueArchive")


def make_wine_prefix(prefix: Path) -> Path:
    """Create a Wine prefix with drive links, like Wine does"""
    (prefix / "drive_c").mkdir(parents=True)
    (prefix / "dosdevices").mkdir()
    (prefix / "dosdevices" / "c:").symlink_to("../drive_c")
    return prefix


class TestVdfValues:
    def test_library_paths_are_unescaped(self):
        assert vdf_values(LIBRARY_FOLDERS, "path") == [r"C:\Program Files (x86)\Steam", r"D:\SteamLibrary"]

    def test_installdir(self):
        assert vdf_values(APP_MANIFEST, "installdir") == ["BlueArchive"]

    def test_missing_key(self):
        assert vdf_values(APP_MANIFEST, "path") == []


class TestRegValue:
    def test_install_location(self):
        key = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {STEAM_APP_ID}"
        assert reg_value(SYSTEM_REG, key, "InstallLocation") == r"C:\Program Files (x86)\Steam\steamapps\common\BlueArchive"

    def test_value_of_another_key_is_not_used(self):
        key = rf"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App {STEAM_APP_ID}"
        assert reg_value(SYSTEM_REG, key, "UninstallString") is None

    def test_missing_key(self):
        assert reg_value(SYSTEM_REG, r"SOFTWARE\Missing", "InstallLocation") is None

    def test_non_ascii_escapes(self):
        registry = '[Software\\\\Test] 1\n"InstallLocation"="C:\\\\\\x6e38\\x620f\\\\BlueArchive"\n'
        assert reg_value(registry, r"SOFTWARE\Test", "InstallLocation") == "C:\\\u6e38\u620f\\BlueArchive"


@posix_only
class TestWinePrefix:
    def test_wine_to_host_uses_drive_links(self, tmp_path):
        prefix = make_wine_prefix(tmp_path / "prefix")
        (prefix / "dosdevices" / "d:").symlink_to(tmp_path)
        host = wine_to_host(prefix, r"D:\SteamLibrary\steamapps")
        assert host == prefix / "dosdevices" / "d:" / "SteamLibrary" / "steamapps"
        assert wine_to_host(prefix, "not a windows path") is None

    def test_wine_to_host_falls_back_to_drive_c(self, tmp_path):
        prefix = tmp_path / "prefix"
        (prefix / "drive_c").mkdir(parents=True)
        assert wine_to_host(prefix, "c:/Program Files") == prefix / "drive_c" / "Program Files"

    def test_registry_and_steam_library_give_one_result(self, tmp_path):
        prefix = make_wine_prefix(tmp_path / "prefix")
        (prefix / "system.reg").write_text(SYSTEM_REG, encoding="utf-8")
        steam_dir = prefix / "drive_c" / "Program Files (x86)" / "Steam"
        game_dir = make_steam_library(steam_dir)
        found = game_paths._unique_dirs(wine_prefix_candidates(prefix, "global"))
        assert found == [game_dir.resolve()]
        assert game_paths._unique_dirs(wine_prefix_candidates(prefix, "japan")) == []

    def test_steam_library_on_another_drive(self, tmp_path):
        prefix = make_wine_prefix(tmp_path / "prefix")
        (prefix / "dosdevices" / "d:").symlink_to(tmp_path / "drive_d")
        steam_dir = prefix / "drive_c" / "Program Files (x86)" / "Steam" / "steamapps"
        steam_dir.mkdir(parents=True)
        (steam_dir / "libraryfolders.vdf").write_text(LIBRARY_FOLDERS, encoding="utf-8")
        game_dir = make_steam_library(tmp_path / "drive_d" / "SteamLibrary")
        found = game_paths._unique_dirs(wine_prefix_candidates(prefix, "global"))
        assert found == [game_dir.resolve()]

    def test_find_game_dirs_scans_prefixes_and_native_steam(self, tmp_path, monkeypatch):
        prefix = make_wine_prefix(tmp_path / "prefix")
        (prefix / "system.reg").write_text(SYSTEM_REG, encoding="utf-8")
        wine_game_dir = make_game_dir(prefix / "drive_c" / "Program Files (x86)" / "Steam" / "steamapps" / "common" / "BlueArchive")
        native_game_dir = make_steam_library(tmp_path / "native_steam")
        monkeypatch.setattr(game_paths, "_wine_prefixes", lambda: iter([tmp_path / "not_a_prefix", prefix]))
        monkeypatch.setattr(game_paths, "_native_steam_dirs", lambda: [tmp_path / "native_steam"])
        assert game_paths.find_game_dirs("global") == [wine_game_dir.resolve(), native_game_dir.resolve()]

    def test_find_app_bundles(self, tmp_path):
        wrapper = tmp_path / "Blue Archive" / "Runtime" / "Blue Archive Steam.app"
        (wrapper / "Contents" / "Nested.app").mkdir(parents=True)
        (tmp_path / "com.apple.Something" / "Hidden.app").mkdir(parents=True)
        (tmp_path / "Too" / "Deep" / "Down" / "Far.app").mkdir(parents=True)
        assert list(game_paths._find_app_bundles(tmp_path, 3)) == [wrapper]


class TestWindowsRegistry:
    def test_uninstall_entry_then_steam_libraries(self, tmp_path, monkeypatch):
        steam_dir = tmp_path / "Steam"
        game_dir = make_steam_library(steam_dir)
        values = {
            ("HKLM", game_paths.UNINSTALL_KEYS["global"][0], "InstallLocation"): str(tmp_path / "stale"),
            ("HKCU", r"Software\Valve\Steam", "SteamPath"): str(steam_dir),
        }

        class Key:
            def __init__(self, root, key_path):
                self.root, self.key_path = root, key_path

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def open_key(root, key_path):
            if not any(k[:2] == (root, key_path) for k in values):
                raise FileNotFoundError(key_path)
            return Key(root, key_path)

        def query_value(key, name):
            try:
                return values[(key.root, key.key_path, name)], 1
            except KeyError:
                raise FileNotFoundError(name) from None

        fake_winreg = types.SimpleNamespace(
            HKEY_LOCAL_MACHINE="HKLM", HKEY_CURRENT_USER="HKCU", OpenKey=open_key, QueryValueEx=query_value
        )
        monkeypatch.setitem(sys.modules, "winreg", fake_winreg)
        candidates = list(game_paths._windows_candidates("global"))
        assert candidates[0] == tmp_path / "stale"
        assert game_dir in candidates
        assert game_paths._unique_dirs(candidates) == [game_dir if sys.platform == "win32" else game_dir.resolve()]
