"""Whole-file replacement uses current official slots, independent of transferable assets."""

import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import integrity
from ba_modding_toolkit.library.identity import content_cores
from ba_modding_toolkit.library.integrity import metadata as bundle_metadata, inspect as inspect_bundle
from ba_modding_toolkit.models import AssetType, SaveOptions
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.utils import CRCUtils
from ba_modding_toolkit.webui import batch_import
from test_batch_import import analyze, batch_model_env, env, run
from test_library import game_bundle, make_mod, setup_library
from test_library_model import model_bundle, model_env
from test_mod_origin import unity_bundle


@pytest.mark.parametrize('code,reason', [
    ('game_file_not_found', 'no_target'), ('bundle_invalid', 'unreadable'),
    ('mod_unsupported', 'unsupported'), ('source_unsupported', 'unsupported'),
    *[(code, code) for code in (
        'required_asset_extract_failed', 'required_asset_apply_failed', 'required_assets_unmatched',
        'spine_version', 'source_unknown', 'source_conflict', 'mod_target_unknown', 'mod_target_ambiguous',
        'mod_platform_mismatch', 'mod_platform_unknown', 'mod_unity_version_mismatch', 'mod_release_mismatch', 'mod_parts_missing',
        'game_file_conflict', 'library_io_error', 'no_matching_assets', 'original_unavailable', 'entry_changed')],
    ('future_failure', 'failed'),
])
def test_blocked_reason_keeps_missing_counterparts_distinct(code, reason):
    assert batch_import.blocked_reason(ServiceError(code)) == reason


@pytest.mark.parametrize('phase', ['identify', 'preflight', 'prepare'])
@pytest.mark.parametrize('code', ['required_asset_extract_failed', 'required_asset_apply_failed',
                                  'required_assets_unmatched', 'mod_target_unknown', 'future_failure'])
def test_failure_details_reach_results_and_logs(env, monkeypatch, caplog, phase, code):
    source = make_mod(env.original, env.tmp / 'input')
    params = {'file': source, 'name': 'Modified_Body', 'error': 'Unsupported mesh data'}

    def fail(*args, **kwargs):
        raise ServiceError(code, **params)

    if phase == 'identify':
        monkeypatch.setattr(env.library, 'identify_import', fail)
    elif phase == 'preflight':
        monkeypatch.setattr(env.library, 'inspect_import', fail)
    else:
        monkeypatch.setattr(env.services.batch_import, '_prepare', fail)
    entry, = analyze(env, [source])['entries']
    result, = run(env, [entry], enableAfterImport=False)
    expected = ServiceError(code, **params).to_json()
    assert result['error'] == expected
    if phase != 'prepare':
        assert entry['reason'] == batch_import.blocked_reason(ServiceError(code))
        assert entry['error'] == expected
    assert code in caplog.text and 'Modified_Body' in caplog.text
    assert str(source) not in caplog.text and source.name not in caplog.text


def restore_metadata(monkeypatch):
    monkeypatch.setattr(integrity, 'metadata', bundle_metadata)
    monkeypatch.setattr('ba_modding_toolkit.library.identity.content_cores', content_cores)


def rename_crc(path):
    renamed = path.with_name(path.name.rsplit('_', 1)[0] + f'_{CRCUtils.compute_crc32(path.read_bytes())}.bundle')
    return path.rename(renamed)


