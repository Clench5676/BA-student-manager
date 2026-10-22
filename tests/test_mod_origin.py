"""Origin detection and classic conversions using generated UnityFS bundles only."""

import os
import shutil
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import mod_origin
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.library import integrity
from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.library.identity import content_cores
from ba_modding_toolkit.library.integrity import inspect as inspect_bundle, metadata as bundle_metadata
from ba_modding_toolkit.webui import batch_import
from ba_modding_toolkit.searching import _asset_match
from ba_modding_toolkit.utils import CRCUtils

from test_batch_import import analyze, env, finish, rpc, run
from test_library import game_bundle, make_mod, setup_library


def unity_bundle(path, platform=19, *, cab='CAB-fixture', payload=b'official', name='test_spr_note', references=()):
    """One serialized TextAsset, with no type tree; UnityPy uses its shipped class database."""
    def string(value):
        data = struct.pack('<I', len(value)) + value
        return data + bytes(-len(data) % 4)

    obj = string(name.encode()) + string(payload)
    metadata = b'2021.3.0f1\0' + struct.pack('<i?I', platform, False, 1)
    metadata += struct.pack('<i?h', 49, False, -1) + bytes(16)
    metadata += struct.pack('<I', 1)
    metadata += bytes(-(20 + len(metadata)) % 4)
    metadata += struct.pack('<qIII', 1, 0, len(obj), 0)
    metadata += struct.pack('<II', 0, len(references))
    for reference in references:
        metadata += bytes(17) + struct.pack('<I', 0) + reference.encode() + b'\0'
    metadata += b'\0'
    offset = (20 + len(metadata) + 15) // 16 * 16
    data = (struct.pack('>4I', len(metadata), offset + len(obj), 17, offset) + bytes(4) + metadata).ljust(offset, b'\0') + obj
    info = bytes(16) + struct.pack('>iIIHiqqI', 1, len(data), len(data), 0, 1, 0, len(data), 0) + cab.encode() + b'\0'
    header = b'UnityFS\0' + struct.pack('>I', 7) + b'5.x.x\0' + b'2021.3.0f1\0'
    padding = bytes(-(len(header) + 20) % 16)
    header += struct.pack('>qIII', len(header) + 20 + len(padding) + len(info) + len(data), len(info), len(info), 64)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + padding + info + data)
    return path


def old_bundle(path, *args, **kwargs):
    """Conversion and extraction checks use an older release; current names copy whole files."""
    path = path.with_name(path.name.replace('2026-01-01', '2025-01-01'))
    return unity_bundle(path, *args, **kwargs)


@pytest.mark.parametrize('platform,expected', [(13, 'android'), (9, 'ios'), (19, 'windows'), (5, 'windows')])
@pytest.mark.parametrize('server,reference', [('global', 'com.nexon.bluearchive'), ('japan', 'com.Yostar JP.BlueArchive'), ('japan', 'com.YostarJP.BlueArchive')])
def test_serialized_platform_and_dependency_server_detection(tmp_path, platform, expected, server, reference):
    source = unity_bundle(tmp_path / 'neutral.bundle', platform, references=[reference])
    contents = inspect_bundle(source)
    detected, reason = mod_origin.source_of({source.name}, contents, integrity.Contents(), {'server': 'global'})
    assert detected == {'server': server, 'platform': expected, 'detected': True}
    assert reason is None
    assert Bundle.load(source).env.objects[0].read().m_Script == 'official'


def test_server_evidence_does_not_guess_from_shared_suffixes_or_a_bare_cab(tmp_path):
    contents = inspect_bundle(unity_bundle(tmp_path / 'textures.bundle'))
    target = {'server': 'global', 'platform': 'windows'}
    assert mod_origin.source_of({'textures.bundle'}, contents, integrity.Contents(), target) == (None, 'source_unknown')
    official = integrity.Contents(files=contents.files)
    assert mod_origin.source_of({'textures.bundle'}, contents, official, target)[0]['server'] == 'global'
    assert mod_origin.source_of({'assets-_mx-spinelobbies-azusa_home_gl-textures.bundle'}, contents,
                                integrity.Contents(), target)[0]['server'] == 'global'


def official_bundle(env, platform=19, **kwargs):
    unity_bundle(env.original, platform, **kwargs)
    prefix = env.original.name.rsplit('_', 1)[0]
    renamed = env.original.with_name(f'{prefix}_{CRCUtils.compute_crc32(env.original.read_bytes())}.bundle')
    env.original.rename(renamed)
    env.original = renamed


