"""Tests for the Tk-free settings in ba_modding_toolkit.config."""

from pathlib import Path

import toml

from ba_modding_toolkit.config import FIELDS, Settings


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
