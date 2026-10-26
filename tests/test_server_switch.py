"""Server selection uses isolated folders and never changes Hall data or game bytes."""
import json
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.catalog import Catalog, Variant
from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.webui.photography import Photography
from ba_modding_toolkit.webui.student_hall import empty_hall
from test_webui import app, services, rpc
from test_library import setup_library, game_bundle, make_mod


def test_missing_japanese_folder_keeps_global_and_hall_then_recovers(app, services, tmp_path, monkeypatch):
    settings = services.settings
    global_dir = tmp_path / 'global'; global_dir.mkdir()
    settings.set('file_source', 'windows_global')
    settings.set('game_resource_dir', str(global_dir))
    settings.set('game_resource_dir_japan', '')
    settings.save()
    from uuid import uuid4
    hall = empty_hall(); hall['background'] = 'office-night'
    hall['portraits'] = [{'id': str(uuid4()), 'variant': 'hoshino', 'source': 'mod:m1', 'x': 400, 'y': 980, 'scale': 1, 'mirror': False}]
    hall['memorials'] = [{'id': str(uuid4()), 'variant': 'hoshino', 'source': 'mod:m1'}]
    hall['active'] = hall['memorials'][0]['id']
    services.state.set('student_hall', hall)
    before = services.state.path.read_bytes(), settings.path.read_bytes()
    changes = []
    monkeypatch.setattr(services, 'reload_game', lambda: changes.append(settings.server_region()))
    result = rpc(app, 'settings.set', key='fileSource', value='windows_japan')
    assert result['error']['code'] == 'game_directory_missing'
    assert result['error']['params'] == {'region': 'japan'}
    assert settings.get('file_source') == 'windows_global'
    assert before == (services.state.path.read_bytes(), settings.path.read_bytes())
    assert not changes and not services.library.applied
    assert rpc(app, 'hall.get')['result'] == hall
    japan = tmp_path / 'japan'; japan.mkdir()
    game_bytes = japan / 'sentinel.bundle'; game_bytes.write_bytes(b'never write game files')
    assert 'result' in rpc(app, 'settings.set', key='gameDir.japan', value=str(japan))
    assert 'result' in rpc(app, 'settings.set', key='fileSource', value='windows_japan')
    assert settings.server_region() == 'japan'
    assert 'result' in rpc(app, 'settings.set', key='fileSource', value='windows_global')
    assert rpc(app, 'hall.get')['result'] == hall
    assert json.loads(services.state.path.read_bytes())['prefs']['student_hall'] == hall
    assert game_bytes.read_bytes() == b'never write game files'
    assert not services.library.applied


def test_missing_resources_have_an_actionable_hall_error(app, services, monkeypatch):
    monkeypatch.setattr(services, 'game_found', lambda: False)
    assert rpc(app, 'hall.options')['error']['code'] == 'game_directory_missing'


def test_absent_catalog_model_record_has_complete_names_for_display(tmp_path):
    # Before this fix this exact fallback produced the owner's SimpleNamespace.names error.
    catalog = Catalog(None, None, server='japan')
    library = ModLibrary(tmp_path / 'library', catalog)
    key = 'unlisted_npc'
    library._records['npc'] = {'id': 'npc', 'kind': 'model', 'target': key,
                              'files': [f'character-{key}-_mxload-2026-01-01_000_assets_all_1.bundle']}
    record = library.variant_metadata(key)
    assert isinstance(record, Variant)
    assert all(value['full'] == key for value in record.names.values())
    result = Photography(SimpleNamespace(catalog=catalog, library=library)).describe({'photos': [{'variant': key}]})
    assert result['photos'][0]['names'] == record.names


def test_saved_model_target_uses_offline_student_metadata(tmp_path):
    catalog = Catalog(None, None, server='japan')
    library = ModLibrary(tmp_path / 'library', catalog)
    library._records['model'] = {'id': 'model', 'kind': 'model', 'target': 'shiroko',
        'files': ['character-shiroko-_mxload-2026-01-01_000_assets_all_1.bundle']}
    value = library.variant_metadata('shiroko')
    assert value.names == catalog.assignment_variant('shiroko').names
    assert value.spr is None and value.lobby is None


def test_retained_photograph_store_resolves_the_selected_catalog(services):
    services._catalog = SimpleNamespace(variant=lambda key: SimpleNamespace(family="global-family"))
    photographs = services.photographs
    assert photographs.family("student") == "global-family"
    services._catalog = SimpleNamespace(variant=lambda key: SimpleNamespace(family="japan-family"))
    assert services.photographs is photographs
    assert photographs.family("student") == "japan-family"


def test_server_switch_cannot_reuse_a_catalog_retained_by_an_active_task(app, services, tmp_path, monkeypatch):
    folder = tmp_path / 'japan'; folder.mkdir()
    services.settings.set('file_source', 'windows_global')
    services.settings.set('game_resource_dir_japan', str(folder))
    services.settings.save()
    before = services.settings.path.read_bytes()
    monkeypatch.setattr(services.jobs, 'busy', lambda *args: True)
    assert rpc(app, 'settings.set', key='fileSource', value='windows_japan')['error']['code'] == 'busy'
    assert services.settings.path.read_bytes() == before


