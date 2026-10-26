"""Server selection uses isolated folders and never changes Hall data or game bytes."""
import json
from types import SimpleNamespace

from ba_modding_toolkit.catalog import Catalog, Variant
from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.webui.photography import Photography
from ba_modding_toolkit.webui.student_hall import empty_hall
from test_webui import app, services, rpc


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
