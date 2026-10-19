"""The environment hooks for isolated development runs (ba_modding_toolkit.devmode): inert without their variables,
and what each does when set."""

import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import ba_modding_toolkit
from ba_modding_toolkit import config, devmode, utils

DEV_VARIABLES = ("BAMT_DATA_DIR", "BAMT_GAME_DIRS_GLOBAL", "BAMT_GAME_DIRS_JAPAN", "BAMT_DEV_ROOTS",
                 "BAMT_DEV_WRITABLE")
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


# --- BAMT_DEV_ROOTS ---

@pytest.fixture
def dev(tmp_path, monkeypatch):
    """Dev mode with one root (dev) and a folder outside it (user), standing in for the user's data."""
    root, outside = tmp_path / "dev", tmp_path / "user"
    root.mkdir()
    outside.mkdir()
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(root))
    return SimpleNamespace(root=root, outside=outside)


def expect_outside(action, path=None):
    from ba_modding_toolkit.errors import ServiceError

    with pytest.raises(ServiceError) as caught:
        action()
    assert caught.value.code == "dev_path_outside"
    if path is not None:
        assert caught.value.params == {"path": str(path)}


def test_inert_without_dev_mode(tmp_path):
    assert devmode.active() is False and devmode.roots() == []
    for path in (tmp_path, Path("/"), Path.home()):
        assert devmode.allows_read(path)
        devmode.check_read(path)


def test_dev_roots_allow_their_inside_only(tmp_path, monkeypatch, dev):
    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setenv("BAMT_DEV_ROOTS", os.pathsep.join([str(dev.root), str(other)]))
    assert devmode.active()
    for path in (dev.root, dev.root / "a" / "not-yet.bundle", other / "b", str(dev.root / "c")):
        devmode.check_read(path)
    for path in (dev.outside, dev.outside / "mod.bundle", tmp_path, dev.root / ".." / "user" / "x"):
        assert not devmode.allows_read(path)
    expect_outside(lambda: devmode.check_read(dev.outside / "mod.bundle"), dev.outside / "mod.bundle")


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need privileges on Windows")
def test_a_link_cannot_lead_out_of_a_root(dev):
    (dev.outside / "mods").mkdir()
    (dev.root / "link").symlink_to(dev.outside / "mods")
    expect_outside(lambda: devmode.check_read(dev.root / "link" / "mod.bundle"))


def test_dev_roots_set_to_nothing_allow_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("BAMT_DEV_ROOTS", "")
    assert devmode.active()
    expect_outside(lambda: devmode.check_read(tmp_path))


def test_dev_mode_never_searches_for_the_game(dev, no_search):
    from ba_modding_toolkit.game_paths import find_game_dirs

    assert find_game_dirs("global") == [] and find_game_dirs("japan") == []
    assert utils.get_BA_path("auto") is None


def test_named_game_dirs_outside_the_roots_are_dropped(dev, monkeypatch, no_search):
    from ba_modding_toolkit.game_paths import find_game_dirs

    view = dev.root / "view"
    view.mkdir()
    monkeypatch.setenv("BAMT_GAME_DIRS_GLOBAL", os.pathsep.join([str(dev.outside), str(view)]))
    assert find_game_dirs("global") == [view.resolve()]


def test_settings_file_must_lie_inside_the_roots(dev):
    expect_outside(lambda: config.Settings(dev.outside / "config.toml"))
    config.Settings(dev.root / "config.toml")


