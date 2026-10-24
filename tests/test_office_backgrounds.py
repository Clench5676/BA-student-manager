"""Office art retains the installed NGUI geometry and remains scoped to its real texture references."""

import copy
import json
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path
from threading import RLock
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gameassets import AssetCache, AssetNotFound, GameAssets
from ba_modding_toolkit.gameassets.cache import PreviewCache
from ba_modding_toolkit.gameassets import office
from ba_modding_toolkit.webui.student_hall import empty_hall, validate_hall

from test_webui import app, services, call, rpc


def node(name, children=(), widgets=(), **kwargs):
    return {"name": name, "active": True, "pos": [10, -20], "scale": [1.2, .8], "rotZ": 0,
            "widgets": list(widgets), "children": list(children), **kwargs}


@pytest.fixture
def installed(tmp_path, monkeypatch):
    paths = [tmp_path / spec[3] for spec in office.BACKGROUNDS.values()]
    texture_path = tmp_path / "uis-00_images-lobby-_mxload-2024-11-18_assets_all_1.bundle"
    unrelated = tmp_path / "uis-00_images-private-_mxload-2024-11-18_assets_all_2.bundle"
    paths += [texture_path, unrelated]
    for path in paths:
        path.write_bytes(b"fixture")
    record = {"bundle": texture_path.name, "path_id": 1}
    texture_names = {"DayFront": record, "NightFront": record, "UnusedPrivate": record}
    trees = {}
    for key, (root, branch, _, _) in office.BACKGROUNDS.items():
        front = node("Front", widgets=[{"cls": "UITexture", "texture": key.title() + "Front", "w_": 3160,
            "h_": 2220, "depth": 9, "pivot": 4, "color": "#ffffff/0.45"}])
        trees[root] = node(root, [node("Ancestor", [node(branch, [front]), node("Student")]), node("Dialog")])
    calls = []
    @contextmanager
    def bundle(path):
        calls.append(("bundle", path.name))
        roots = [spec[0] for spec in office.BACKGROUNDS.values() if spec[3] == path.name]
        yield SimpleNamespace(container={f"Assets/UI/{root}.prefab": None for root in roots}, objects=[])
    monkeypatch.setattr(office, "open_bundle", bundle)
    monkeypatch.setattr(office, "export_layout", lambda env, root, names: copy.deepcopy(trees[root]))
    def scan(selected):
        calls.append(("textures", [path.name for path in selected]))
        return {"textures": copy.deepcopy(texture_names), "names": {}}
    game = SimpleNamespace(_paths=lambda: list(paths), _lock=lambda key: RLock(), _indexes={}, _cab_index=lambda **kw: {},
        _scan_textures=scan, _texture_index=lambda: {"names": {}, "textures": {}})
    return SimpleNamespace(game=game, paths=paths, texture_path=texture_path, texture_names=texture_names,
                           trees=trees, calls=calls)


def test_office_inventory_scans_only_lobby_textures_and_preserves_original_geometry(installed):
    env = installed
    choices = office.choices(env.game)
    assert [choice["name"] for choice in choices] == ["office-day", "office-night"]
    assert env.calls[0] == ("textures", [env.texture_path.name])
    assert all("private" not in str(call) for call in env.calls)
    result = office.layout(env.game, "day")
    expected = copy.deepcopy(env.trees["LobbyCommon"])
    expected["children"] = expected["children"][:1]
    expected["children"][0]["children"] = expected["children"][0]["children"][:1]
    assert result["tree"] == expected
    assert set(result["textures"]) == {"DayFront"}
    assert result["textures"]["DayFront"].startswith("/asset/office/day/texture/DayFront.png?revision=")
    assert office.texture_record(env.game, "day", "DayFront")["bundle"] == env.texture_path.name
    with pytest.raises(AssetNotFound):
        office.texture_record(env.game, "day", "UnusedPrivate")
    with pytest.raises(AssetNotFound):
        office.texture_record(env.game, "../day", "DayFront")
    result["tree"]["children"].clear()
    assert office.layout(env.game, "day")["tree"]["children"]


def test_partial_install_omits_only_background_with_missing_required_texture(installed):
    del installed.texture_names["NightFront"]
    assert [choice["name"] for choice in office.choices(installed.game)] == ["office-day"]
    with pytest.raises(AssetNotFound):
        office.layout(installed.game, "night")


def test_install_without_lobby_textures_has_no_office_choice(installed):
    installed.paths.remove(installed.texture_path)
    assert office.choices(installed.game) == []
    assert installed.calls == []


def test_unreadable_lobby_texture_does_not_break_hall_background_options(installed):
    def fail(paths):
        raise ServiceError("asset_load_failed")
    installed.game._scan_textures = fail
    assert office.choices(installed.game) == []


def test_missing_office_prefab_keeps_available_day_background(installed):
    installed.paths[:] = [path for path in installed.paths if path.name != office.BACKGROUNDS["night"][3]]
    assert [choice["name"] for choice in office.choices(installed.game)] == ["office-day"]