@pytest.mark.parametrize('crc_name', [False, True])
@pytest.mark.parametrize('fixed', [False, True])
def test_model_direct_replacement_never_transfers_assets(batch_model_env, monkeypatch, crc_name, fixed):
    env = batch_model_env
    restore_metadata(monkeypatch)
    target = rename_crc(unity_bundle(env.parts[1], name='Hoshino_Body'))
    env.parts[1] = target
    official = target.read_bytes()
    source = unity_bundle(env.tmp / 'input' / target.name, name='Unknown_CutIn_Body', payload=b'modified model')
    if crc_name:
        source = rename_crc(source)
    if fixed:
        source.write_bytes(CRCUtils.apply_crc_fix(source.read_bytes(), int(parse_filename(target.name).crc)))
    original_source = source.read_bytes()
    # This is the content identity failure masked as no_target before current names took precedence.
    from ba_modding_toolkit.library.identity import identify
    with pytest.raises(ServiceError, match='mod_target_unknown'):
        identify(source, source.name, env.catalog)

    def forbidden(*args, **kwargs):
        pytest.fail('Current official parts must not match or transfer assets')

    monkeypatch.setattr(Bundle, 'extract_patch', forbidden)
    monkeypatch.setattr(batch_import, '_asset_match', forbidden)
    monkeypatch.setattr(batch_import.core, 'process_mod_update', forbidden)
    monkeypatch.setattr(Bundle, 'check_need_crc', lambda *args: True)
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason'], entry['files'][0]['target']) == ('ready', None, target.name)
    result, = run(env, [entry], crc='off', types=['Texture2D'], backup=True)
    assert result['outcome'] == 'imported' and result['applied'], result
    installed = target.read_bytes()
    assert installed == original_source if fixed else installed[:-4] == original_source
    assert CRCUtils.compute_crc32(installed) == int(parse_filename(target.name).crc)
    assert source.read_bytes() == original_source
    assert Path(str(target) + '.backup').read_bytes() == official
    assert all(path.read_bytes() == env.official[path] for path in (env.parts[0], env.parts[2]))
    env.library.restore('hoshino', kind='model')
    assert target.read_bytes() == official


@pytest.mark.parametrize('change,code', [('platform', 'mod_platform_mismatch'),
                                         ('version', 'mod_unity_version_mismatch'),
                                         ('invalid', 'bundle_invalid')])
def test_current_name_rejects_incompatible_metadata(env, monkeypatch, change, code):
    restore_metadata(monkeypatch)
    target = rename_crc(unity_bundle(env.original))
    env.original = target
    source = unity_bundle(env.tmp / 'input' / target.name, 13 if change == 'platform' else 19, payload=b'mod')
    if change == 'version':
        source.write_bytes(source.read_bytes().replace(b'2021.3.0f1', b'2022.3.0f1'))
    elif change == 'invalid':
        source.write_bytes(source.read_bytes()[:45])
    before = target.read_bytes()
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'blocked'
    assert entry['error']['code'] == code
    assert entry['reason'] == batch_import.blocked_reason(ServiceError(code))
    result, = run(env, [entry])
    assert result['outcome'] == 'skipped' and result['error'] == entry['error']
    assert target.read_bytes() == before and not env.library.mods()


@pytest.mark.parametrize('field', ['date', 'part'])
def test_crc_matching_does_not_hide_a_release_or_part_change(field, tmp_path):
    name = 'assets-_mx-characters-ch0188-_mxdependency-2024-11-18_004_assets_all_1.bundle'
    changed = name.replace('2024-11-18', '2025-07-25') if field == 'date' else name.replace('_004_', '_006_')
    assert integrity.replacements({changed: tmp_path / changed}, [tmp_path / name]) == {}


@pytest.mark.parametrize('category,core', [('spinecharacters', 'test_spr'), ('spinelobbies', 'test_home_gl'),
                                          ('ui', 'common')])
def test_crc_only_names_copy_all_kinds_without_asset_matching(env, monkeypatch, category, core):
    restore_metadata(monkeypatch)
    if category == 'spinecharacters':
        env.original.unlink()
    target = rename_crc(unity_bundle(game_bundle(env.game_dir, core, category=category)))
    source = rename_crc(unity_bundle(env.tmp / 'input' / target.name, name='unrelated', payload=b'whole mod'))

    def forbidden(*args, **kwargs):
        pytest.fail('CRC-only filename differences must not trigger asset matching')

    monkeypatch.setattr(Bundle, 'get_asset_keys', forbidden)
    monkeypatch.setattr(Bundle, 'extract_patch', forbidden)
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['files'][0]['target']) == ('ready', target.name)
    result, = run(env, [entry])
    assert result['outcome'] == 'imported' and result['applied'], result
    assert target.read_bytes() == source.read_bytes()


