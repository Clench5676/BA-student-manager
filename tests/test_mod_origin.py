"""Origin detection and classic conversions using generated UnityFS bundles only."""

import os
import struct
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import mod_origin
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.library import integrity
from ba_modding_toolkit.library.integrity import inspect as inspect_bundle
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


def official_bundle(env, platform=19):
    unity_bundle(env.original, platform)
    prefix = env.original.name.rsplit('_', 1)[0]
    renamed = env.original.with_name(f'{prefix}_{CRCUtils.compute_crc32(env.original.read_bytes())}.bundle')
    env.original.rename(renamed)
    env.original = renamed


@pytest.fixture
def real_metadata(env, monkeypatch):
    monkeypatch.setattr(integrity, 'inspect', inspect_bundle)
    monkeypatch.setattr(batch_import, '_asset_match', _asset_match)
    official_bundle(env)
    return env


@pytest.mark.parametrize('platform,source_platform,target_platform', [(13, 'android', 19), (9, 'ios', 19),
                                                                    (19, 'windows', 13), (19, 'windows', 9)])
def test_conversion_update_add_apply_uses_real_classic_core(real_metadata, platform, source_platform, target_platform):
    env = real_metadata
    official_bundle(env, target_platform)
    source = unity_bundle(env.tmp / 'input' / env.original.name, platform, cab='CAB-source', payload=b'modded',
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


def test_cross_server_matching_filename_converts_instead_of_copying(real_metadata):
    env = real_metadata
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-jp', payload=b'JP mod',
                          references=['com.Yostar JP.BlueArchive'])
    entry, = analyze(env, [source])['entries']
    assert entry['source']['server'] == 'japan' and entry['target']['server'] == 'global'
    assert entry['state'] == 'convert'
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'updated' and result['applied']
    assert Bundle.load(env.original).env.objects[0].read().m_Script == 'JP mod'
    assert inspect_bundle(env.original).platforms == {'StandaloneWindows64'}


@pytest.mark.parametrize('platform', [13, -2])
def test_unknown_source_set_source_reanalyzes_and_persists_for_run_and_recheck(real_metadata, platform):
    env = real_metadata
    source = unity_bundle(env.tmp / 'input' / env.original.name, platform, cab='CAB-unknown', payload=b'unknown mod')
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason'], entry['source']) == ('blocked', 'source_unknown', None)
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
    source = unity_bundle(env.tmp / 'input' / env.original.name, platform, references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    assert (entry['state'], entry['reason']) == ('blocked', reason)
    assert env.services.batch_import.preview(entry['preview']['key'])[1][-1] == source


def test_conversion_without_matching_assets_is_blocked_but_previewable(real_metadata):
    env = real_metadata
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, payload=b'mod', name='unrelated',
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
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-unknown')
    entry, = analyze(env, [source])['entries']
    result = env.rpc.call('import.setSource', {'id': entry['id'], 'server': server, 'platform': platform})
    assert result['error']['code'] == 'bad_params'


def test_set_source_rejects_changed_upload(real_metadata):
    env = real_metadata
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-unknown')
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
    source = unity_bundle(env.tmp / 'input' / env.original.name, 19, cab='CAB-jp', payload=b'JP mod',
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
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-mobile', payload=b'mod',
                          references=['com.nexon.bluearchive'])
    entry, = analyze(env, [source])['entries']
    before = env.original.read_bytes()
    monkeypatch.setattr(batch_import.core, 'process_mod_update', lambda **kwargs: ModUpdateResult(False, 'failed', []))
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'failed' and result['reason'] == 'conversion_failed'
    assert not result['applied'] and not env.library.mods() and env.original.read_bytes() == before


def test_converted_output_still_requires_full_dependency_validation(real_metadata, monkeypatch):
    from ba_modding_toolkit.models import FilePair, ModUpdateResult

    env = real_metadata
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-mobile', payload=b'mod',
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
    source = unity_bundle(env.tmp / 'input' / env.original.name, 19, cab='CAB-unknown', payload=b'mod')
    entry, = analyze(env, [source])['entries']
    assert entry['source'] is None and entry['reason'] == 'source_unknown'
    selected = finish(env, rpc(env, 'import.setSource', id=entry['id'], server='global', platform='windows'))
    assert selected['state'] == 'ready' and selected['source']['detected'] is False
    assert run(env, [selected])[0]['applied']


def test_installed_mobile_bytes_do_not_bypass_conversion(real_metadata):
    env = real_metadata
    official = env.original.read_bytes()
    source = unity_bundle(env.tmp / 'input' / env.original.name, 13, cab='CAB-mobile', payload=b'mobile mod',
                          references=['com.nexon.bluearchive'])
    env.original.with_name(env.original.name + '.backup').write_bytes(official)
    env.original.write_bytes(source.read_bytes())
    entry, = analyze(env, [source])['entries']
    assert entry['state'] == 'convert' and entry['target']['platform'] == 'windows'
    result, = run(env, [entry], types=['TextAsset'])
    assert result['outcome'] == 'updated' and result['applied']
    assert inspect_bundle(env.original).platforms == {'StandaloneWindows64'}
