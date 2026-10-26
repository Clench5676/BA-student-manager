"""Deletion rows and undo paths use only synthetic game files and temporary libraries."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import json

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import service, portrait_edit, asset_delete
from ba_modding_toolkit.library.photographs import Photographs
from ba_modding_toolkit.library.judge import core_of
from ba_modding_toolkit.webui.state import UiState
from ba_modding_toolkit.webui.photography import Photography
from test_library_profiles import world, japan, pin_of, OFFICIAL
from test_library import header_bundle
from ba_modding_toolkit.utils import CRCUtils
from test_photographs import capture


def test_official_requests_are_rejected_and_official_looking_user_sources_are_deletable(world):
    for action in [lambda: world.library.remove('official', confirm=True),
                   lambda: world.library.delete_photograph('test', 'official', confirm=True)]:
        with pytest.raises(ServiceError, match='asset_official'):
            action()
    mod = world.add(world.spr, payload=b'official')
    assert not world.library.remove(mod.id).failed
    assert not mod.file.exists()


def test_applied_and_deferred_sources_require_confirmation_before_any_change(world):
    mod = world.add(world.spr)
    for enabled in [True, False]:
        if not enabled:
            world.toggle(False)
        world.library.apply('test', 'mod:' + mod.id)
        before = world.spr.read_bytes(), deepcopy(world.profiles())
        with pytest.raises(ServiceError, match='asset_delete_confirm'):
            world.library.remove(mod.id)
        assert (world.spr.read_bytes(), world.profiles()) == before
        assert mod.file.exists()
    world.library._write_check = lambda *_: pytest.fail('Deletion wrote game files with Mods off')
    assert not world.library.remove(mod.id, confirm=True).failed
    assert world.spr.read_bytes() == OFFICIAL
    assert not world.folder()['configured']


@pytest.mark.parametrize('failure', ['cleanup', 'reconcile'])
def test_failure_after_restoration_undoes_game_source_and_configuration(world, monkeypatch, failure):
    mod = world.add(world.spr)
    world.library.apply('test', 'mod:' + mod.id)
    before = world.spr.read_bytes(), deepcopy(world.profiles())
    real = service.shutil.rmtree
    fired = []
    def fail(path, *args, **kwargs):
        if Path(path) == mod.file.parent and not fired:
            fired.append(True)
            # Exercise partially completed cleanup, too.
            mod.file.unlink()
            raise OSError('Synthetic cleanup failure')
        return real(path, *args, **kwargs)
    if failure == 'cleanup':
        monkeypatch.setattr(service.shutil, 'rmtree', fail)
    def reconcile():
        if failure == 'reconcile':
            raise OSError('Synthetic preview publication failure')
    with pytest.raises(ServiceError, match='library_io_error'):
        world.library.remove(mod.id, confirm=True, reconcile=reconcile)
    assert mod.file.exists()
    assert world.library.mods() == [mod]
    assert (world.spr.read_bytes(), world.profiles()) == before
    assert not list((world.root / 'asset-deletions').glob('*/journal.json'))


def test_multi_install_failure_rolls_back_earlier_success(world):
    folder = japan(world)
    mod = world.add(world.spr)
    pins = [world.library.current_pin(), pin_of(world, folder)]
    for pin in pins:
        world.library.apply('test', 'mod:' + mod.id, pin=pin)
    before = {path: path.read_bytes() for pin in pins for path in world.library._index(pin)['test_spr']}
    config = deepcopy(world.profiles())
    last = max(pin.key for pin in pins)
    def check(pin):
        if pin.key == last:
            raise ServiceError('game_running')
    world.library._write_check = check
    result = world.library.remove(mod.id, confirm=True)
    assert result.failed[0]['code'] == 'game_running' and not result.done
    assert all(path.read_bytes() == raw for path, raw in before.items())
    assert world.profiles() == config and mod.file.exists()


def test_preview_source_reconciliation_keeps_hall_placement_and_other_skins(tmp_path):
    state = UiState(tmp_path / 'ui.json')
    state.set_preview_source('install', 'a', 'spr', 'mod:gone')
    state.set_preview_source('install', 'b', 'lobby', 'mod:gone')
    state.set_preview_source('install', 'b', 'model', 'mod:keep')
    hall = {'revision': 4, 'portraits': [{'id': 'one', 'variant': 'a', 'source': 'mod:gone', 'x': 480}],
            'memorials': [{'id': 'two', 'variant': 'b', 'source': 'mod:gone'}], 'active': 'two'}
    state.set('student_hall', hall)
    state.reconcile_deleted_source('mod:gone', lambda variant, kind: 'official')
    assert state.preview_sources('install', 'a') == {'spr': 'official'}
    assert state.preview_sources('install', 'b') == {'lobby': 'official', 'model': 'mod:keep'}
    assert state.get('student_hall')['portraits'][0]['x'] == 480
    assert state.get('student_hall')['active'] == 'two'


@pytest.fixture
def recipes(world, monkeypatch):
    lib = world.library
    lib.photographs.family_of = lambda _: 'same-family'
    # Model a Collection with three textures; real Unity encoding has separate verified-asset tests.
    initial = {'a': 'official-a', 'b': 'official-b', 'c': 'official-c'}
    def encode(values): return header_bundle(json.dumps(values, sort_keys=True).encode())
    # Header length is fixed for these synthetic UnityFS files.
    offset = len(header_bundle(b''))
    def decode(path): return json.loads(path.read_bytes()[offset:])
    raw=encode(initial)
    target=world.game / f'uis-01_common-14_charactercollect-_mxload-2026-01-01_000_assets_all_{CRCUtils.compute_crc32(raw)}.bundle'
    target.write_bytes(raw)
    keys = [lib.photographs.save('test', capture(color=(n, 90, 170, 255))[0], 'portrait')['saved'] for n in [10, 20]]
    def patch(base, official, output, edits, **kwargs):
        values = decode(base); original = decode(official)
        for name, image in edits.items(): values[name] = original[name] if image is None else 'custom-' + name
        output.write_bytes(encode(values))
    monkeypatch.setattr(portrait_edit, 'patch_portraits', patch)
    monkeypatch.setattr(lib, '_install_direct', lambda record, targets, *args, **kwargs: {p: lib._paths(record)[0] for p in targets})
    core = core_of(target.name)
    lib._indexes.clear()
    pin = lib.current_pin()
    def apply(name, key):
        return portrait_edit.apply(lib, {'a':'skin-a','b':'skin-b','c':'skin-c'}[name], key, lib.photographs.image('test', key) if key else None,
                                   {'bundle': target.name, 'name': name}, pin, lambda _: None, None)
    apply('a', keys[0]); apply('b', keys[0]); apply('c', keys[1])
    return world, target, keys, decode, core


@pytest.mark.parametrize('enabled', [True, False])
def test_gallery_applied_uses_each_collection_target_while_other_skin_deletion_stays_protected(recipes, enabled):
    world, target, _, _, _ = recipes
    lib = world.library
    variants = {'skin-a': 'a', 'skin-b': 'b'}
    for key, name in variants.items():
        lib.catalog.variants[key] = SimpleNamespace(key=key, family='test', portrait=name, spr=None, lobby=None, names={})
    keys = [lib.photographs.save(variant, capture(color=(n, 80, 160, 255))[0], 'portrait')['saved']
            for variant, n in zip(variants, [30, 40])]
    for variant, key in zip(variants, keys):
        lib.apply_photograph(variant, key, {'bundle': target.name, 'name': variants[variant]})
    if not enabled:
        world.toggle(False)
    api = Photography(SimpleNamespace(
        library=lib, photographs=lib.photographs,
        catalog=SimpleNamespace(variant=lambda key: SimpleNamespace(portrait=variants.get(key), names={})),
        game=SimpleNamespace(resource_version='synthetic', collection_target=lambda name: {'bundle': target.name, 'name': name})))
    for variant, key, other in [('skin-a', keys[0], keys[1]), ('skin-b', keys[1], keys[0])]:
        result = api.list(variant)
        assert {entry['id'] for entry in result['photos'] if entry['applied']} == {key}
        assert result['game']['id'] == key and result['game']['enabled'] == enabled
        assert api.removal_info(variant, other)['used']
        with pytest.raises(ServiceError, match='asset_delete_confirm'):
            lib.delete_photograph(variant, other)


@pytest.mark.parametrize('enabled', [True, False])
def test_shared_photo_deletion_reconciles_all_skins_and_preserves_other_textures(recipes, enabled):
    world, target, keys, decode, core = recipes
    lib = world.library
    lib.photographs.family_of = lambda _: 'same-family'
    lib.photographs.select('skin-a', keys[0]);lib.photographs.select('skin-b', keys[0])
    if not enabled:
        world.toggle(False)
    before = target.read_bytes(), target.stat().st_mtime_ns
    with pytest.raises(ServiceError, match='asset_delete_confirm'):
        lib.delete_photograph('skin-a', keys[0])
    if not enabled:
        lib._write_check = lambda *_: pytest.fail('Mods-off photo deletion wrote the game')
    lib.delete_photograph('skin-a', keys[0], confirm=True)
    assert lib.photographs.selection('skin-a') is None and lib.photographs.selection('skin-b') is None
    assert keys[0] not in portrait_edit.in_use(lib) and keys[1] in portrait_edit.in_use(lib)
    assert not lib.photographs._path(keys[0]).exists() and lib.photographs.image('test', keys[1])
    if enabled:
        assert decode(target) == {'a': 'official-a', 'b': 'official-b', 'c': 'custom-c'}
    else:
        assert (target.read_bytes(), target.stat().st_mtime_ns) == before


@pytest.mark.parametrize('failure',['unlink','manifest'])
def test_photo_cleanup_failure_restores_shared_recipes_and_preview_choices(recipes, monkeypatch, failure):
    world, target, keys, decode, core = recipes
    lib = world.library;key = keys[0]
    lib.photographs.select('test', key)
    before = target.read_bytes(), deepcopy(world.profiles())
    real = Path.unlink;fired = []
    def fail(path, *args, **kwargs):
        if path == lib.photographs._path(key) and not fired:
            fired.append(True);raise OSError('Photo cleanup failed')
        return real(path, *args, **kwargs)
    if failure == 'unlink':
        monkeypatch.setattr(Path, 'unlink', fail)
    else:
        from ba_modding_toolkit.library import photographs
        write = photographs.atomic_json
        def publish(path, data):
            write(path, data)
            if key not in data['photos'] and not fired:
                fired.append(True);raise OSError('Photo manifest flush failed')
        monkeypatch.setattr(photographs, 'atomic_json', publish)
    with pytest.raises(ServiceError, match='library_io_error'):
        lib.delete_photograph('test', key, confirm=True)
    assert (target.read_bytes(), world.profiles()) == before
    assert lib.photographs.selection('test') == key
    assert lib.photographs.image('test', key)


def test_applied_only_photo_recipe_is_reconciled_without_losing_neighbours(recipes):
    world, target, keys, decode, core = recipes
    world.library.profiles.update(lambda data: data['folders'][world.key()]['configured'].clear())
    world.library.delete_photograph('test', keys[0], confirm=True)
    assert decode(target) == {'a': 'official-a', 'b': 'official-b', 'c': 'custom-c'}
    assert keys[1] in portrait_edit.in_use(world.library)


def test_permanent_photo_writer_failure_keeps_every_reference(recipes):
    world, target, keys, decode, core = recipes
    before = target.read_bytes(), deepcopy(world.profiles())
    world.library._write_check = lambda *_: (_ for _ in ()).throw(ServiceError('classic_open'))
    with pytest.raises(ServiceError, match='classic_open'):
        world.library.delete_photograph('test', keys[0], confirm=True)
    assert (target.read_bytes(), world.profiles()) == before
    assert world.library.photographs.image('test', keys[0])


def test_generated_preview_is_managed_and_deletable_without_official_reclassification(tmp_path):
    store = Photographs(tmp_path)
    key = store.save('a', capture()[0], 'portrait', builtin=True)['saved']
    store.select('a', key)
    entry = store.list('a')['photos'][0]
    assert entry['provenance'] == 'generated' and entry['managed']
    store.delete('a', key)
    assert store.selection('a') is None and not store.list('a')['photos']


def test_outer_recovery_restores_a_deleted_source_and_profiles(world):
    mod = world.add(world.spr)
    world.toggle(False);world.library.apply('test', 'mod:' + mod.id)
    config = deepcopy(world.profiles())
    deletion = asset_delete.Deletion(world.library)
    deletion.publish();deletion.remember_mods([mod.id])
    del world.library._records[mod.id];world.library._save()
    world.library.profiles.update(lambda data: data['folders'][world.key()]['configured'].clear())
    service.shutil.rmtree(mod.file.parent)
    # A new instance recovers under transactions.lock before accepting another operation.
    from ba_modding_toolkit.library import ModLibrary
    restored = ModLibrary(world.root, world.library.catalog, object(), world.settings)
    assert mod.file.exists() and restored.mods() == [mod]
    assert restored.profiles.read()['enabled'] == config['enabled']
    assert restored.profiles.read()['folders'][world.key()]['configured'] == config['folders'][world.key()]['configured']
    assert not list((world.root / 'asset-deletions').glob('*/journal.json'))


def test_preview_fallback_deduplicates_hall_sources_and_leaves_unrelated_revision_alone(tmp_path):
    state = UiState(tmp_path / 'ui.json')
    hall = {'revision': 2, 'portraits': [], 'memorials': [
        {'id': 'official', 'variant': 'a', 'source': 'official'},
        {'id': 'removed', 'variant': 'a', 'source': 'mod:gone'}], 'active': 'removed'}
    state.set('student_hall', hall)
    state.reconcile_deleted_source('mod:other', lambda *args: 'official')
    assert state.get('student_hall') == hall
    state.reconcile_deleted_source('mod:gone', lambda *args: 'official')
    after = state.get('student_hall')
    assert after['memorials'] == hall['memorials'][:1]
    assert after['active'] == 'official' and after['revision'] == 3
