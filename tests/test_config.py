"""Tests for the Tk-free settings in ba_modding_toolkit.config."""

from pathlib import Path

import pytest
import toml

from ba_modding_toolkit.config import FIELDS, Field, Settings


def test_defaults_when_file_missing(tmp_path: Path):
    s = Settings(tmp_path / "config.toml")
    assert s.get("max_workers") == 4
    assert s.get("enable_crc_correction") == "auto"
    assert s.get("skip_unchanged") is True


def test_values_are_coerced_to_the_default_type(tmp_path: Path):
    p = tmp_path / "config.toml"
    p.write_text('[SaveOptions]\nskip_unchanged = "false"\n[AppSettings]\nmax_workers = "6"\n', encoding="utf-8")
    s = Settings(p)
    assert s.get("skip_unchanged") is False
    assert s.get("max_workers") == 6


def test_save_keeps_unknown_keys_and_uses_classic_groups(tmp_path: Path):
    p = tmp_path / "config.toml"
    p.write_text('[Custom]\nx = 1\n[SaveOptions]\nfuture_option = "y"\n', encoding="utf-8")
    s = Settings(p)
    s.set("compression_method", "lz4")
    s.save()
    data = toml.loads(p.read_text(encoding="utf-8"))
    assert data["Custom"] == {"x": 1}
    assert data["SaveOptions"]["future_option"] == "y"
    assert data["SaveOptions"]["compression_method"] == "lz4"
    for key, field in FIELDS.items():
        assert key in data[field.group]


def test_reload_if_changed_notifies(tmp_path: Path):
    p = tmp_path / "config.toml"
    s = Settings(p)
    s.save()
    seen = []
    s.on_change(lambda: seen.append(True))
    assert s.reload_if_changed() is False
    p.write_text('[AppSettings]\nmax_workers = 2\n', encoding="utf-8")
    import os
    st = p.stat()
    os.utime(p, (st.st_atime, st.st_mtime + 5))
    assert s.reload_if_changed() is True
    assert s.get("max_workers") == 2
    assert seen == [True]


def test_asset_types(tmp_path: Path):
    s = Settings(tmp_path / "config.toml")
    assert s.asset_types() == {"Texture2D", "TextAsset", "Mesh", "AnimationClip"}
    s.set("replace_all", True)
    assert s.asset_types() == {"ALL"}


def test_explicit_directory_pair_never_runs_game_detection(tmp_path: Path, monkeypatch):
    """A value read from the file is coerced by the field's type: the detection default runs only for a missing key."""
    from ba_modding_toolkit import config

    def detect(region="auto"):
        raise AssertionError("game detection ran")

    monkeypatch.setattr(config, "get_BA_path", detect)
    p = tmp_path / "config.toml"
    p.write_text('[Directories]\nfile_source = "windows_global"\ngame_resource_dir = "/games/ba"\n'
                 'game_resource_dir_japan = "/games/japan"\n', encoding="utf-8")
    s = Settings(p)
    assert s.get("game_resource_dir") == "/games/ba"
    assert s.get("game_resource_dir_japan") == "/games/japan"
    s.set("game_resource_dir", Path("/games/other"))
    assert s.get("game_resource_dir") == "/games/other"
    s.set("file_source", "windows_japan")
    assert s.get("file_source") == "windows_japan"


def test_a_missing_key_still_runs_its_default(tmp_path: Path, monkeypatch):
    from ba_modding_toolkit import config

    monkeypatch.setattr(config, "get_BA_path", lambda region="auto": "/found" if region == "global" else None)
    s = Settings(tmp_path / "config.toml")
    assert s.get("game_resource_dir") == "/found"
    assert s.get("game_resource_dir_japan") == ""
    assert s.get("file_source") == "windows_global"


