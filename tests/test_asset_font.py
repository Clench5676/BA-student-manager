"""The upstream Font path retains target metrics and the fork's complete-update checks."""
from copy import deepcopy
from types import SimpleNamespace

from ba_modding_toolkit import core
from ba_modding_toolkit.asset import ApplyContext, apply_asset
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.models import AssetType, FontAssetData, SaveOptions


def font(data, names, spacing):
    tree = {"m_Name": "shared-font", "m_FontData": data, "m_FontNames": names,
            "m_LineSpacing": spacing, "m_CharacterInfo": [{"index": 1}], "m_CharacterRects": [1]}
    def save(value):
        tree.clear(); tree.update(deepcopy(value))
    return SimpleNamespace(type=AssetType.Font, peek_name=lambda: tree["m_Name"],
        read=lambda: SimpleNamespace(**tree), read_typetree=lambda: deepcopy(tree), save_typetree=save,
        get_raw_data=lambda: repr(tree).encode()), tree


def test_font_update_moves_only_payload_and_names_and_preserves_target_metrics(tmp_path, monkeypatch):
    incoming, _ = font(b"new-font", ["New family"], 4)
    target, target_tree = font(b"old-font", ["Old family"], 27)
    source_path, target_path = tmp_path / "source.bundle", tmp_path / "target.bundle"
    bundles = {path: Bundle(path, SimpleNamespace(objects=[obj], file=SimpleNamespace(files={})))
               for path, obj in ((source_path, incoming), (target_path, target))}
    saves = []
    monkeypatch.setattr(Bundle, "load", lambda path, *args: bundles[path])
    monkeypatch.setattr(Bundle, "save", lambda *args: (saves.append(args) or True, "saved"))
    result = core.process_mod_update([source_path], [target_path], tmp_path / "output", {"Font"},
                                     SaveOptions(), match_strategy="name_type")
    assert result.success and len(result.file_pairs) == 1 and len(saves) == 1
    assert target_tree["m_FontData"] == b"new-font" and target_tree["m_FontNames"] == ["New family"]
    assert target_tree["m_LineSpacing"] == 27
    assert target_tree["m_CharacterInfo"] == [] and target_tree["m_CharacterRects"] == []


def test_equal_font_payload_skips_without_clearing_existing_target_metadata():
    target, tree = font(b"font", ["Family"], 19)
    before = deepcopy(tree)
    result = apply_asset(target, FontAssetData(b"font", ["Family"]), ApplyContext(None, None, lambda message: None))
    assert not result.applied and tree == before


def test_bundle_application_deserializes_the_matching_model_only_once(tmp_path):
    obj, tree = font(b"old", ["Old"], 17)
    original = obj.read
    calls = []
    obj.read = lambda: (calls.append(1), original())[1]
    bundle = Bundle(tmp_path / "target.bundle", SimpleNamespace(objects=[obj], file=SimpleNamespace(files={})))
    result = bundle.apply_patch({("shared-font", "Font"): FontAssetData(b"new", ["New"])}, "name_type")
    assert result.applied_count == 1 and len(calls) == 1
    assert tree["m_LineSpacing"] == 17
