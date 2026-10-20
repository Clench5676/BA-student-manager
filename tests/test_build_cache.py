"""Reapply reuses only configured instant-On copies with the complete build key."""

import hashlib

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library.storage import Fingerprints
from ba_modding_toolkit.utils import CRCUtils

from test_library import game_bundle, header_bundle, make_mod, reload_library, setup_library


def builder(env, monkeypatch):
    calls = []

    def build(record, targets, work, log, progress, pin):
        calls.append(record['id'])
        work.mkdir(parents=True, exist_ok=True)
        output = work / targets[0].name
        output.write_bytes(header_bundle(b'built:' + env.library._paths(record)[0].read_bytes()))
        return {targets[0]: output}

    monkeypatch.setattr(env.library, '_install_direct', build)
    return calls


def test_reapply_reuses_only_a_referenced_build_after_restart(setup_library, monkeypatch):
    env = setup_library
    mod, = env.library.add([make_mod(env.original, env.tmp / 'upload')])
    calls = builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}')
    built = env.original.read_bytes()
    assert not (env.root / 'built').exists()
    assert env.library.status()['builtSize'] == 0
    assert env.library.apply('test', f'mod:{mod.id}').unchanged
    assert calls == [mod.id, mod.id]  # no configured instant-On copy yet
    env.library.toggle(False, True)
    kept, = (env.root / 'built').iterdir()
    assert kept.suffix == '.bundle' and kept.read_bytes() == built
    env.library.toggle(True, False)
    env.library = reload_library(env)
    calls = builder(env, monkeypatch)
    assert env.library.apply('test', f'mod:{mod.id}').unchanged
    assert calls == []
    assert env.library.status()['builtSize'] == kept.stat().st_size
    assert env.library.clear_built() == len(built)
    assert env.library.status()['builtSize'] == 0
    env.library.apply('test', f'mod:{mod.id}')
    assert calls == [mod.id]
    assert not list((env.root / 'built').iterdir())


@pytest.mark.parametrize('core, kind', [('test_spr', 'spr'), ('test_home_gl', 'lobby')])
def test_restore_removes_the_only_retained_build_and_reapply_rebuilds(setup_library, monkeypatch, core, kind):
    env = setup_library
    target = env.original if kind == 'spr' else game_bundle(env.game_dir, core)
    official = target.read_bytes()
    mod, = env.library.add([make_mod(target, env.tmp / 'upload')])
    builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}', kind=kind)
    env.library.toggle(False, True)
    env.library.toggle(True, False)
    assert env.library.status()['builtSize'] > 0
    env.library.restore('test', kind=kind)
    assert target.read_bytes() == official
    assert not list((env.root / 'built').rglob('*.bundle'))
    assert env.library.status()['builtSize'] == 0
    env.library = reload_library(env)
    calls = builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}', kind=kind)
    assert calls == [mod.id]
    assert not list((env.root / 'built').iterdir())


@pytest.mark.parametrize('kind', ['spr', 'lobby'])
def test_refused_apply_leaves_no_persistent_build(setup_library, monkeypatch, kind):
    env = setup_library
    target = env.original if kind == 'spr' else game_bundle(env.game_dir, 'test_home_gl')
    official = target.read_bytes()
    mod, = env.library.add([make_mod(target, env.tmp / 'upload')])
    calls = builder(env, monkeypatch)

    def refuse(pin):
        raise ServiceError('game_running')

    monkeypatch.setattr(env.library, '_write_check', refuse)
    with pytest.raises(ServiceError, match='game_running'):
        env.library.apply('test', f'mod:{mod.id}', kind=kind)
    assert calls == [mod.id] and target.read_bytes() == official
    assert not (env.root / 'built').exists()
    assert env.library.status()['builtSize'] == 0


@pytest.mark.parametrize('change', ['source', 'options', 'copy', 'version', 'target'])
def test_changed_inputs_options_program_targets_and_corrupt_copy_force_rebuild(setup_library, monkeypatch, change):
    env = setup_library
    mod, = env.library.add([make_mod(env.original, env.tmp / 'upload')])
    calls = builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}')
    env.library.toggle(False, True)
    env.library.toggle(True, False)
    if change == 'source':
        mod.file.write_bytes(header_bundle(b'changed source'))
    elif change == 'options':
        env.settings.set('compression_method', 'lz4')
    elif change == 'copy':
        cached, = (env.root / 'built').glob('*.bundle')
        cached.write_bytes(header_bundle(b'changed copy'))
    elif change == 'version':
        monkeypatch.setattr('ba_modding_toolkit.library.service._build_version', lambda: 'another version')
    else:
        env.original.unlink()
        env.original = game_bundle(env.game_dir, date='2026-02-01', payload=b'new official target')
    env.library.apply('test', f'mod:{mod.id}')
    assert calls == [mod.id, mod.id]
    assert not (env.root / 'built' / 'reuse').exists()


def test_fingerprints_compute_both_hashes_and_revalidate_changed_file(tmp_path):
    path = tmp_path / 'payload.bundle'
    path.write_bytes(header_bundle(b'A' * (2 * 1024 * 1024)))
    hashes = Fingerprints()
    first = hashes.get(path)
    assert first.sha1 == hashlib.sha1(path.read_bytes()).hexdigest()
    assert first.crc == CRCUtils.compute_crc32(path)
    assert hashes.get(path) is first
    path.write_bytes(header_bundle(b'B' * (2 * 1024 * 1024)))
    second = hashes.get(path)
    assert second.sha1 != first.sha1 and second.crc != first.crc
    assert second.crc == CRCUtils.compute_crc32(path)
