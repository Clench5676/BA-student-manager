"""Update requirements are scoped to counterparts in the new official release."""

from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.core import process_mod_update
from ba_modding_toolkit.models import AssetType, SaveOptions

from tests.test_core.test_update_failures import asset, bundle


@pytest.mark.parametrize("obsolete_kind", [AssetType.TextAsset, AssetType.Texture2D])
def test_obsolete_asset_is_skipped_and_reported(tmp_path, monkeypatch, obsolete_kind):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    obsolete = asset("obsolete", obsolete_kind, "extract" if obsolete_kind == AssetType.Texture2D else None)
    bundles = {source: bundle(source, [asset("note", AssetType.TextAsset), obsolete]),
               target: bundle(target, [asset("note", AssetType.TextAsset, payload=b"official")])}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"ALL"}, SaveOptions(), match_strategy="name_type")
    assert result.success, result.message
    assert result.file_pairs and saved
    assert any("obsolete" in str(key) for key in result.not_transferred)


@pytest.mark.parametrize("difference", [None, "raw", "stream", "missing_stream"])
def test_unreadable_texture_compares_raw_and_stream_bytes(tmp_path, monkeypatch, difference):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    incoming = asset("page", AssetType.Texture2D, "extract")
    official = asset("page", AssetType.Texture2D, "extract")
    raw = b"archive:/CAB-stream/CAB-stream.resS"
    incoming.get_raw_data = lambda: raw + (b"changed" if difference == "raw" else b"")
    official.get_raw_data = lambda: raw
    bundles = {source: bundle(source, [asset("note", AssetType.TextAsset), incoming]),
               target: bundle(target, [asset("note", AssetType.TextAsset, payload=b"official"), official])}
    bundles[source].env.file.files["CAB-stream.resS"] = SimpleNamespace(
        bytes=b"mod pixels" if difference == "stream" else b"stock pixels")
    bundles[target].env.file.files["CAB-stream.resS"] = SimpleNamespace(bytes=b"stock pixels")
    if difference == "missing_stream":
        bundles[source].env.file.files.clear()
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"Texture2D", "TextAsset"},
                                SaveOptions(), match_strategy="name_type")
    assert result.success is (difference is None), result.message
    if difference is None:
        assert result.file_pairs and saved
    else:
        assert not result.file_pairs and not saved
        assert result.error.code == "required_asset_extract_failed"
        assert result.error.params["name"] == "page"


def test_missing_counterparts_still_require_a_nonempty_match(tmp_path, monkeypatch):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    bundles = {source: bundle(source, [asset("obsolete", AssetType.TextAsset)]),
               target: bundle(target, [asset("new", AssetType.TextAsset)])}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"TextAsset"}, SaveOptions(), match_strategy="name_type")
    assert not result.success and not result.file_pairs and not saved


@pytest.mark.parametrize("changed_range", [False, True])
def test_stream_comparison_uses_only_the_assets_own_range(tmp_path, monkeypatch, changed_range):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    incoming = asset("page", AssetType.Texture2D, "extract")
    official = asset("page", AssetType.Texture2D, "extract")
    for obj in (incoming, official):
        data = obj.read()
        data.m_StreamData = SimpleNamespace(path="archive:/CAB-stream/CAB-stream.resS", offset=2, size=5)
        obj.read = lambda data=data: data
        obj.get_raw_data = lambda: b"archive:/CAB-stream/CAB-stream.resS"
    bundles = {source: bundle(source, [incoming]), target: bundle(target, [official])}
    bundles[source].env.file.files["CAB-stream.resS"] = SimpleNamespace(
        bytes=b"XX" + (b"mod!!" if changed_range else b"stock") + b"unrelated change")
    bundles[target].env.file.files["CAB-stream.resS"] = SimpleNamespace(bytes=b"YYstockother asset")
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"Texture2D"}, SaveOptions(),
                                match_strategy="name_type", skip_unchanged=True)
    assert result.success is not changed_range
    if changed_range:
        assert result.error.code == "required_asset_extract_failed"
    else:
        assert result.message == "all_targets_unchanged" and not result.file_pairs


@pytest.mark.parametrize("skip_unchanged", [False, True])
def test_identical_unreadable_asset_counts_as_a_match(tmp_path, monkeypatch, skip_unchanged):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    objects = [asset("page", AssetType.Texture2D, "extract") for _ in range(2)]
    for obj in objects:
        obj.get_raw_data = lambda: b"stock texture"
    bundles = {path: bundle(path, [obj]) for path, obj in zip((source, target), objects)}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"Texture2D"}, SaveOptions(),
                                match_strategy="name_type", skip_unchanged=skip_unchanged)
    assert result.success
    assert bool(result.file_pairs) is not skip_unchanged
    assert bool(saved) is not skip_unchanged


def test_unreadable_asset_must_match_every_counterpart(tmp_path, monkeypatch):
    source, first, second = [tmp_path / name for name in ("mod.bundle", "first.bundle", "second.bundle")]
    incoming, stock, changed = [asset("page", AssetType.Texture2D, "extract") for _ in range(3)]
    incoming.get_raw_data = stock.get_raw_data = lambda: b"same texture"
    changed.get_raw_data = lambda: b"different texture"
    bundles = {path: bundle(path, [obj]) for path, obj in zip((source, first, second), (incoming, stock, changed))}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [first, second], tmp_path, {"Texture2D"}, SaveOptions(),
                                match_strategy="name_type")
    assert not result.success and not result.file_pairs and not saved
    assert result.error.code == "required_asset_extract_failed"
