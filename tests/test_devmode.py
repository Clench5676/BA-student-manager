"""The environment hooks for isolated development runs (ba_modding_toolkit.devmode): inert without their variables,
and what each does when set."""

import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import ba_modding_toolkit
from ba_modding_toolkit import config, devmode, utils

DEV_VARIABLES = ("BAMT_DATA_DIR", "BAMT_GAME_DIRS_GLOBAL", "BAMT_GAME_DIRS_JAPAN")
SRC = Path(ba_modding_toolkit.__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def no_dev_variables(monkeypatch):
    """Each test starts with the hooks unset and sets the ones it checks."""
    for name in DEV_VARIABLES:
        monkeypatch.delenv(name, raising=False)


# --- BAMT_DATA_DIR ---

def test_data_dir_unset_or_empty_is_none(monkeypatch):
    assert devmode.data_dir() is None
    monkeypatch.setenv("BAMT_DATA_DIR", "  ")
    assert devmode.data_dir() is None


def test_data_dir_is_absolute(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("BAMT_DATA_DIR", "profile")
    assert devmode.data_dir() == (tmp_path / "profile").resolve()


def test_source_checkout_data_dir_unchanged_without_override():
    assert utils._get_exe_dir() == Path(utils.__file__).resolve().parents[2]


def test_source_checkout_uses_the_override(tmp_path):
    target = tmp_path / "data" / "profile"
    assert utils._get_exe_dir(target) == target
    assert target.is_dir()


@pytest.mark.parametrize("macos", [False, True])
def test_compiled_build_copies_its_addons_into_the_override(tmp_path, monkeypatch, macos):
    portable, extracted, target = tmp_path / "portable", tmp_path / "extracted", tmp_path / "profile"
    portable.mkdir()
    (extracted / "Addons").mkdir(parents=True)
    (extracted / "Addons" / "BA-Characters-Internal-ID.csv").write_text("bundled map")
    monkeypatch.setattr(utils, "__compiled__", SimpleNamespace(containing_dir=str(portable), macos_bundle_mode=macos),
                        raising=False)
    monkeypatch.setattr(utils, "__file__", str(extracted / "ba_modding_toolkit" / "utils.py"))
    monkeypatch.setattr(sys, "executable", str(extracted / "Tool" if macos else portable / "Tool.exe"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "home")
    assert utils._get_exe_dir(target) == target
    assert (target / "Addons" / "BA-Characters-Internal-ID.csv").read_text() == "bundled map"
    # the released app's data folder and the portable folder stay untouched
    assert not (tmp_path / "home").exists()
    assert list(portable.iterdir()) == []


def test_cache_dir_unchanged_without_override(monkeypatch, tmp_path):
    monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", None)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    expected = {
        "win32": tmp_path / "AppData" / "Local" / "BA-Modding-Toolkit" / "cache",
        "darwin": tmp_path / "Library" / "Application Support" / "BA-Modding-Toolkit" / "cache",
    }.get(sys.platform, tmp_path / ".cache" / "BA-Modding-Toolkit")
    assert config.user_cache_dir() == expected


def test_cache_dir_follows_the_override(monkeypatch, tmp_path):
    monkeypatch.setattr(utils, "DATA_DIR_OVERRIDE", tmp_path)
    assert config.user_cache_dir() == tmp_path / "cache"


def _python(code: str, **env: str) -> str:
    """Run code in a fresh interpreter (the variables take effect on import) and return its output."""
    environ = {k: v for k, v in os.environ.items() if k not in DEV_VARIABLES}
    environ.update(PYTHONPATH=str(SRC), BAMT_GAME_DIRS_GLOBAL="", BAMT_GAME_DIRS_JAPAN="", **env)
    return subprocess.run([sys.executable, "-c", code], env=environ, capture_output=True, text=True, check=True,
                          timeout=60).stdout


def test_data_dir_is_read_on_import(tmp_path):
    out = _python("from ba_modding_toolkit import config, utils\n"
                  "print(utils.EXE_DIR); print(config.CONFIG_FILE); print(config.user_cache_dir())",
                  BAMT_DATA_DIR=str(tmp_path / "profile"))
    profile = (tmp_path / "profile").resolve()
    assert out.splitlines() == [str(profile), str(profile / "config.toml"), str(profile / "cache")]
    assert profile.is_dir()


# --- BAMT_GAME_DIRS_GLOBAL / BAMT_GAME_DIRS_JAPAN ---

@pytest.fixture
def no_search(monkeypatch):
    """Fail the test if the game is searched for: the user's prefixes, Steam libraries or registry."""
    from ba_modding_toolkit import game_paths

    def searched(*args, **kwargs):
        raise AssertionError("searched for the game")

    for name in ("_unix_candidates", "_windows_candidates", "_wine_prefixes", "_native_steam_dirs"):
        monkeypatch.setattr(game_paths, name, searched)
    monkeypatch.setattr(utils, "_ba_path_cache", {})


def test_game_dirs_unset_is_none():
    assert devmode.game_dirs("global") is None and devmode.game_dirs("japan") is None


def test_named_game_dirs_replace_the_search(tmp_path, monkeypatch, no_search):
    from ba_modding_toolkit.game_paths import find_game_dirs

    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    monkeypatch.setenv("BAMT_GAME_DIRS_GLOBAL", os.pathsep.join([str(second), str(tmp_path / "missing"), str(first),
                                                                 str(second)]))
    monkeypatch.setenv("BAMT_GAME_DIRS_JAPAN", "")
    assert find_game_dirs("global") == [second.resolve(), first.resolve()]
    assert find_game_dirs("japan") == []
    assert utils.get_BA_path("global") == str(second.resolve())
    assert utils.get_BA_path("japan") is None
    assert utils.get_BA_path("auto") == str(second.resolve())


def test_named_game_dirs_are_the_settings_defaults(tmp_path, monkeypatch, no_search):
    game = tmp_path / "game"
    game.mkdir()
    monkeypatch.setenv("BAMT_GAME_DIRS_GLOBAL", str(game))
    monkeypatch.setenv("BAMT_GAME_DIRS_JAPAN", "")
    s = config.Settings(tmp_path / "config.toml")
    assert s.get("game_resource_dir") == str(game.resolve())
    assert s.get("game_resource_dir_japan") == ""
    assert s.get("file_source") == "windows_global"
