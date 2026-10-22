"""Required Mod assets must survive extraction and application as a complete set."""
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.core import process_mod_update
from ba_modding_toolkit.models import AssetType, SaveOptions


def asset(name, kind, failure=None, payload=b"mod"):
    class Data:
        m_Name = name
        m_Script = payload.decode()

        @property
        def image(self):
            if failure == "extract":
                raise ValueError("texture decode failed")
            return Image.new("RGBA", (1, 1))

        @image.setter
        def image(self, value):
            pass

        def save(self):
            if failure == "apply":
                raise ValueError("asset write failed")

    def read():
        if failure == "read":
            raise ValueError("asset read failed")
        return Data()

    def raw():
        if failure == "extract":
            return b"archive:/CAB-missing/CAB-missing.resS"
        return payload

    return SimpleNamespace(type=kind, peek_name=lambda: name, read=read, get_raw_data=raw,
                           set_raw_data=lambda value: None)


def bundle(path, objects):
    return Bundle(path, SimpleNamespace(objects=objects, file=SimpleNamespace(files={})))


@pytest.mark.parametrize("kind,failure", [(AssetType.Texture2D, "extract"), (AssetType.Mesh, "extract"),
    (AssetType.TextAsset, "read"), (AssetType.Texture2D, "read")])
def test_update_rejects_partial_extraction(tmp_path, monkeypatch, kind, failure):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    broken = "required.atlas" if kind == AssetType.TextAsset else "required"
    bundles = {source: bundle(source, [asset("note", AssetType.TextAsset), asset(broken, kind, failure)]),
               target: bundle(target, [asset("note", AssetType.TextAsset, payload=b"official"),
                                       asset(broken, kind, payload=b"official")])}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"ALL"}, SaveOptions(), match_strategy="name_type")
    assert not result.success
    assert not result.file_pairs and not saved
    assert broken in result.message


def test_update_rejects_partial_application_before_saving(tmp_path, monkeypatch):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    bundles = {source: bundle(source, [asset(name, AssetType.TextAsset) for name in ("note", "required.atlas")]),
               target: bundle(target, [asset("note", AssetType.TextAsset, payload=b"official"),
                                       asset("required.atlas", AssetType.TextAsset, "apply", b"official")])}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"TextAsset"}, SaveOptions(), match_strategy="name_type")
    assert not result.success
    assert not result.file_pairs and not saved
    assert "required.atlas" in result.message


@pytest.mark.parametrize("split", [False, True])
def test_every_required_key_must_be_applied_across_targets(tmp_path, monkeypatch, split):
    source, first, second = [tmp_path / name for name in ("mod.bundle", "first.bundle", "second.bundle")]
    bundles = {source: bundle(source, [asset(name, AssetType.TextAsset) for name in ("note", "required.atlas")]),
               first: bundle(first, [asset("note", AssetType.TextAsset, payload=b"official")]),
               second: bundle(second, [asset("required.atlas", AssetType.TextAsset, payload=b"official")])}
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [first, second] if split else [first], tmp_path,
                                {"ALL"}, SaveOptions(), match_strategy="name_type")
    assert result.success and saved
    assert len(result.file_pairs) == (2 if split else 1)
    assert result.not_transferred == ([] if split else ["[TextAsset] required.atlas"])


def test_extraction_rejects_a_truncated_mesh_stream(tmp_path):
    from ba_modding_toolkit.errors import ServiceError
    obj = asset("required_mesh", AssetType.Mesh)
    obj.read = lambda: SimpleNamespace(m_Name="required_mesh", m_StreamData=SimpleNamespace(
        path="archive:/CAB-stream/CAB-stream.resS", offset=2, size=8))
    obj.get_raw_data = lambda: b"archive:/CAB-stream/CAB-stream.resS"
    source = bundle(tmp_path / "mod.bundle", [obj])
    source.env.file.files["CAB-stream.resS"] = SimpleNamespace(bytes=b"short")
    with pytest.raises(ServiceError) as caught:
        source.extract_patch({"Mesh"}, "name_type")
    assert caught.value.code == "required_asset_extract_failed"
    assert caught.value.params["name"] == "required_mesh"