@pytest.mark.parametrize('crc_name', [False, True])
def test_current_npc_without_roster_entry_imports_applies_and_restores(env, monkeypatch, crc_name):
    from ba_modding_toolkit.catalog import Catalog

    restore_metadata(monkeypatch)
    env.library.catalog = Catalog(SimpleNamespace(spine_cores=lambda kind: {}, collection_names=lambda: {},
                                                 model_cores=lambda: {'en0002'}), None)
    target = rename_crc(unity_bundle(game_bundle(env.game_dir, 'en0002', category='npcs'), name='EN0002_Body'))
    official = target.read_bytes()
    source = unity_bundle(env.tmp / 'input' / target.name, name='Custom_Body', payload=b'NPC mod')
    if crc_name:
        source = rename_crc(source)
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['kind'], entry['variant']) == ('ready', 'model', 'en0002')
    result, = run(env, [entry])
    assert result['outcome'] == 'imported' and result['applied'], result
    assert target.read_bytes() == source.read_bytes()
    assert env.library.configured('en0002')['model'] == f"mod:{result['libraryId']}"
    assert not env.library.toggle(False, True).failed
    assert target.read_bytes() == official
    assert not env.library.toggle(True, False).failed
    assert target.read_bytes() == source.read_bytes()
    env.library.restore('en0002', kind='model')
    assert target.read_bytes() == official


@pytest.fixture
def verified_model(tmp_path, monkeypatch):
    """Only read the explicitly supplied view; all mutations use isolated copies."""
    value = os.environ.get('BAMT_TEST_GAME_DIR')
    if not value:
        pytest.skip('Set BAMT_TEST_GAME_DIR to an isolated verified official view')
    from ba_modding_toolkit.catalog import Catalog
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.library import ModLibrary, safety
    from ba_modding_toolkit.searching import get_search_dirs
    from ba_modding_toolkit.webui.api import build_api
    from ba_modding_toolkit.webui.services import Services

    resources = get_search_dirs(Path(value))
    portraits = {parse_filename(path.name).core: [] for folder in resources
                 for path in folder.glob('assets-_mx-spinecharacters-*.bundle')
                 if parse_filename(path.name).core.endswith('_spr')}
    parts = sorted((path for folder in resources for path in folder.glob('assets-_mx-characters-*.bundle')),
                   key=lambda path: (not ('shiroko_original' in path.name and '_006_' in path.name), path.stat().st_size))
    chosen = obj_id = None
    for path in parts:
        bundle = Bundle.load(path)
        if bundle is None:
            continue
        obj = next((obj for obj in bundle.env.objects if obj.type in (AssetType.Mesh, AssetType.Material)), None)
        if obj:
            chosen, obj_id = path, obj.path_id
            break
    if chosen is None:
        pytest.skip('No verified characters part with a Mesh or Material')
    game = tmp_path / 'game'
    game.mkdir()
    core = parse_filename(chosen.name).core
    for folder in resources:
        for path in folder.glob('*.bundle'):
            if parse_filename(path.name).core == core:
                shutil.copy2(path, game / path.name)
                (game / path.name).chmod(0o644)
    target = game / chosen.name
    catalog = Catalog(SimpleNamespace(spine_cores=lambda kind: portraits if kind == 'spr' else {}, collection_names=lambda: {},
                                      model_cores=lambda: {core}), None)
    settings = Settings(tmp_path / 'config.toml')
    settings.set('game_resource_dir', str(game))
    settings.set('compression_method', 'none')
    monkeypatch.setattr(safety, 'check_game_not_running', lambda: None)
    library = ModLibrary(tmp_path / 'library', catalog, object(), settings)
    services = Services(settings, tmp_path / 'app', cache=object(), game=object(), catalog=catalog, library=library)
    yield SimpleNamespace(tmp=tmp_path, original=target, object_id=obj_id, settings=settings,
                          library=library, services=services, rpc=build_api(services))
    services.close()