@pytest.mark.parametrize("found", [None, "global", "japan"])
def test_each_install_is_detected_at_most_once_per_settings_load(tmp_path, monkeypatch, found):
    calls = []

    def detect(region):
        calls.append(region)
        return f"/games/{region}" if region == found else None

    monkeypatch.setattr("ba_modding_toolkit.config.get_BA_path", detect)
    settings = Settings(tmp_path / "config.toml")
    assert calls == ["global", "japan"]
    assert settings.get("file_source") == ("windows_japan" if found == "japan" else "windows_global")
    settings.load()
    assert calls == ["global", "japan", "global", "japan"]


def test_field_kinds():
    assert Field("G", True).kind is bool and Field("G", 4).kind is int and Field("G", "x").kind is str
    assert Field("G", lambda: "x", str).kind is str
    with pytest.raises(TypeError):
        Field("G", lambda: "x")
    for key, field in FIELDS.items():
        if not callable(field.default):
            assert field.kind is type(field.default), key
        assert field.kind in (bool, int, str), key


@pytest.mark.parametrize("identified", ["global", "japan", "unknown", "ambiguous"])
@pytest.mark.parametrize("japan_key", [False, True])
def test_legacy_directory_migration_is_lossless_and_idempotent(tmp_path, monkeypatch, identified, japan_key):
    install = tmp_path / "install"
    resources = install / "GameData" / "Windows"
    resources.mkdir(parents=True)
    monkeypatch.setattr("ba_modding_toolkit.config.get_BA_path", lambda region:
                        str(install) if identified in (region, "ambiguous") else None)
    path = tmp_path / "config.toml"
    dirs = {"game_resource_dir": str(resources), "file_source": "windows_global", "future": "kept"}
    if japan_key:
        dirs["game_resource_dir_japan"] = ""
    path.write_text(toml.dumps({"Directories": dirs}))
    original = path.read_bytes()
    settings = Settings(path)
    # Loading does not write the file; saving retains keys understood by previous versions.
    assert path.read_bytes() == original
    region = "japan" if identified == "japan" else "global"
    assert settings.game_dir(region) == resources
    assert settings.get("file_source") == "windows_global"
    if region == "japan":
        assert settings.game_dir("global") is None
    settings.save()
    saved = toml.loads(path.read_text())["Directories"]
    assert saved["future"] == "kept"
    assert str(resources) in (saved["game_resource_dir"], saved["game_resource_dir_japan"])
    assert Settings(path).as_dict() == settings.as_dict()


def test_migration_keeps_two_explicit_folders_and_classic_uses_same_rule(tmp_path, monkeypatch):
    from ba_modding_toolkit.gui.configs import ConfigManager, ConfigMeta
    from types import SimpleNamespace

    legacy = tmp_path / "japan"
    legacy.mkdir()
    monkeypatch.setattr("ba_modding_toolkit.gui.configs.get_BA_path", lambda region: str(legacy) if region == "japan" else None)
    path = tmp_path / "config.toml"
    path.write_text(toml.dumps({"Directories": {"game_resource_dir": str(legacy)}}))
    class Variable:
        def set(self, value):
            self.value = value
    app = SimpleNamespace(_config_specs={key + "_var": ConfigMeta("Directories", "")
                          for key in ("game_resource_dir", "game_resource_dir_japan")},
                          game_resource_dir_var=Variable(), game_resource_dir_japan_var=Variable())
    assert ConfigManager(path).load_config(app)
    assert app.game_resource_dir_var.value == ""
    assert app.game_resource_dir_japan_var.value == str(legacy)


@pytest.mark.parametrize("source,region", [("windows_global", "global"), ("windows_japan", "japan")])
def test_selected_server_resolution_never_falls_back(tmp_path, source, region):
    settings = Settings(tmp_path / "config.toml")
    for name in ("global", "japan"):
        folder = tmp_path / name
        folder.mkdir()
        settings.set("game_resource_dir" + ("_japan" if name == "japan" else ""), str(folder))
    settings.set("file_source", source)
    assert settings.game_dir() == tmp_path / region
    assert settings.resource_dirs() == [tmp_path / region]
    settings.set("game_resource_dir" + ("_japan" if region == "japan" else ""), "")
    assert settings.game_dir() is None and settings.resource_dirs() == []
    settings.set("file_source", "adb_" + region)
    assert settings.game_dir() is None