@pytest.fixture
def real_metadata(env, monkeypatch):
    monkeypatch.setattr(integrity, 'inspect', inspect_bundle)
    monkeypatch.setattr(integrity, 'metadata', bundle_metadata)
    monkeypatch.setattr(batch_import, '_asset_match', _asset_match)
    official_bundle(env)
    return env


@pytest.mark.parametrize('platform,source_platform,target_platform', [(13, 'android', 19), (9, 'ios', 19),
                                                                    (19, 'windows', 13), (19, 'windows', 9)])
def test_conversion_update_add_apply_uses_real_classic_core(real_metadata, platform, source_platform, target_platform):
    env = real_metadata
    official_bundle(env, target_platform)
    source = old_bundle(env.tmp / 'input' / env.original.name, platform, cab='CAB-source', payload=b'modded',
                          references=['com.nexon.bluearchive'])
    before = source.read_bytes()
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('convert', None)
    assert entry['source'] == {'server': 'global', 'platform': source_platform, 'detected': True}
    assert entry['target'] == {'server': 'global', 'platform': 'windows' if target_platform == 19 else 'android' if target_platform == 13 else 'ios'}
    events = env.services.events.subscribe()
    result, = run(env, [entry], strategy='path_id', types=['TextAsset'], backup=True,
                  crc='on' if target_platform == 19 else 'off')
    assert result['outcome'] == 'updated' and result['applied']
    updates = []
    while not events.empty():
        event, data = events.get_nowait()
        if event == 'job.progress':
            updates.append(data)
    steps = {item['step'] for item in updates if item['phase'] == 'convert'}
    assert {'import.step.check', 'import.step.extract', 'import.step.replace', 'import.step.save'} <= steps
    assert ('import.step.crc' in steps) is (target_platform == 19)
    assert all(item['current'] == entry['id'] and item['index'] == item['total'] == 1 for item in updates)
    mod, = env.library.mods()
    assert mod.id == result['libraryId']
    converted = Bundle.load(env.original)
    assert converted.platform_info[0] == {19: 'StandaloneWindows64', 13: 'Android', 9: 'iOS'}[target_platform]
    assert converted.env.objects[0].read().m_Script == 'modded'
    assert source.read_bytes() == before
    env.library.restore('test')
    assert Bundle.load(env.original).env.objects[0].read().m_Script == 'official'


def test_cross_server_old_filename_converts_instead_of_copying(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-jp', payload=b'JP mod',
                          references=['com.Yostar JP.BlueArchive'])
    entry, = analyze(env, [source])['entries']
    assert entry['source']['server'] == 'japan' and entry['target']['server'] == 'global'
    assert entry['state'] == 'convert'
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'updated' and result['applied']
    assert Bundle.load(env.original).env.objects[0].read().m_Script == 'JP mod'
    assert inspect_bundle(env.original).platforms == {'StandaloneWindows64'}


@pytest.mark.parametrize('restart', [False, True])
@pytest.mark.parametrize('enabled', [False, True])
def test_converted_source_is_already_in_library_after_move_and_restart(real_metadata, monkeypatch, restart, enabled):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-source', payload=b'modded',
                        references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    result, = run(env, [entry], types=['TextAsset'], enableAfterImport=enabled)
    assert result['outcome'] == 'updated'
    if enabled:
        env.library.restore('test')
    before = env.original.read_bytes()
    if restart:
        env.library = ModLibrary(env.root, env.catalog, object(), env.settings)
        env.services._library = env.library
        env.services.batch_import = batch_import.BatchImport(env.services)
    moved = env.tmp / 'moved' / source.name
    moved.parent.mkdir()
    shutil.copy2(source, moved)

    def forbidden(*args, **kwargs):
        pytest.fail('A remembered conversion must not rebuild, add, or apply')

    monkeypatch.setattr(batch_import.core, 'process_mod_update', forbidden)
    monkeypatch.setattr(env.library, 'add_files', forbidden)
    monkeypatch.setattr(env.library, 'apply_import', forbidden)
    repeated, = analyze(env, [moved])['entries']
    assert (repeated['state'], repeated['libraryId']) == ('library', result['libraryId'])
    duplicate, = run(env, [repeated])
    assert duplicate['outcome'] == 'unchanged' and not duplicate['applied']
    assert len(env.library.mods()) == 1 and env.original.read_bytes() == before