@pytest.mark.parametrize('crc_name', [False, True])
def test_verified_modified_model_part_imports_whole(verified_model, monkeypatch, crc_name):
    env = verified_model
    bundle = Bundle.load(env.original)
    obj = next(obj for obj in bundle.env.objects if obj.path_id == env.object_id)
    data = obj.read()
    data.m_Name = 'Unknown_CutIn_Body'
    data.save()
    source = env.tmp / 'input' / env.original.name
    source.parent.mkdir()
    assert bundle.save(source, SaveOptions(perform_crc=False, compression='none'))[0]
    if crc_name:
        source = rename_crc(source)
    # The changed asset has no transferable counterpart, even with every asset type selected.
    assert ('Unknown_CutIn_Body', obj.type.name) not in Bundle.load(env.original).get_asset_keys('name_type')
    before = source.read_bytes()
    official = {path: path.read_bytes() for path in env.original.parent.glob('*.bundle')}
    # The former content-first path rejects the changed model name before copying this part.
    from ba_modding_toolkit.library.identity import identify
    with pytest.raises(ServiceError, match='mod_target_unknown'):
        identify(source, source.name, env.library.catalog)

    def forbidden(*args, **kwargs):
        pytest.fail('Direct replacements must bypass asset transfer')

    monkeypatch.setattr(Bundle, 'extract_patch', forbidden)
    monkeypatch.setattr(batch_import, '_asset_match', forbidden)
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('ready', None), entry
    result, = run(env, [entry], types=['Texture2D'])
    assert result['outcome'] == 'imported' and result['applied'], result
    installed = env.original.read_bytes()
    assert installed == before or installed[:-4] == before
    assert source.read_bytes() == before
    assert all(path.read_bytes() == contents for path, contents in official.items() if path != env.original)
    mod, = env.library.mods()
    env.library.restore(mod.target, kind='model')
    assert all(path.read_bytes() == contents for path, contents in official.items())


def test_verified_wrong_platform_keeps_real_error(verified_model):
    env = verified_model
    bundle = Bundle.load(env.original)
    from UnityPy.enums import BuildTarget
    for file in bundle.env.file.files.values():
        if hasattr(file, 'target_platform'):
            file.target_platform = BuildTarget.Android if file.target_platform != BuildTarget.Android else BuildTarget.StandaloneWindows64
            file._m_target_platform = file.target_platform.value
            file.mark_changed()
    source = env.tmp / 'input' / env.original.name
    source.parent.mkdir()
    assert bundle.save(source, SaveOptions(perform_crc=False, compression='none'))[0]
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('blocked', 'mod_platform_mismatch')
    assert entry['error']['code'] == 'mod_platform_mismatch'
    assert entry['error']['params']['platform'] != entry['error']['params']['expected']
    assert not env.library.mods()


@pytest.mark.parametrize('crc_name', [False, True])
@pytest.mark.parametrize('change', ['cab', 'layout', 'region'])
def test_current_name_cannot_admit_foreign_or_older_content(env, monkeypatch, crc_name, change):
    restore_metadata(monkeypatch)
    monkeypatch.setattr(integrity, 'inspect', inspect_bundle)
    target = rename_crc(unity_bundle(env.original))
    source = unity_bundle(env.tmp / 'input' / target.name, payload=b'older or foreign',
                         cab='CAB-older' if change == 'cab' else 'CAB-fixture',
                         references=['com.YostarJP.BlueArchive'] if change == 'region' else [])
    if change == 'layout':
        bundle = Bundle.load(source)
        obj = bundle.env.objects[0]
        file = obj.assets_file
        del file.objects[obj.path_id]
        obj.path_id = 99
        file.objects[obj.path_id] = obj
        file.mark_changed()
        assert bundle.save(source, SaveOptions(perform_crc=False, compression='none'))[0]
    if crc_name:
        source = rename_crc(source)
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'blocked'
    assert entry['reason'] == ('source_conflict' if change == 'region' else 'mod_release_mismatch')
    with pytest.raises(ServiceError):
        env.library.add_files('spr', [source], direct=True)
    assert not env.library.mods()


