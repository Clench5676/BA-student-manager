"""Owner review regressions for prefab metadata and verified camera geometry."""
from types import SimpleNamespace

from ba_modding_toolkit.gameassets.layouts import _widget


def test_prefab_pin_gradient_is_exported_without_changing_its_white_tint():
    obj = SimpleNamespace(assets_file=SimpleNamespace(name="fixture", externals=[]))
    tree = {"m_Script": {}, "mAtlas": {}, "mSpriteName": "Common_Icon_Pin_Detail", "mType": 1,
            "mFlip": 0, "mApplyGradient": 1, "mGradientTop": {"r": 1., "g": .5, "b": 0., "a": 1.},
            "mGradientBottom": {"r": .8, "g": .3, "b": 0., "a": 1.},
            "mColor": {"r": 1., "g": 1., "b": 1., "a": 1.}, "mWidth": 38, "mHeight": 38}
    widget = _widget(obj, tree, {}, {})
    assert widget["gradient"] == ["#ff8000/1.00", "#cc4c00/1.00"]
    assert widget["color"] == "#ffffff/1.00"
