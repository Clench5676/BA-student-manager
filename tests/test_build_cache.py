"""Prepared bundles are reusable, but every source, target and option remains part of the build."""

import hashlib
from pathlib import Path

import pytest

from ba_modding_toolkit.library.storage import Fingerprints
from ba_modding_toolkit.utils import CRCUtils

from test_library import header_bundle, make_mod, reload_library, setup_library


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


def test_reapply_and_restore_reuse_identical_prepared_bytes_after_restart(setup_library, monkeypatch):
    env = setup_library
    mod, = env.library.add([make_mod(env.original, env.tmp / 'upload')])
    official = env.original.read_bytes()
    calls = builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}')
    built = env.original.read_bytes()
    assert calls == [mod.id]
    assert env.library.apply('test', f'mod:{mod.id}').unchanged
    assert calls == [mod.id]
    env.library.restore('test')
    assert env.original.read_bytes() == official
    env.library = reload_library(env)
    calls = builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}')
    assert calls == [] and env.original.read_bytes() == built
    assert env.library.status()['builtSize'] > 0
    freed = env.library.clear_built()
    assert freed > 0 and env.library.status()['builtSize'] == 0
    env.library.restore('test')
    env.library.apply('test', f'mod:{mod.id}')
    assert calls == [mod.id] and env.original.read_bytes() == built


@pytest.mark.parametrize('change', ['source', 'options', 'cache'])
def test_changed_inputs_options_and_corrupt_cache_force_rebuild(setup_library, monkeypatch, change):
    env = setup_library
    mod, = env.library.add([make_mod(env.original, env.tmp / 'upload')])
    calls = builder(env, monkeypatch)
    env.library.apply('test', f'mod:{mod.id}')
    if change == 'source':
        mod.file.write_bytes(header_bundle(b'changed source'))
    elif change == 'options':
        env.settings.set('compression_method', 'lz4')
    else:
        cached, = (env.root / 'built' / 'reuse').glob('*/*.bundle')
        cached.write_bytes(header_bundle(b'changed cache'))
    env.library.apply('test', f'mod:{mod.id}')
    assert calls == [mod.id, mod.id]


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


def test_reusable_builds_are_trimmed_to_the_most_recent(setup_library, monkeypatch):
    from ba_modding_toolkit.library import service

    env = setup_library
    monkeypatch.setattr(service, 'REUSE_KEPT', 2)
    mod, = env.library.add([make_mod(env.original, env.tmp / 'upload')])
    builder(env, monkeypatch)
    for method in ('lzma', 'lz4', 'none'):
        env.settings.set('compression_method', method)
        env.library.apply('test', f'mod:{mod.id}')
        env.library.restore('test')
    assert len([p for p in (env.root / 'built' / 'reuse').iterdir() if p.is_dir()]) <= 2