@pytest.mark.parametrize('change', ['body_cab', 'missing_material'])
def test_partial_model_replacement_validates_effective_dependencies(batch_model_env, monkeypatch, change):
    env = batch_model_env
    restore_metadata(monkeypatch)
    monkeypatch.setattr(integrity, 'inspect', inspect_bundle)
    for index, cab in enumerate(['CAB-prefab', 'CAB-body', 'CAB-texture']):
        env.parts[index] = rename_crc(unity_bundle(env.parts[index], cab=cab,
            references=['CAB-body'] if index == 0 else []))
    target = env.parts[1 if change == 'body_cab' else 0]
    source = unity_bundle(env.tmp / 'input' / target.name, payload=b'mod',
                         cab='CAB-changed' if change == 'body_cab' else 'CAB-prefab',
                         references=[] if change == 'body_cab' else ['CAB-missing-material'])
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('blocked', 'mod_parts_missing')
    assert ('CAB-body' if change == 'body_cab' else 'CAB-missing-material') in entry['params']['files']
    with pytest.raises(ServiceError, match='mod_parts_missing'):
        env.library.add_files('model', [source], direct=True)
    assert not env.library.mods()


def material(name):
    return {'m_Name': name, 'm_Shader': {'m_FileID': 0, 'm_PathID': 0},
            'm_ValidKeywords': [], 'm_InvalidKeywords': [], 'm_LightmapFlags': 0,
            'm_EnableInstancingVariants': False, 'm_DoubleSidedGI': False, 'm_CustomRenderQueue': -1,
            'stringTagMap': [], 'disabledShaderPasses': [], 'm_BuildTextureStacks': [],
            'm_SavedProperties': {'m_TexEnvs': [], 'm_Ints': [], 'm_Floats': [], 'm_Colors': []}}


def asset_bundle_reference(path_id):
    return {'m_Name': 'model', 'm_PreloadTable': [{'m_FileID': 1, 'm_PathID': path_id}],
            'm_Container': [], 'm_MainAsset': {'preloadIndex': 0, 'preloadSize': 0,
                                            'asset': {'m_FileID': 0, 'm_PathID': 0}},
            'm_RuntimeCompatibility': 0, 'm_AssetBundleName': 'model', 'm_Dependencies': [],
            'm_IsStreamedSceneAssetBundle': False, 'm_ExplicitDataLayout': 0, 'm_PathFlags': 0,
            'm_SceneHashes': []}