def test_game_folder_outside_the_roots_is_not_used(dev):
    game = dev.root / "game"
    (game / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows").mkdir(parents=True)
    s = config.Settings(dev.root / "config.toml")
    s.set("file_source", "windows_global")
    s.set("game_resource_dir", str(dev.outside))
    assert s.game_dir() is None and s.resource_dirs() == []
    s.set("game_resource_dir", str(game))
    assert s.game_dir() == game and s.resource_dirs()


def test_output_folder_outside_the_roots_is_refused(dev):
    s = config.Settings(dev.root / "config.toml")
    s.set("output_dir", str(dev.outside / "output"))
    expect_outside(lambda: s.output_subdir("extract"))
    assert not (dev.outside / "output").exists()
    s.set("output_dir", str(dev.root / "output"))
    assert s.output_subdir("extract").is_dir()


def test_library_takes_mods_from_inside_the_roots_only(dev):
    from ba_modding_toolkit.errors import ServiceError
    from ba_modding_toolkit.library import ModLibrary

    library = ModLibrary(dev.root / "library", SimpleNamespace(), object(), config.Settings(dev.root / "config.toml"))
    outside = dev.outside / "mod.bundle"
    outside.write_bytes(b"user's mod")
    expect_outside(lambda: library.add([outside]), outside)
    inside = dev.root / "not-a-mod.txt"
    inside.write_bytes(b"x")
    with pytest.raises(ServiceError) as caught:
        library.add([inside])
    assert caught.value.code == "mod_unsupported"  # past the dev check
    assert not (dev.root / "library" / "mods").exists()


def test_mod_install_plans_inside_the_roots_only(dev):
    from ba_modding_toolkit.mod_install import plan_mod_install

    name = "assets-_mx-spinecharacters-test_spr-_mxdependency-2026-01-01_003_assets_all_1.bundle"
    (dev.root / "game").mkdir()
    (dev.root / name).write_bytes(b"mod")
    (dev.outside / name).write_bytes(b"user's mod")
    expect_outside(lambda: plan_mod_install([dev.outside / name], [dev.root / "game"]))
    expect_outside(lambda: plan_mod_install([dev.root / name], [dev.outside]))
    assert plan_mod_install([dev.root / name], [dev.root / "game"])


class _Library:
    def __init__(self):
        self.added = []

    def add(self, paths):
        self.added.append(paths)
        return []


@pytest.fixture
def dev_services(dev):
    from ba_modding_toolkit.webui.services import Services
    from ba_modding_toolkit.webui.state import UiState

    s = Services(config.Settings(dev.root / "config.toml"), dev.root, state=UiState(dev.root / "webui.json"),
                 game=object(), catalog=object(), library=_Library())
    yield s
    s.close()


def test_web_ui_data_directory_must_lie_inside_the_roots(dev):
    from ba_modding_toolkit.webui.services import Services

    expect_outside(lambda: Services(config.Settings(dev.root / "config.toml"), dev.outside))
    assert list(dev.outside.iterdir()) == []


def test_web_ui_refuses_paths_outside_the_roots(dev, dev_services):
    from ba_modding_toolkit.webui.api import build_api

    api = build_api(dev_services)
    game = dev.root / "game"
    (game / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows").mkdir(parents=True)
    for key, value in (("gameDir.global", dev.outside), ("gameDir.japan", dev.outside),
                       ("outputDir", dev.outside / "output"), ("libraryDir", dev.outside / "library"),
                       ("cacheDir", dev.outside)):
        reply = api.call("settings.set", {"key": key, "value": str(value)})
        assert reply["error"]["code"] == "dev_path_outside", key
    assert list(dev.outside.iterdir()) == []
    reply = api.call("mods.add", {"paths": [str(dev.outside / "mod.bundle")]})
    assert reply["error"]["code"] == "dev_path_outside"
    assert dev_services.library.added == []
    assert api.call("settings.detectGame", {"region": "global"}) == {"result": []}
    # inside the roots the same calls go through
    assert "result" in api.call("settings.set", {"key": "gameDir.global", "value": str(game)})
    assert "result" in api.call("settings.set", {"key": "outputDir", "value": str(dev.root / "output")})
    assert "result" in api.call("mods.add", {"paths": [str(dev.root / "mod.bundle")]})


def test_web_ui_library_and_cache_outside_the_roots_are_refused(dev):
    from ba_modding_toolkit.webui.services import Services
    from ba_modding_toolkit.webui.state import UiState

    state = UiState(dev.root / "webui.json")
    state.set("library_dir", str(dev.outside / "library"))
    state.set("cache_parent", str(dev.outside))
    s = Services(config.Settings(dev.root / "config.toml"), dev.root, state=state, game=object(), catalog=object())
    try:
        expect_outside(lambda: s.library)
        expect_outside(lambda: s.cache)
    finally:
        s.close()
    assert list(dev.outside.iterdir()) == []


def test_game_assets_read_and_cache_inside_the_roots_only(dev):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets

    expect_outside(lambda: AssetCache(root=dev.outside / "cache", allowed=True))
    cache = AssetCache(root=dev.root / "cache", allowed=True)
    expect_outside(lambda: GameAssets([dev.outside], cache))
    (dev.root / "game").mkdir()
    assert GameAssets([dev.root / "game"], cache).resource_dirs == [(dev.root / "game").resolve()]


class _Log:
    def __init__(self):
        self.lines = []

    def log(self, message):
        self.lines.append(message)


def _refused(log):
    return any("outside the dev roots" in line for line in log.lines)


def test_cli_refuses_path_arguments_outside_the_roots(dev, monkeypatch):
    from ba_modding_toolkit.cli.handlers import handle_extract
    from ba_modding_toolkit.cli.taps import ExtractTap

    log = _Log()
    handle_extract(ExtractTap().parse_args([str(dev.outside / "a.bundle"), "--output-dir", str(dev.root / "out")]), log)
    assert _refused(log) and not (dev.root / "out").exists()
    # the default output folder is relative to the working directory
    monkeypatch.chdir(dev.outside)
    log = _Log()
    handle_extract(ExtractTap().parse_args([str(dev.root / "a.bundle")]), log)
    assert _refused(log) and list(dev.outside.iterdir()) == []
    log = _Log()
    handle_extract(ExtractTap().parse_args([str(dev.root / "a.bundle"), "--output-dir", str(dev.root / "out")]), log)
    assert not _refused(log)
    assert any("does not exist" in line for line in log.lines)  # the command ran


def test_cli_without_dev_mode_runs_as_before(tmp_path):
    from ba_modding_toolkit.cli.handlers import handle_extract
    from ba_modding_toolkit.cli.taps import ExtractTap

    log = _Log()
    handle_extract(ExtractTap().parse_args([str(tmp_path / "a.bundle"), "--output-dir", str(tmp_path / "out")]), log)
    assert not _refused(log)
    assert any("does not exist" in line for line in log.lines)


# --- BAMT_DEV_WRITABLE ---

@pytest.fixture
def sandboxed(dev, monkeypatch):
    """Dev mode where dev/sandboxes is writable and dev/view is only readable (a game view)."""
    sandboxes, view = dev.root / "sandboxes", dev.root / "view"
    sandboxes.mkdir()
    view.mkdir()
    monkeypatch.setenv("BAMT_DEV_WRITABLE", str(sandboxes))
    return SimpleNamespace(root=dev.root, outside=dev.outside, sandboxes=sandboxes, view=view)


def test_writes_are_unchecked_without_dev_mode(tmp_path):
    assert devmode.allows_write(tmp_path / "file") and devmode.allows_write(Path.home() / "file")
    devmode.check_write(Path("/") / "file")
    assert devmode.in_writable(tmp_path) is False


def test_writable_folders_only_take_writes(sandboxed):
    assert devmode.in_writable(sandboxed.sandboxes / "game" / "a.bundle")
    devmode.check_write(sandboxed.sandboxes / "game" / "a.bundle")
    for path in (sandboxed.view / "a.bundle", sandboxed.root / "a.bundle", sandboxed.outside / "a.bundle"):
        assert not devmode.in_writable(path)
        expect_outside(lambda: devmode.check_write(path), path)


def test_writable_folders_alone_turn_dev_mode_on(tmp_path, monkeypatch):
    monkeypatch.setenv("BAMT_DEV_WRITABLE", str(tmp_path / "sandboxes"))
    assert devmode.active()
    devmode.check_read(tmp_path / "sandboxes" / "game")
    expect_outside(lambda: devmode.check_read(tmp_path / "user"))


def test_library_staging_folders_take_writes(sandboxed, tmp_path, monkeypatch):
    import tempfile

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "temp"))
    (tmp_path / "temp").mkdir()
    staging = Path(tempfile.mkdtemp(prefix=devmode.LIBRARY_STAGING_PREFIX))
    devmode.check_write(staging / "targets" / "a.bundle")
    for path in (tmp_path / "temp" / "a.bundle", tmp_path / "temp" / "bamt_adb_cache" / "a.bundle"):
        expect_outside(lambda: devmode.check_write(path))