@pytest.mark.parametrize("missing", ["unset", "deleted", "file"])
def test_missing_global_directory_preserves_japan_and_preferences(app, services, tmp_path, monkeypatch, missing):
    settings = services.settings
    japan = tmp_path / "japan"
    japan.mkdir()
    folder = tmp_path / "global"
    if missing == "file":
        folder.write_bytes(b"not a directory")
    settings.set("game_resource_dir", "" if missing == "unset" else str(folder))
    settings.set("game_resource_dir_japan", str(japan))
    settings.set("file_source", "windows_japan")
    settings.save()
    before = settings.path.read_bytes()
    monkeypatch.setattr(services, "reload_game", lambda: pytest.fail("missing folder must not refresh"))
    assert rpc(app, "settings.set", key="fileSource", value="windows_global")["error"] == {
        "code": "game_directory_missing", "params": {"region": "global"}}
    assert settings.get("file_source") == "windows_japan"
    assert settings.path.read_bytes() == before


def test_directory_change_cannot_retarget_an_active_writer(app, services, tmp_path, monkeypatch):
    folder = tmp_path / "new"
    folder.mkdir()
    services.settings.save()
    before = services.settings.path.read_bytes()
    monkeypatch.setattr(services.jobs, "busy", lambda *args: True)
    assert rpc(app, "settings.set", key="gameDir.global", value=str(folder))["error"]["code"] == "busy"
    assert services.settings.path.read_bytes() == before


def test_apply_and_restore_use_selected_install_and_preserve_other_choices(setup_library):
    env = setup_library
    japan = env.tmp / "japan"
    japanese_file = game_bundle(japan)
    japanese_original = japanese_file.read_bytes()
    global_original = env.original.read_bytes()
    env.settings.set("game_resource_dir_japan", str(japan))
    entry, = env.library.add([make_mod(env.original, env.tmp / "upload")])
    env.library.apply("test", f"mod:{entry.id}")
    global_applied = env.original.read_bytes()
    assert global_applied != global_original and japanese_file.read_bytes() == japanese_original
    env.settings.set("file_source", "windows_japan")
    assert env.library.current_pin().root == japan
    assert env.library.current_pin().server == "japan"
    assert env.library.configured("test")["spr"] is None
    env.library.apply("test", f"mod:{entry.id}")
    assert japanese_file.read_bytes() != japanese_original
    assert env.original.read_bytes() == global_applied
    env.library.restore("test")
    assert japanese_file.read_bytes() == japanese_original
    assert env.original.read_bytes() == global_applied
    env.settings.set("file_source", "windows_global")
    assert env.library.configured("test")["spr"] == f"mod:{entry.id}"
    env.library.restore("test")
    assert env.original.read_bytes() == global_original


def test_switch_rebuilds_game_library_catalog_and_cab_index(tmp_path, monkeypatch):
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.webui.services import Services
    from ba_modding_toolkit.webui.api import build_api
    from ba_modding_toolkit.webui.server import WebApp
    from test_cab_discovery import bundle

    settings = Settings(tmp_path / "config.toml")
    settings.set("bacii_map_path", str(tmp_path / "missing.csv"))
    paths = {}
    for region in ("global", "japan"):
        folder = tmp_path / region
        folder.mkdir()
        paths[region] = bundle(folder, "same.bundle", "CAB-SHARED")
        settings.set("game_resource_dir" + ("_japan" if region == "japan" else ""), str(folder))
    settings.save()
    services = Services(settings, tmp_path)
    monkeypatch.setattr(services, "refresh_status", lambda: None)
    monkeypatch.setattr(services, "request_scan", lambda: None)
    app = WebApp(build_api(services), services.events, token="tok")
    try:
        old_game, old_library, old_catalog = services.game, services.library, services.catalog
        services.set_consent(True)
        old_game._cached("server-ui", lambda: b"global")
        assert services.ui_cached()
        preview = services.preview_cache
        preview.allowed = True
        generation = preview.generation
        assert preview.put("preserved", b"saved preview", generation=generation)
        old_context = rpc(app, "app.info")["result"]["resourceContext"]
        assert old_game._cab_index(everything=True) == {"cab-shared": str(paths["global"])}
        before = {key: path.read_bytes() for key, path in paths.items()}
        assert "result" in rpc(app, "settings.set", key="fileSource", value="windows_japan")
        assert services.game is not old_game and services.library is not old_library and services.catalog is not old_catalog
        assert services.game.resource_version == old_game.resource_version
        assert services.game.cache_version != old_game.cache_version
        assert not services.ui_cached()
        assert rpc(app, "app.info")["result"]["resourceContext"] != old_context
        assert preview.generation != generation
        assert preview.get("preserved") == b"saved preview"
        assert rpc(app, "preview.cachePut", key="late", data="", generation=generation)["result"] is False
        assert services.library.current_pin().root == paths["japan"].parent
        assert services.catalog.server == "japan"
        assert services.game._cab_index(everything=True) == {"cab-shared": str(paths["japan"])}
        assert old_game._cab_index(everything=True) == {"cab-shared": str(paths["global"])}
        assert before == {key: path.read_bytes() for key, path in paths.items()}
    finally:
        services.close()