@pytest.mark.parametrize("changed_obsolete", [False, True])
@pytest.mark.parametrize("strategy", ["name_type", "cont_name_type", "path_id"])
def test_update_skips_obsolete_assets_without_an_own_release_baseline(
        tmp_path, monkeypatch, changed_obsolete, strategy):
    original, target = tmp_path / "mod.bundle", tmp_path / "new.bundle"
    bundles = {
        original: bundle(original, [asset("A", AssetType.TextAsset, payload=b"changed A"),
                                    asset("B", AssetType.TextAsset,
                                          payload=b"changed B" if changed_obsolete else b"stock B")]),
        target: bundle(target, [asset("A", AssetType.TextAsset, payload=b"new A")]),
    }
    for item in bundles.values():
        for index, obj in enumerate(item.env.objects, 1):
            obj.path_id = index
            obj.container = "container"
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([original], [target], tmp_path / "output", {"TextAsset"},
                                SaveOptions(), match_strategy=strategy)
    assert result.success and result.file_pairs and saved, result.message
    assert len(result.not_transferred) == 1
    assert result.not_transferred[0] in result.message


@pytest.mark.parametrize("stream", [False, True])
@pytest.mark.parametrize("changed", [False, True])
def test_undecodable_texture_is_optional_only_when_serialized_content_matches(tmp_path, monkeypatch, stream, changed):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    incoming = asset("stock_texture", AssetType.Texture2D, "extract")
    official = asset("stock_texture", AssetType.Texture2D, "extract")
    raw = b"texture metadata" + (b" CAB-stream.resS" if stream else b"")
    incoming.get_raw_data = lambda: raw + (b" changed" if changed and not stream else b"")
    official.get_raw_data = lambda: raw
    bundles = {source: bundle(source, [asset("note", AssetType.TextAsset), incoming]),
               target: bundle(target, [asset("note", AssetType.TextAsset, payload=b"official"), official])}
    if stream:
        for path in (source, target):
            bundles[path].env.file.files["CAB-stream.resS"] = SimpleNamespace(
                bytes=b"changed pixels" if changed and path == source else b"stock pixels")
    saved = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saved.append(args) or True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"ALL"}, SaveOptions(), match_strategy="name_type")
    assert result.success is not changed
    assert bool(saved) is not changed
    if changed:
        assert result.error.code == "required_asset_extract_failed"
    else:
        assert result.file_pairs and not result.not_transferred


@pytest.mark.parametrize("unreadable", [False, True])
def test_update_skips_removed_assets_and_reports_them(tmp_path, monkeypatch, unreadable):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    removed = asset("obsolete_stock", AssetType.Texture2D if unreadable else AssetType.TextAsset,
                    "extract" if unreadable else None)
    bundles = {source: bundle(source, [asset("note", AssetType.TextAsset), removed]),
               target: bundle(target, [asset("note", AssetType.TextAsset, payload=b"official")])}
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (True, "saved"))
    result = process_mod_update([source], [target], tmp_path, {"ALL"}, SaveOptions(), match_strategy="name_type")
    assert result.success and result.file_pairs
    assert any("obsolete_stock" in key for key in result.not_transferred)
    assert "obsolete_stock" in result.message


def test_update_still_requires_a_nonempty_match(tmp_path, monkeypatch):
    source, target = tmp_path / "mod.bundle", tmp_path / "official.bundle"
    bundles = {source: bundle(source, [asset("obsolete_stock", AssetType.TextAsset)]),
               target: bundle(target, [asset("unrelated", AssetType.TextAsset)])}
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    result = process_mod_update([source], [target], tmp_path, {"ALL"}, SaveOptions(), match_strategy="name_type")
    assert not result.success and not result.file_pairs