def test_game_files_are_written_in_writable_folders_only(sandboxed, monkeypatch):
    from ba_modding_toolkit.library import safety

    def game_check():
        raise AssertionError("the game check ran")

    monkeypatch.setattr(safety, "check_game_not_running", game_check)
    sandbox_file = sandboxed.sandboxes / "a.bundle"
    sandbox_file.write_bytes(b"sandbox")
    with safety.writable_game_files([sandbox_file], [sandboxed.sandboxes]):
        sandbox_file.write_bytes(b"switched")
    view_file = sandboxed.view / "a.bundle"
    view_file.write_bytes(b"official")

    def write_view():
        with safety.writable_game_files([view_file], [sandboxed.view]):
            view_file.write_bytes(b"changed")

    expect_outside(write_view, view_file)
    assert view_file.read_bytes() == b"official"


def test_game_check_runs_without_dev_mode(tmp_path, monkeypatch):
    from ba_modding_toolkit.library import safety

    checks = []
    monkeypatch.setattr(safety, "check_game_not_running", lambda: checks.append(True))
    game_file = tmp_path / "a.bundle"
    game_file.write_bytes(b"official")
    with safety.writable_game_files([game_file], [tmp_path]):
        pass
    assert checks == [True]


def _header_bundle(payload: bytes) -> bytes:
    header = b"UnityFS\x00" + (6).to_bytes(4, "big") + b"5.x.x\x002021.3\x00"
    return header + (len(header) + 8 + len(payload)).to_bytes(8, "big") + payload