@pytest.mark.parametrize('part', ['004', '006'])
@pytest.mark.parametrize('consumer', ['prefab', 'retained_part', 'other_bundle'])
@pytest.mark.parametrize('change', ['added', 'removed_reference', 'changed_type', 'removed_unused', 'changed_cab'])
def test_model_replacement_preserves_referenced_objects(batch_model_env, monkeypatch, part, consumer, change):
    env = batch_model_env
    restore_metadata(monkeypatch)
    monkeypatch.setattr(integrity, 'inspect', inspect_bundle)
    # All installed bundles are generated fixtures, including consumers outside this model.
    env.original = rename_crc(unity_bundle(env.original, cab='CAB-other'))
    for index, target in enumerate(env.parts):
        env.parts[index] = rename_crc(unity_bundle(target, cab=f'CAB-part-{index}'))
    env.parts[1].unlink()
    target = rename_crc(unity_bundle(model_bundle(env.game_dir, part=part), cab='CAB-body',
                                    objects=[(1, 21, material('Original')), (2, 21, material('Unused'))]))
    consumer_path = {'prefab': env.parts[0], 'retained_part': env.parts[2], 'other_bundle': env.original}[consumer]
    rename_crc(unity_bundle(consumer_path, cab='CAB-consumer', references=['archive:/CAB-body/CAB-body'],
                            objects=[(10, 142, asset_bundle_reference(1))]))
    objects = [(1, 21, material('Original')), (2, 21, material('Unused')), (3, 21, material('Added'))]
    source = unity_bundle(env.tmp / 'input' / target.name, cab='CAB-body', objects=objects)
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('ready', None), entry

    if change == 'removed_reference':
        objects = objects[1:]
    elif change == 'changed_type':
        objects[0] = (1, 49, {'m_Name': 'Changed', 'm_Script': 'different type'})
    elif change == 'removed_unused':
        objects.pop(1)
    unity_bundle(source, cab='CAB-changed' if change == 'changed_cab' else 'CAB-body', objects=objects)
    entry, = analyze(env, [source])['entries']
    if change in ('removed_reference', 'changed_type', 'changed_cab'):
        code = 'mod_parts_missing' if change == 'changed_cab' and consumer != 'other_bundle' else 'mod_release_mismatch'
        assert (entry['state'], entry['reason']) == ('blocked', code), entry
        with pytest.raises(ServiceError, match=code):
            env.library.add_files('model', [source], direct=True)
        assert not env.library.mods()
    else:
        assert (entry['state'], entry['reason']) == ('ready', None), entry
        before = {path: path.read_bytes() for path in env.game_dir.glob('*.bundle')}
        result, = run(env, [entry], enableAfterImport=False)
        assert result['outcome'] == 'imported', result
        stored, = env.library.mods()
        assert stored.file.read_bytes() == source.read_bytes()
        assert all(path.read_bytes() == data for path, data in before.items())


def test_unexpected_import_failure_does_not_log_private_traceback(env, monkeypatch, caplog):
    source = make_mod(env.original, env.tmp / 'input')
    entry, = analyze(env, [source])['entries']
    private = '/Users/PrivateUser/Private Mesh.bundle'

    def fail(*args, **kwargs):
        raise RuntimeError(f'Cannot read {private}')

    monkeypatch.setattr(env.services.batch_import, '_prepare', fail)
    result, = run(env, [entry], enableAfterImport=False)
    assert result['error']['code'] == 'internal'
    assert private not in caplog.text and 'PrivateUser' not in caplog.text and 'Private Mesh' not in caplog.text
    assert '[asset].bundle' in caplog.text


@pytest.mark.parametrize('error_type', [FileNotFoundError, RuntimeError])
def test_library_inspection_failure_logs_only_sanitized_error(env, monkeypatch, caplog, error_type):
    source = make_mod(env.original, env.tmp / 'home' / 'PrivateUser' / 'Private Assets')

    def fail(path, **kwargs):
        if path == source:
            source.unlink()
            if error_type is FileNotFoundError:
                source.stat()
            raise RuntimeError(f'Cannot inspect {source}')
        return bundle_metadata(path, **kwargs)

    monkeypatch.setattr(integrity, 'metadata', fail)
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'blocked'
    assert entry['error']['code'] == ('library_io_error' if error_type is FileNotFoundError
                                      else 'library_operation_failed')
    records = [record for record in caplog.records if record.name == 'ba_modding_toolkit.library.service']
    assert len(records) == 1
    assert records[0].exc_info is None
    assert error_type.__name__ in records[0].getMessage()
    assert '[asset].bundle' in records[0].getMessage()
    assert all(value not in caplog.text for value in (str(source), source.name, 'PrivateUser', 'Private Assets'))
