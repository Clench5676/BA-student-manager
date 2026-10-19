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


def test_keys_in_the_file_never_run_game_detection(tmp_path: Path, monkeypatch):
    """A value read from the file is coerced by the field's type: the detection default runs only for a missing key."""
    from ba_modding_toolkit import config

    def detect(region="auto"):
        raise AssertionError("game detection ran")

    monkeypatch.setattr(config, "get_BA_path", detect)
    p = tmp_path / "config.toml"
    p.write_text('[Directories]\nfile_source = "windows_global"\ngame_resource_dir = "/games/ba"\n'
                 'game_resource_dir_japan = ""\n', encoding="utf-8")
    s = Settings(p)
    assert s.get("game_resource_dir") == "/games/ba"
    assert s.get("game_resource_dir_japan") == ""
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


def test_field_kinds():
    assert Field("G", True).kind is bool and Field("G", 4).kind is int and Field("G", "x").kind is str
    assert Field("G", lambda: "x", str).kind is str
    with pytest.raises(TypeError):
        Field("G", lambda: "x")
    for key, field in FIELDS.items():
        if not callable(field.default):
            assert field.kind is type(field.default), key
        assert field.kind in (bool, int, str), key