def _switch_env(game_dir: Path, data: Path, monkeypatch):
    """A library whose game folder holds one official portrait bundle, and a mod for it ready to import."""
    from ba_modding_toolkit.bundle import Bundle
    from ba_modding_toolkit.library import ModLibrary, safety

    official = _header_bundle(b"official")
    name = ("assets-_mx-spinecharacters-test_spr-_mxdependency-2026-01-01_003_assets_all_"
            f"{utils.CRCUtils.compute_crc32(official)}.bundle")
    game_dir.mkdir(parents=True, exist_ok=True)
    (game_dir / name).write_bytes(official)
    (data / "import").mkdir(parents=True)
    (data / "import" / name).write_bytes(_header_bundle(b"modded!!"))
    variant = SimpleNamespace(key="test", spr="test_spr", lobby=None, family="test")
    catalog = SimpleNamespace(variant=lambda key: variant,
                              variant_for_core=lambda core: variant if core == "test_spr" else None)
    settings = config.Settings(data / "config.toml")
    settings.set("game_resource_dir", str(game_dir))
    settings.set("enable_crc_correction", "false")
    settings.set("compression_method", "none")
    monkeypatch.setattr(Bundle, "check_need_crc", lambda *args, **kwargs: False)

    def game_check():
        raise AssertionError("the game check ran")

    monkeypatch.setattr(safety, "check_game_not_running", game_check)
    library = ModLibrary(data / "library", catalog, object(), settings)
    return SimpleNamespace(library=library, game_file=game_dir / name, official=official, mod=data / "import" / name)


def test_a_switch_writes_a_sandbox(sandboxed, monkeypatch):
    env = _switch_env(sandboxed.sandboxes / "game", sandboxed.root / "data", monkeypatch)
    entry = env.library.add([env.mod])[0]
    result = env.library.apply("test", f"mod:{entry.id}")
    assert result.files == [env.game_file]
    assert env.game_file.read_bytes() == env.mod.read_bytes()
    env.library.restore("test")
    assert env.game_file.read_bytes() == env.official


def test_a_switch_never_writes_a_view(sandboxed, monkeypatch):
    env = _switch_env(sandboxed.view / "game", sandboxed.root / "data", monkeypatch)
    entry = env.library.add([env.mod])[0]
    expect_outside(lambda: env.library.apply("test", f"mod:{entry.id}"), env.game_file.resolve())
    assert env.game_file.read_bytes() == env.official


def test_mod_install_writes_writable_folders_only(sandboxed):
    from ba_modding_toolkit.mod_install import _backup_and_replace

    source = sandboxed.root / "mod.bundle"
    source.write_bytes(b"mod")
    for folder, allowed in ((sandboxed.sandboxes, True), (sandboxed.view, False), (sandboxed.outside, False)):
        target = folder / "game.bundle"
        target.write_bytes(b"official")
        log = _Log()
        assert _backup_and_replace(source, target, True, log.log) is allowed
        assert target.read_bytes() == (b"mod" if allowed else b"official")
        assert (folder / "game.bundle.backup").exists() is allowed


def test_crc_fix_changes_writable_folders_only(sandboxed):
    for folder in (sandboxed.view, sandboxed.outside):
        target = folder / "fix.bundle"
        target.write_bytes(b"modded data")
        expect_outside(lambda: utils.CRCUtils.manipulate_file_crc(target, 0x12345678), target)
        assert target.read_bytes() == b"modded data"
    target = sandboxed.sandboxes / "fix.bundle"
    target.write_bytes(b"modded data")
    assert utils.CRCUtils.manipulate_file_crc(target, 0x12345678)
    assert utils.CRCUtils.compute_crc32(target) == 0x12345678