def test_renamed_prefab_fallback_accepts_lowercase_container_paths(installed, monkeypatch):
    old = next(path for path in installed.paths if path.name == office.BACKGROUNDS["day"][3])
    replacement = old.with_name("ui-uilobbyelement-new-version.bundle")
    old.rename(replacement)
    installed.paths[installed.paths.index(old)] = replacement
    @contextmanager
    def bundle(path):
        root = "lobbycommon" if path == replacement else "lobbycommonnight"
        yield SimpleNamespace(container={f"assets/ui/{root}.prefab": None}, objects=[])
    monkeypatch.setattr(office, "open_bundle", bundle)
    assert [choice["name"] for choice in office.choices(installed.game)] == ["office-day", "office-night"]


def test_texture_revision_rebuilds_background_inventory(installed):
    office.choices(installed.game)
    url = office.layout(installed.game, "day")["textures"]["DayFront"]
    before = len(installed.calls)
    office.choices(installed.game)
    assert len(installed.calls) == before
    installed.texture_path.write_bytes(b"changed fixture revision")
    office.choices(installed.game)
    assert len(installed.calls) > before
    assert office.layout(installed.game, "day")["textures"]["DayFront"] != url


def test_changed_shared_layer_refreshes_only_its_required_bundle(installed):
    env = installed
    shared_path = env.paths[-1]
    record = {"bundle": shared_path.name, "path_id": 1}
    current = {"SharedHalo": dict(record)}
    front = env.trees["LobbyCommon"]["children"][0]["children"][0]["children"][0]
    front["widgets"].append({"texture": "SharedHalo"})
    env.game._texture_index = lambda: {"names": {}, "textures": {"SharedHalo": record}}
    scan = env.game._scan_textures
    refreshed = []
    def textures(paths):
        if paths == [shared_path]:
            refreshed.append(shared_path)
            return {"names": {}, "textures": copy.deepcopy(current)}
        return scan(paths)
    env.game._scan_textures = textures
    assert office.texture_record(env.game, "day", "SharedHalo")["path_id"] == 1
    current["SharedHalo"]["path_id"] = 2
    shared_path.write_bytes(b"updated shared texture revision")
    assert office.texture_record(env.game, "day", "SharedHalo")["path_id"] == 2
    assert refreshed == [shared_path]
    current.clear()
    shared_path.write_bytes(b"shared texture removed")
    assert [choice["name"] for choice in office.choices(env.game)] == ["office-night"]
    current["SharedHalo"] = record
    shared_path.write_bytes(b"shared texture restored")
    assert [choice["name"] for choice in office.choices(env.game)] == ["office-day", "office-night"]


def test_office_texture_is_lossless_and_honors_preview_cache_optout(tmp_path, monkeypatch):
    cache = AssetCache(root=tmp_path / "cache", allowed=True)
    preview = PreviewCache(tmp_path / "preview-cache", allowed=False)
    game = GameAssets([tmp_path], cache, preview_cache=preview)
    source = tmp_path / "texture.bundle"
    source.write_bytes(b"fixture")
    monkeypatch.setattr(office, "texture_record", lambda game, key, name: {"bundle": source.name})
    monkeypatch.setattr(game, "_bundle_path", lambda name: source)
    original = Image.new("RGBA", (1201, 733), (51, 107, 163, 77))
    monkeypatch.setattr(game, "_image", lambda record: original)
    image = Image.open(BytesIO(game.office_texture("day", "DayFront")))
    assert image.size == original.size and image.mode == "RGBA"
    assert image.tobytes() == original.tobytes()
    assert cache.memory_bytes > 0 and not cache.root.exists() and not preview.root.exists()


@pytest.mark.parametrize("name", ["office-day", "office-night"])
def test_hall_accepts_explicit_office_ids_only(name):
    hall = empty_hall()
    hall["background"] = name
    assert validate_hall(hall)["background"] == name
    hall["background"] = "office-unknown"
    with pytest.raises(ServiceError, match="bad_params"):
        validate_hall(hall)


def test_office_routes_keep_existing_ui_consent_and_read_only_endpoints(app, services, monkeypatch):
    monkeypatch.setattr(services.game, "office_layout", lambda key: {"tree": {"name": key}, "textures": {}}, raising=False)
    monkeypatch.setattr(services.game, "office_texture", lambda key, name: b"\x89PNG full-resolution", raising=False)
    status, headers, _ = call(app, "/asset/office/day/layout.json")
    assert status == "200 OK" and headers["Cache-Control"] == "no-store"
    services.state.set_consent(True)
    status, headers, body = call(app, "/asset/office/day/layout.json")
    assert status == "200 OK" and json.loads(body)["tree"]["name"] == "day"
    status, headers, body = call(app, "/asset/office/night/texture/NightFront.png")
    assert status == "200 OK" and body == b"\x89PNG full-resolution"
    assert headers["Content-Type"] == "image/png" and headers["Cache-Control"] == "no-store"