@pytest.mark.parametrize('change', ['source', 'output', 'release', 'remove'])
def test_conversion_provenance_never_matches_changed_bytes_or_removed_entry(real_metadata, change):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-source', payload=b'modded',
                        references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    result, = run(env, [entry], types=['TextAsset'], enableAfterImport=False)
    if change == 'source':
        unity_bundle(source, 13, cab='CAB-source', payload=b'new mod', references=['com.nexon.bluearchive'])
    elif change == 'output':
        mod, = env.library.mods()
        unity_bundle(mod.file, payload=b'changed library output')
    elif change == 'release':
        env.original = env.original.rename(env.original.with_name(env.original.name.replace('2026-01-01', '2026-02-01')))
    else:
        assert not env.library.remove(result['libraryId']).failed
    env.services.batch_import = batch_import.BatchImport(env.services)
    repeated, = analyze(env, [source])['entries']
    assert repeated['state'] == 'convert' and repeated['libraryId'] is None


def test_legacy_converted_output_is_verified_and_source_identity_backfilled(real_metadata, monkeypatch):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-source', payload=b'modded',
                        references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    result, = run(env, [entry], enableAfterImport=False)
    env.library._records[result['libraryId']].pop('import_sources')
    env.library._save()
    env.services.batch_import = batch_import.BatchImport(env.services)
    before = env.original.read_bytes()

    def forbidden(*args, **kwargs):
        pytest.fail('Legacy recognition must never add or apply a Mod')

    monkeypatch.setattr(env.library, 'add_files', forbidden)
    monkeypatch.setattr(env.library, 'apply_import', forbidden)
    repeated, = analyze(env, [source])['entries']
    assert (repeated['state'], repeated['libraryId']) == ('library', result['libraryId'])
    assert env.library._records[result['libraryId']]['import_sources']
    assert env.original.read_bytes() == before and len(env.library.mods()) == 1
    monkeypatch.setattr(batch_import.core, 'process_mod_update', forbidden)
    assert analyze(env, [source])['entries'][0]['state'] == 'library'


def test_conversion_source_identity_includes_the_complete_part_mapping(real_metadata):
    env = real_metadata
    first = old_bundle(env.tmp / 'input' / env.original.name, 13, payload=b'first')
    second = old_bundle(env.tmp / 'input' / env.original.name.replace('_003_', '_004_'), 13, payload=b'second')
    target = {'server': 'global', 'platform': 'windows'}
    identity = env.library.import_source_identity({first.name: first, second.name: second}, target, [env.original])
    for files in ({first.name: first}, {first.name: second, second.name: first}):
        assert env.library.import_source_identity(files, target, [env.original]) != identity


@pytest.mark.parametrize('platform', [13, -2])
def test_unknown_source_set_source_reanalyzes_and_persists_for_run_and_recheck(real_metadata, platform):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, platform, cab='CAB-unknown', payload=b'unknown mod')
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('convert', None)
    assert entry['source'] == {'server': 'global', 'platform': 'android', 'detected': True}
    assert entry['preview']
    selected = finish(env, rpc(env, 'import.setSource', id=entry['id'], server='global', platform='android'))
    assert selected['source'] == {'server': 'global', 'platform': 'android', 'detected': False}
    assert selected['state'] == 'convert' and selected['id'] == entry['id']
    selected, = analyze(env, [source])['entries']
    assert selected['source']['detected'] is False and selected['state'] == 'convert'
    result, = run(env, [selected], types=['TextAsset'])
    assert result['outcome'] == 'updated' and result['applied']
    assert Bundle.load(env.original).env.objects[0].read().m_Script == 'unknown mod'


@pytest.mark.parametrize('platform,reason', [(2, 'platform_unsupported')])
def test_unsupported_source_still_has_preview(real_metadata, platform, reason):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, platform, references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('blocked', reason)
    assert env.services.batch_import.preview(entry['preview']['key'])[1][-1] == source