def test_cli_crc_fix_changes_writable_folders_only(sandboxed):
    from ba_modding_toolkit.cli.handlers import handle_crc
    from ba_modding_toolkit.cli.taps import CrcTap

    target = sandboxed.view / "fix.bundle"
    target.write_bytes(b"modded data")
    log = _Log()
    handle_crc(CrcTap().parse_args([str(target), "--target-crc", "0x12345678"]), log)
    assert any("BAMT_DEV_WRITABLE" in line for line in log.lines)
    assert target.read_bytes() == b"modded data" and not (sandboxed.view / "fix.bundle.backup").exists()
    log = _Log()
    handle_crc(CrcTap().parse_args([str(target), "--check"]), log)  # reading a view is fine
    assert not _refused(log)
    target = sandboxed.sandboxes / "fix.bundle"
    target.write_bytes(b"modded data")
    handle_crc(CrcTap().parse_args([str(target), "--target-crc", "0x12345678"]), _Log())
    assert utils.CRCUtils.compute_crc32(target) == 0x12345678


def test_classic_file_replace_writes_writable_folders_only(sandboxed):
    gui_utils = pytest.importorskip("ba_modding_toolkit.gui.utils")
    source = sandboxed.root / "new.bundle"
    source.write_bytes(b"new")
    target = sandboxed.view / "game.bundle"
    target.write_bytes(b"official")
    assert gui_utils._perform_file_replace(source, target) is False
    assert target.read_bytes() == b"official" and not (sandboxed.view / "game.bundle.backup").exists()
    target = sandboxed.sandboxes / "game.bundle"
    target.write_bytes(b"official")
    assert gui_utils._perform_file_replace(source, target) is True
    assert target.read_bytes() == b"new"


# --- ADB and self-update, refused in dev mode ---

def test_adb_is_never_run_in_dev_mode(dev, monkeypatch, tmp_path):
    from ba_modding_toolkit.adb import manager

    def run(*args, **kwargs):
        raise AssertionError("adb ran")

    monkeypatch.setattr(manager.subprocess, "run", run)
    adb = manager.ADBManager("adb")
    with pytest.raises(manager.ADBError):
        adb._run_command(["devices"])
    available, message = adb.detect_adb()
    assert available is False and "dev mode" in message
    assert adb.get_devices() == [] and adb.is_connected is False
    assert adb.push_file(tmp_path / "a.bundle", "/sdcard/a.bundle") is False
    assert adb.pull_file("/sdcard/a.bundle", tmp_path / "pulled" / "a.bundle") is False
    assert adb.list_dir("/sdcard") == [] and adb.file_exists("/sdcard/a.bundle") is False


def test_adb_runs_without_dev_mode(monkeypatch):
    from ba_modding_toolkit.adb import manager

    calls = []

    def run(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, "Android Debug Bridge version 1.0.41\n", "")

    monkeypatch.setattr(manager.subprocess, "run", run)
    assert manager.ADBManager("adb").detect_adb() == (True, "Android Debug Bridge version 1.0.41")
    assert calls == [["adb", "version"]]


@pytest.fixture
def installable_build(tmp_path, monkeypatch):
    """A writable macOS app bundle the updater could replace."""
    from ba_modding_toolkit import updater

    target = tmp_path / "Tool.app"
    executable = target / "Contents" / "MacOS" / "Tool"
    executable.parent.mkdir(parents=True)
    executable.touch()
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setattr(updater, "is_compiled", lambda: True)
    return target


def test_a_build_never_replaces_itself_in_dev_mode(installable_build, monkeypatch, tmp_path):
    from ba_modding_toolkit import updater
    from ba_modding_toolkit.errors import ServiceError

    assert updater.install_target() == installable_build
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(tmp_path))
    assert updater.install_target() is None
    started = []
    monkeypatch.setattr(updater.subprocess, "Popen", lambda *args, **kwargs: started.append(args))
    with pytest.raises(ServiceError) as caught:
        updater.install(tmp_path / "BAMPT-0.1.1-macos-arm64.dmg", "0" * 32)
    assert caught.value.code == "update_unsupported" and started == []


# --- builds ---

def test_builds_carry_the_hooks_version():
    marker = Path(ba_modding_toolkit.__file__).parent / "assets" / "dev-hooks.json"
    assert json.loads(marker.read_text(encoding="utf-8")) == {"hooks": devmode.HOOKS}