def test_hall_options_include_office_choices_and_retain_collection_fallback(app, services, installed, monkeypatch):
    monkeypatch.setattr(services.library, "mods", lambda: [])
    monkeypatch.setattr(services.game, "collection_names", lambda: {"bg": ["BG_Test_Collection"]}, raising=False)
    monkeypatch.setattr(services.game, "office_backgrounds", lambda: office.choices(installed.game), raising=False)
    result = rpc(app, "hall.options")
    assert "error" not in result, result
    assert [entry["name"] for entry in result["result"]["backgrounds"]] == ["office-day", "office-night", "BG_Test_Collection"]
    installed.paths.remove(installed.texture_path)
    result = rpc(app, "hall.options")["result"]
    assert result["backgrounds"] == [{"name": "BG_Test_Collection", "url": "/asset/art/bg/BG_Test_Collection"}]


def shader_form(src=5, dst=1, source_name="<noninit>"):
    field = lambda value, name="<noninit>": {"val": value, "name": name}
    blend = {"srcBlend": field(src, source_name), "destBlend": field(dst), "srcBlendAlpha": field(src),
             "destBlendAlpha": field(dst), "blendOp": field(0), "blendOpAlpha": field(0), "colMask": field(15)}
    return {"m_Name": "Unlit/Transparent Colored Additive", "m_SubShaders": [{"m_Passes": [{"m_State": {"rtBlend0": blend}}]}]}


def test_office_shader_fixed_blend_ignores_unused_material_properties():
    material = {"m_SavedProperties": {"m_Floats": [("_SrcBlend", 1), ("_DstBlend", 0), ("<noninit>", 9)]}}
    value = office.material_description(shader_form(), material)
    assert (value["src"], value["dst"], value["srcA"], value["dstA"]) == (5, 1, 5, 1)
    assert (value["op"], value["opA"], value["mask"]) == (0, 0, 15)
    assert office.material_description(shader_form(source_name="_SrcBlend"), material)["src"] == 1


def test_material_dependencies_invalidate_geometry_without_scanning_shader_as_texture(installed, monkeypatch):
    env = installed
    shader = env.paths[-1]
    description = office.material_description(shader_form())
    def annotate(game, path, tree):
        tree["widgets"].append({"material": copy.deepcopy(description)})
        return {shader}
    monkeypatch.setattr(office, "_add_materials", annotate)
    assert office.layout(env.game, "night")["tree"]["widgets"][-1]["material"]["dst"] == 1
    description["dst"] = 10
    shader.write_bytes(b"shader changed")
    assert office.layout(env.game, "night")["tree"]["widgets"][-1]["material"]["dst"] == 10
    assert all(shader.name not in call[1] for call in env.calls if call[0] == "textures")


def test_ui_texture_uses_material_shader_override_instead_of_default_shader(installed, monkeypatch):
    from ba_modding_toolkit.gameassets import model
    def obj(pid, kind, data):
        return SimpleNamespace(path_id=pid, type=SimpleNamespace(name=kind), data=data)
    root = obj(1, "GameObject", {"m_Name": "Root"})
    light = obj(2, "GameObject", {"m_Name": "Light"})
    root_transform = obj(11, "Transform", {"m_GameObject": {"m_PathID": 1}, "m_Father": {"m_PathID": 0}})
    light_transform = obj(12, "Transform", {"m_GameObject": {"m_PathID": 2}, "m_Father": {"m_PathID": 11}})
    ui = obj(3, "MonoBehaviour", {"m_GameObject": {"m_PathID": 2}, "mTexture": {}, "mWidth": 100,
        "mMat": {"m_PathID": 4}, "mShader": {"m_PathID": 5}})
    material = obj(4, "Material", {"m_Shader": {"m_PathID": 6}, "m_SavedProperties": {"m_Floats": [("_SrcBlend", 1)]}})
    default = obj(5, "Shader", {"m_ParsedForm": shader_form(dst=10)})
    additive = obj(6, "Shader", {"m_ParsedForm": shader_form()})
    pointers = {o.path_id: o for o in (material, default, additive)}
    path = installed.paths[0]
    class Graph:
        loaded = [str(path), str(installed.paths[-1])]
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def add(self, path): return SimpleNamespace(objects=[root, light, root_transform, light_transform, ui])
        def tree(self, value): return value.data
        def deref(self, owner, pointer): return pointers.get((pointer or {}).get("m_PathID"))
    monkeypatch.setattr(model, "BundleGraph", Graph)
    tree = node("Root", [node("Light", widgets=[{"texture": "Light"}])])
    assert office._add_materials(installed.game, path, tree) == {installed.paths[-1]}
    assert tree["children"][0]["widgets"][0]["material"]["dst"] == 1