def test_conversion_without_matching_assets_is_blocked_but_previewable(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, payload=b'mod', name='unrelated',
                          references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('blocked', 'no_matching_assets')
    assert entry['preview']


def test_settings_region_and_resource_folder_platform():
    settings = SimpleNamespace(is_adb_mode=lambda: False, server_region=lambda: 'global')
    pin = SimpleNamespace(server='japan', dirs=[Path('/fixture/GameData/Android')])
    assert mod_origin.target_of(settings, pin) == {'server': 'japan', 'platform': 'android'}
    assert mod_origin.target_of(settings, pin, integrity.Contents(platforms={'iOS'})) == {'server': 'japan', 'platform': 'ios'}


@pytest.mark.parametrize('server,platform', [('other', 'android'), ('global', 'linux'), (None, 'windows')])
def test_set_source_rejects_invalid_values(real_metadata, server, platform):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-unknown')
    entry, = analyze(env, [source])['entries']
    result = env.rpc.call('import.setSource', {'id': entry['id'], 'server': server, 'platform': platform})
    assert result['error']['code'] == 'bad_params'


def test_set_source_rejects_changed_upload(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-unknown')
    entry, = analyze(env, [source])['entries']
    source.write_bytes(source.read_bytes() + b'changed')
    job = rpc(env, 'import.setSource', id=entry['id'], server='global', platform='android')
    assert env.services.jobs.wait(job, 10)
    assert rpc(env, 'jobs.get', id=job)['error']['code'] == 'entry_changed'


def test_cross_server_nonmatching_slot_is_blocked(real_metadata):
    env = real_metadata
    source = game_bundle(env.tmp / 'input', part='textures')
    unity_bundle(source, 13, cab='CAB-jp', payload=b'mod', references=['com.Yostar JP.BlueArchive'])
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('blocked', 'conversion_names')
    assert entry['preview']


def test_same_platform_cross_server_still_rebuilds(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 19, cab='CAB-jp', payload=b'JP mod',
                          references=['com.Yostar JP.BlueArchive'])
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'convert'
    result, = run(env, [entry], types=['TextAsset'])
    assert result['applied'] and result['outcome'] == 'updated'
    assert 'com.yostar jp.bluearchive' not in inspect_bundle(env.original).references


def test_origin_conflicts_and_platform_path_fallback():
    target = {'server': 'global', 'platform': 'windows'}
    for platforms, references, reason in [({'Android', 'iOS'}, set(), 'source_conflict'),
        ({'Android'}, {'com.nexon.bluearchive', 'com.Yostar JP.BlueArchive'}, 'source_conflict')]:
        assert mod_origin.source_of(set(), integrity.Contents(platforms=platforms, references=references),
                                    integrity.Contents(), target) == (None, reason)
    source, reason = mod_origin.source_of(set(), integrity.Contents(platforms={'NoTarget'},
        references={'com.nexon.bluearchive/GameData/Android/shared.bundle'}), integrity.Contents(), target)
    assert source == {'server': 'global', 'platform': 'android', 'detected': True} and reason is None


GAME_DIR = Path(os.environ.get('BAMT_TEST_GAME_DIR') or '/nonexistent/bamt-real-game')


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason='Blue Archive install unavailable')
def test_official_metadata_detection_on_copies_only(tmp_path):
    import shutil
    from ba_modding_toolkit.searching import get_search_dirs

    candidates = [path for directory in get_search_dirs(GAME_DIR) for path in directory.glob('*.bundle')]
    if not candidates:
        pytest.skip('No official bundles')
    chosen = min(candidates, key=lambda path: path.stat().st_size)
    copied = tmp_path / chosen.name
    shutil.copy2(chosen, copied)
    contents = inspect_bundle(copied)
    platform = mod_origin.platform_of(contents)
    assert platform in mod_origin.PLATFORMS
    target = {'server': 'global', 'platform': platform}
    source, reason = mod_origin.source_of({copied.name}, contents, contents, target)
    assert source and source['platform'] == platform and reason is None


def test_ios_target_folder_is_found_by_settings_resource_search(tmp_path):
    from ba_modding_toolkit.config import Settings
    from ba_modding_toolkit.searching import get_search_dirs

    folder = tmp_path / 'Resource'
    ios = folder / 'GameData' / 'iOS'
    ios.mkdir(parents=True)
    assert ios in get_search_dirs(folder)
    settings = Settings(tmp_path / 'config.toml')
    settings.set('game_resource_dir', str(folder))
    assert ios in settings.resource_dirs()
    pin = SimpleNamespace(server='global', dirs=settings.resource_dirs())
    assert mod_origin.target_of(settings, pin)['platform'] == 'ios'


def test_conversion_failure_cannot_store_or_apply_mobile_bytes(real_metadata, monkeypatch):
    from ba_modding_toolkit.models import ModUpdateResult

    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-mobile', payload=b'mod',
                          references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    before = env.original.read_bytes()
    monkeypatch.setattr(batch_import.core, 'process_mod_update', lambda **kwargs: ModUpdateResult(False, 'failed', []))
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'failed' and result['reason'] == 'conversion_failed'
    assert not result['applied'] and not env.library.mods() and env.original.read_bytes() == before


@pytest.mark.parametrize('output', [False, True])
def test_conversion_stages_only_inside_the_pinned_library_with_dev_guards(real_metadata, monkeypatch, output):
    from ba_modding_toolkit import devmode

    env = real_metadata
    monkeypatch.setenv(devmode.ROOTS, str(env.tmp))
    monkeypatch.setenv(devmode.WRITABLE, str(env.tmp))
    source = old_bundle(env.tmp / 'mods' / 'ui_android' / env.original.name, 13,
                          cab='CAB-mobile', payload=b'mobile mod', references=['com.nexon.bluearchive'])
    before = source.read_bytes()
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'convert'
    seen = []
    update = batch_import.core.process_mod_update

    def convert(**kwargs):
        seen.extend([kwargs['output_dir'], *kwargs['target_paths']])
        return update(**kwargs)

    monkeypatch.setattr(batch_import.core, 'process_mod_update', convert)
    result, = run(env, [entry], types=['TextAsset'], output=str(env.tmp / 'output') if output else None)
    assert result['outcome'] == 'updated' and result['applied'], result
    assert seen and all(path.is_relative_to(env.library.root / 'staging') for path in seen)
    assert all(not path.exists() for path in seen), 'temporary conversions are removed after import'
    assert source.read_bytes() == before
    assert Bundle.load(env.original).env.objects[0].read().m_Script == 'mobile mod'


def test_system_temp_conversion_output_reproduces_the_dev_read_guard_failure(real_metadata, monkeypatch):
    from ba_modding_toolkit import devmode

    env = real_metadata
    monkeypatch.setenv(devmode.ROOTS, str(env.tmp))
    monkeypatch.setenv(devmode.WRITABLE, str(env.tmp))
    source = old_bundle(env.tmp / 'mods' / 'ui_android' / env.original.name, 13,
                          cab='CAB-mobile', payload=b'mobile mod', references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    temporary_directory = batch_import.staging.tempfile.TemporaryDirectory
    staged = []

    def former_staging(**kwargs):
        # Reproduce the old location without changing or broadening any guard.
        directory = temporary_directory(prefix=devmode.LIBRARY_STAGING_PREFIX + 'import-')
        staged.append(Path(directory.name))
        return directory

    monkeypatch.setattr(batch_import.staging.tempfile, 'TemporaryDirectory', former_staging)
    result, = run(env, [entry], types=['TextAsset'], enableAfterImport=False)
    refused = staged[0] / entry['id'] / 'output' / env.original.name
    assert result['outcome'] == 'failed' and result['reason'] == 'dev_path_outside'
    assert result['params'] == {'path': str(refused)}
    assert not env.library.mods()


def test_converted_output_still_requires_full_dependency_validation(real_metadata, monkeypatch):
    from ba_modding_toolkit.models import FilePair, ModUpdateResult

    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-mobile', payload=b'mod',
                          references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']

    def broken_output(**kwargs):
        target = kwargs['target_paths'][0]
        output = unity_bundle(kwargs['output_dir'] / target.name, 19, payload=b'bad rebuild', references=['CAB-missing'])
        return ModUpdateResult(True, 'converted', [FilePair(output, target)])

    monkeypatch.setattr(batch_import.core, 'process_mod_update', broken_output)
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'failed' and result['reason'] == 'mod_parts_missing'
    assert not env.library.mods() and not result['applied']


def test_unknown_server_can_be_selected_without_unnecessary_platform_conversion(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / 'input' / env.original.name, 19, cab='CAB-unknown', payload=b'mod')
    entry, = analyze(env, [source])['entries']
    assert entry['source'] == {'server': 'global', 'platform': 'windows', 'detected': True}
    assert entry['state'] == 'update'
    selected = finish(env, rpc(env, 'import.setSource', id=entry['id'], server='global', platform='windows'))
    assert selected['state'] == 'update' and selected['source']['detected'] is False
    assert run(env, [selected])[0]['applied']


def test_installed_mobile_bytes_do_not_bypass_conversion(real_metadata):
    env = real_metadata
    official = env.original.read_bytes()
    source = old_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-mobile', payload=b'mobile mod',
                          references=['com.nexon.bluearchive'])
    env.original.with_name(env.original.name + '.backup').write_bytes(official)
    env.original.write_bytes(source.read_bytes())
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'convert' and entry['target']['platform'] == 'windows'
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'updated' and result['applied']
    assert inspect_bundle(env.original).platforms == {'StandaloneWindows64'}


@pytest.mark.parametrize("platform,expected", [(13, "android"), (9, "ios"), (-2, "android")])
@pytest.mark.parametrize("compression", ["lz4", "lzma"])
def test_markerless_lobby_fallback_validates_compressed_renamed_bundles(real_metadata, monkeypatch, platform, expected, compression):
    env = real_metadata
    env.original.unlink()
    env.original = game_bundle(env.game_dir, "ch0156_home")
    env.catalog.variants["test"].lobby = "ch0156_home"
    monkeypatch.setattr("ba_modding_toolkit.library.identity.content_cores", content_cores)
    official_bundle(env, name="ch0156_home_note")
    source = unity_bundle(env.tmp / "input" / "renamed.bundle", platform, cab="CAB-repacked", payload=b"mobile mod", name="ch0156_home_note")
    bundle = Bundle.load(source)
    from ba_modding_toolkit.models import SaveOptions
    assert bundle.save(source, SaveOptions(compression=compression, perform_crc=False))[0]
    # The outer filename falsely declares a portrait; content names still identify the lobby.
    source = source.rename(source.with_name(env.original.name.replace("ch0156_home", "test_spr").replace("2026-01-01", "2025-01-01")))
    entry, = analyze(env, [source])["entries"]
    assert entry["kind"] == "lobby" and entry["state"] == "convert"
    assert entry["source"] == {"server": "global", "platform": expected, "detected": True}
    assert run(env, [entry], types=["TextAsset"])[0]["applied"]


def test_unknown_fallback_rejects_unmatched_assets(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unidentified", name="unrelated")
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"], entry["source"]) == ("blocked", 'no_matching_assets', None)
    assert entry["preview"]


def test_fallback_tie_prefers_partial_markers_then_fixed_order(real_metadata):
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-new", references=["com.YostarJP.BlueArchive"])
    entry, = analyze(env, [source])["entries"]
    assert entry["source"] == {"server": "japan", "platform": "android", "detected": True}
    # A known serialized target wins over the default Android candidate.
    unity_bundle(source, 9, cab="CAB-new")
    entry, = analyze(env, [source])["entries"]
    assert entry["source"] == {"server": "global", "platform": "ios", "detected": True}


def test_unknown_shared_file_target_does_not_discard_an_ios_marker():
    selected = integrity.Contents(platforms={"iOS", "NoTarget"}, references={"com.nexon.bluearchive"})
    source, reason = mod_origin.source_of(set(), selected, integrity.Contents(), {"server": "global", "platform": "windows"})
    assert source == {"server": "global", "platform": "ios", "detected": True}
    assert reason is None
    selected.references.clear()
    assert mod_origin.candidates(set(), selected)[0]["platform"] == "ios"


def test_partial_japan_evidence_cannot_fall_back_to_global(real_metadata):
    env = real_metadata
    source = game_bundle(env.tmp / "input", part="textures")
    unity_bundle(source, -2, cab="CAB-jp", payload=b"mod", references=["com.YostarJP.BlueArchive"])
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"], entry["source"]) == ("blocked", 'conversion_names', None)


@pytest.mark.parametrize("platforms,refs,expected", [
    ({"NoTarget"}, {"com.YostarJP.BlueArchive"}, [("japan", p) for p in mod_origin.PLATFORMS]),
    ({"iOS"}, set(), [(s, "ios") for s in mod_origin.SERVERS]),
])
def test_candidates_only_try_unknown_dimensions(platforms, refs, expected):
    choices = mod_origin.candidates(set(), integrity.Contents(platforms=platforms, references=refs))
    assert [(c["server"], c["platform"]) for c in choices] == expected


def test_path_hints_survive_real_bundle_inspection(tmp_path):
    source = old_bundle(tmp_path / "neutral.bundle", -2,
                          references=[r"archive:/com.nexon.bluearchive/GameData/Android/shared.bundle"])
    selected = inspect_bundle(source, allow_unknown=True)
    detected, reason = mod_origin.source_of(set(), selected, integrity.Contents(), {"server": "global"})
    assert detected == {"server": "global", "platform": "android", "detected": True}
    assert reason is None
    assert selected.references == {"shared.bundle"}, "dependency matching still uses basenames"


@pytest.mark.parametrize("matches", [False, True])
def test_fallback_inspects_each_file_once_per_analysis(real_metadata, monkeypatch, matches):
    from collections import Counter
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown",
                          name="test_spr_note" if matches else "unrelated")
    loads, reports = Counter(), []
    original_load, original_report = Bundle.load, env.library.inspect_import

    def load(path, *args, **kwargs):
        loads[path] += 1
        return original_load(path, *args, **kwargs)

    def report(*args, **kwargs):
        reports.append(kwargs.get("conversion", False))
        return original_report(*args, **kwargs)

    monkeypatch.setattr(Bundle, "load", load)
    monkeypatch.setattr(env.library, "inspect_import", report)
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == ("convert" if matches else "blocked")
    assert loads == {source: 1, env.original: 1}
    assert reports == [True]


@pytest.mark.parametrize("selected", [False, True])
@pytest.mark.parametrize("kind", ["Texture2D", "Mesh"])
def test_inference_rejects_only_selected_unreadable_assets(real_metadata, monkeypatch, kind, selected):
    from unittest.mock import Mock, PropertyMock
    from ba_modding_toolkit.models import AssetType
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown", payload=b"mod")
    load = Bundle.load

    def broken_load(path, *args, **kwargs):
        result = load(path, *args, **kwargs)
        if path in (source, env.original) or path.parent.name == "targets":
            data = Mock(m_Name="required", m_Width=1, m_Height=1, m_StreamData=None)
            type(data).image = PropertyMock(side_effect=ValueError("texture decode failed"))
            obj = Mock(type=AssetType[kind], peek_name=lambda: "required", read=lambda: data,
                       get_raw_data=lambda: b"archive:/CAB-missing/CAB-missing.resS" if path == source else b"official")
            result.env = SimpleNamespace(objects=[*result.env.objects, obj], files=result.env.files,
                                         file=result.env.file, container=result.env.container)
        return result

    monkeypatch.setattr(Bundle, "load", broken_load)
    env.services.batch_import.set_options({"types": ["TextAsset", kind] if selected else ["TextAsset"]})
    entry, = analyze(env, [source])["entries"]
    if selected:
        assert (entry["state"], entry["reason"], entry["source"]) == ("blocked", "required_asset_extract_failed", None)
    else:
        assert (entry["state"], entry["reason"]) == ("convert", None)
        result, = run(env, [entry], types=["TextAsset"])
        assert result["outcome"] == "updated" and result["applied"]


@pytest.mark.parametrize("manual", [False, True])
@pytest.mark.parametrize("counterpart", ["missing", "identical", "changed"])
def test_import_uses_current_counterparts_and_reports_omissions(real_metadata, monkeypatch, manual, counterpart):
    from tests.test_core.test_update_failures import asset
    from ba_modding_toolkit.models import AssetType
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown", payload=b"modded")
    before = env.original.read_bytes()
    load = Bundle.load

    def with_texture(path, *args, **kwargs):
        result = load(path, *args, **kwargs)
        if path == source or (counterpart != "missing" and (path == env.original or path.parent.name == "targets")):
            obj = asset("stock_page", AssetType.Texture2D, "extract")
            data = obj.read()
            data.m_Width = data.m_Height = 1
            data.m_StreamData = None
            obj.read = lambda: data
            obj.get_raw_data = lambda: b"mod texture" if counterpart == "changed" and path == source else b"stock texture"
            result.env = SimpleNamespace(objects=[*result.env.objects, obj], files=result.env.files,
                                         file=result.env.file, container=result.env.container)
        return result

    monkeypatch.setattr(Bundle, "load", with_texture)
    env.services.batch_import.set_options({"types": ["TextAsset", "Texture2D"]})
    entry, = analyze(env, [source])["entries"]
    if manual:
        entry = finish(env, rpc(env, "import.setSource", id=entry["id"], server="global", platform="android"))
    if counterpart == "changed" and not manual:
        assert (entry["state"], entry["reason"]) == ("blocked", "required_asset_extract_failed")
    else:
        assert entry["state"] == "convert", entry
        result, = run(env, [entry], types=["TextAsset", "Texture2D"])
        if counterpart == "changed":
            assert (result["outcome"], result["reason"]) == ("failed", "required_asset_extract_failed")
        else:
            assert result["outcome"] == "updated" and result["applied"]
            assert result.get("notTransferred", []) == (["[Texture2D] stock_page"] if counterpart == "missing" else [])
            assert Bundle.load(env.original).env.objects[0].read().m_Script == "modded"
    if counterpart == "changed":
        assert not env.library.mods() and env.original.read_bytes() == before


@pytest.mark.parametrize("method", ["bundle", "inspect", "keys", "readable_keys"])
@pytest.mark.parametrize("replacement", [False, True])
def test_inspection_rejects_changed_file_revision(tmp_path, method, replacement):
    from ba_modding_toolkit.errors import ServiceError
    source = unity_bundle(tmp_path / "source.bundle")
    inspection = integrity.Inspection()
    getattr(inspection, method)(source)
    stamp = source.stat()
    if replacement:
        other = unity_bundle(tmp_path / "other.bundle", payload=b"modified")
        os.utime(other, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        other.replace(source)
    else:
        source.write_bytes(source.read_bytes() + b"changed")
    with pytest.raises(ServiceError, match="entry_changed"):
        getattr(inspection, method)(source)


def test_judge_rejects_input_changed_before_library_identity(real_metadata, monkeypatch):
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown", payload=b"mod")
    report = env.library.inspect_import

    def changed(*args, **kwargs):
        unity_bundle(source, 19, name="unrelated", payload=b"replacement")
        return report(*args, **kwargs)

    monkeypatch.setattr(env.library, "inspect_import", changed)
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == ("blocked", "entry_changed")
    assert not env.library.mods()


def test_judge_rejects_input_changed_during_library_identity(real_metadata, monkeypatch):
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown", payload=b"mod")
    identity = env.library._identity

    def changed(files):
        result = identity(files)
        if source in files.values():
            source.write_bytes(source.read_bytes() + b"changed")
        return result

    monkeypatch.setattr(env.library, "_identity", changed)
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == ("blocked", "entry_changed")
    assert not env.library.mods()


def test_inspection_rejects_a_file_changed_during_load(tmp_path, monkeypatch):
    from ba_modding_toolkit.errors import ServiceError
    source = unity_bundle(tmp_path / "source.bundle")
    load = Bundle.load

    def changed(path):
        result = load(path)
        path.write_bytes(path.read_bytes() + b"changed")
        return result

    monkeypatch.setattr(Bundle, "load", changed)
    with pytest.raises(ServiceError, match="entry_changed"):
        integrity.Inspection().bundle(source)


def test_inference_reports_a_revision_change_during_extraction(real_metadata, monkeypatch):
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown", payload=b"mod")
    extract = Bundle.extract_patch

    def changed(self, *args, **kwargs):
        result = extract(self, *args, **kwargs)
        if self.path == source:
            source.write_bytes(source.read_bytes() + b"changed")
        return result

    monkeypatch.setattr(Bundle, "extract_patch", changed)
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"]) == ("blocked", "entry_changed")


@pytest.mark.parametrize("manual", [False, True])
@pytest.mark.parametrize("failure", ["extract", "apply"])
def test_required_asset_failure_never_imports_or_applies_a_partial_mod(real_metadata, monkeypatch, manual, failure):
    from unittest.mock import Mock, PropertyMock
    from ba_modding_toolkit.models import AssetType
    env = real_metadata
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown", payload=b"modded")
    entry, = analyze(env, [source])["entries"]
    if manual:
        entry = finish(env, rpc(env, "import.setSource", id=entry["id"], server="global", platform="android"))
    before = env.original.read_bytes()
    load = Bundle.load

    def broken_load(path, *args, **kwargs):
        result = load(path, *args, **kwargs)
        if failure == "extract":
            data = Mock(m_Name="required_texture", m_Width=1, m_Height=1, m_StreamData=None)
            type(data).image = PropertyMock(side_effect=ValueError("texture decode failed"))
            obj = Mock(type=AssetType.Texture2D, peek_name=lambda: "required_texture", read=lambda: data,
                       get_raw_data=lambda: b"modded" if path == source else b"official")
            objects = [*result.env.objects, obj]
        elif failure == "apply" and path.parent.name == "targets":
            data = Mock(m_Name="test_spr_note", m_Script="official")
            data.save.side_effect = ValueError("texture or text write failed")
            objects = [Mock(type=AssetType.TextAsset, peek_name=lambda: "test_spr_note", read=lambda: data)]
        else:
            return result
        result.env = SimpleNamespace(objects=objects, files=result.env.files,
                                     file=result.env.file, container=result.env.container)
        return result

    monkeypatch.setattr(Bundle, "load", broken_load)
    result, = run(env, [entry], types=["Texture2D", "TextAsset"])
    assert result["outcome"] == "failed"
    assert result["reason"] == f"required_asset_{failure}_failed"
    assert result["params"]["name"] == ("required_texture" if failure == "extract" else "test_spr_note")
    assert result["params"]["error"]
    assert result["params"]["file"] == (source.name if failure == "extract" else env.original.name)
    assert not result["applied"] and not env.library.mods()
    assert env.original.read_bytes() == before


def test_inference_must_decode_atlas_text(real_metadata):
    env = real_metadata
    official_bundle(env, name="test_spr.atlas", payload=b"page.png\nsize: 1,1\n")
    source = old_bundle(env.tmp / "input" / env.original.name, -2, cab="CAB-unknown",
                          name="test_spr.atlas", payload=b"\xff\xfe\xff")
    entry, = analyze(env, [source])["entries"]
    assert (entry["state"], entry["reason"], entry["source"]) == ("blocked", "required_asset_extract_failed", None)


def test_partial_cab_region_evidence_constrains_candidates():
    selected = integrity.Contents(platforms={"NoTarget"}, files={"cab-official"})
    official = integrity.Contents(files={"cab-official"})
    choices = mod_origin.candidates(set(), selected, official, {"server": "japan"})
    assert [(c["server"], c["platform"]) for c in choices] == [("japan", p) for p in mod_origin.PLATFORMS]
