"""Real Collection compositions use verified test assets and temporary game copies only."""

import base64
import hashlib
import io
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.gameassets import AssetCache, GameAssets
from ba_modding_toolkit.gameassets.unity import open_bundle, find_object
from ba_modding_toolkit.library import ModLibrary, safety, storage
from ba_modding_toolkit.library import portrait_edit
from ba_modding_toolkit.library.judge import core_of
from ba_modding_toolkit.searching import get_search_dirs
from test_library import FakeCatalog, FakeVariant

GAME = Path(os.environ.get('BAMT_TEST_GAME_DIR', '/nonexistent/bamt-verified-game'))


@pytest.fixture(scope='module')
def collection_original(tmp_path_factory):
    if not GAME.is_dir():
        pytest.skip('No verified game test assets')
    game = GameAssets(get_search_dirs(GAME), AssetCache(tmp_path_factory.mktemp('photo-cache'), allowed=False))
    names = ['Student_Portrait_Shiroko_ridingsuit_Collection', 'Student_Portrait_Shiroko_Collection']
    try:
        records = [game.collection_target(name) for name in names]
    except ServiceError:
        pytest.skip('Collection fixture is unavailable')
    if records[0]['bundle'] != records[1]['bundle']:
        pytest.skip('No shared Collection fixture')
    return game._bundle_path(records[0]['bundle']), records


@pytest.fixture
def environment(tmp_path, monkeypatch, collection_original):
    source, records = collection_original
    folder = tmp_path / 'game';folder.mkdir()
    target = folder / source.name
    if not storage.atomic_clone(source, target):
        shutil.copy2(source, target)
    target.chmod(target.stat().st_mode | 0o200)
    a, b = FakeVariant('a', 'a_spr'), FakeVariant('b', 'b_spr')
    a.portrait, b.portrait = records[0]['name'], records[1]['name']
    settings = Settings(tmp_path / 'config.toml')
    settings.set('game_resource_dir', str(folder));settings.set('compression_method', 'lz4')
    settings.set('enable_crc_correction', 'true')
    game = GameAssets([folder], AssetCache(tmp_path / 'cache', allowed=False))
    monkeypatch.setattr(safety, 'check_game_not_running', lambda: None)
    library = ModLibrary(tmp_path / 'library', FakeCatalog(a, b), game, settings)
    keys = []
    for key, color in [('a', (20, 130, 220, 255)), ('b', (210, 50, 140, 255))]:
        stream = io.BytesIO();Image.new('RGBA', (202, 228), color).save(stream, format='PNG')
        png = 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()
        keys.append(library.photographs.save(key, png, 'portrait')['saved'])
    return SimpleNamespace(library=library, game=game, target=target, records=records, keys=keys,
                           original=source.read_bytes(), folder=folder)


def test_shared_choices_individual_default_and_master_switch(environment):
    e = environment;lib = e.library;pin = lib.current_pin()
    lib.apply_photograph('a', e.keys[0], e.records[0], pin)
    lib.apply_photograph('b', e.keys[1], e.records[1], pin)
    assert lib.photograph_choice(e.records[0], pin)['id'] == e.keys[0]
    assert lib.photograph_choice(e.records[1], pin)['id'] == e.keys[1]
    lib.apply_photograph('a', None, e.records[0], pin)
    assert lib.photograph_choice(e.records[1], pin)['id'] == e.keys[1]
    with open_bundle(e.target) as env:
        assert find_object(env, e.records[1]).read().image.convert('RGBA').getpixel((0, 0)) == (210, 50, 140, 255)
    lib.toggle(False, True, [pin]);assert e.target.read_bytes() == e.original
    result = lib.apply_photograph('a', e.keys[0], e.records[0], pin)
    assert result.deferred and e.target.read_bytes() == e.original
    lib.toggle(True, False, [pin])
    assert lib.photograph_choice(e.records[0], pin)['id'] == e.keys[0]
    lib.apply_photograph('a', None, e.records[0], pin)
    lib.apply_photograph('b', None, e.records[1], pin)
    assert e.target.read_bytes() == e.original
    assert not lib.other_mods(pin)
    assert lib.photographs.list('a')['photos']


def test_game_state_publication_failure_rolls_back_the_whole_bundle(environment, monkeypatch):
    e = environment;lib = e.library
    save = lib._save
    fired = []
    def fail_after_game_write():
        if any(record.get('source', '').startswith('mod:') for record in lib._applied.values()):
            fired.append(True)
            raise OSError('Synthetic state-publication failure')
        return save()
    monkeypatch.setattr(lib, '_save', fail_after_game_write)
    with pytest.raises(ServiceError):
        lib.apply_photograph('a', e.keys[0], e.records[0])
    assert fired
    assert e.target.read_bytes() == e.original
    assert lib.photographs.image('a', e.keys[0])
    assert not list((lib.root / 'transactions').glob('*/journal.json'))


def test_outside_change_during_preparation_is_preserved(environment, monkeypatch):
    e = environment;original = portrait_edit.patch_portraits
    changed = e.original + b'external-change'
    def replace_during_prepare(*args, **kwargs):
        original(*args, **kwargs)
        e.target.write_bytes(changed)
    monkeypatch.setattr(portrait_edit, 'patch_portraits', replace_during_prepare)
    with pytest.raises(ServiceError, match='entry_changed'):
        e.library.apply_photograph('a', e.keys[0], e.records[0])
    assert e.target.read_bytes() == changed


def test_reset_game_file_keeps_intent_but_allows_reapplying(environment):
    e = environment;lib = e.library
    lib.apply_photograph('a', e.keys[0], e.records[0])
    e.target.write_bytes(e.original)
    state = lib.photograph_choice(e.records[0])
    assert state['id'] == e.keys[0] and state['pending']
    lib.apply_photograph('a', e.keys[0], e.records[0])
    assert not lib.photograph_choice(e.records[0])['pending']


def test_updated_collection_batch_rebuilds_only_photo_choices_before_enabling(environment):
    e = environment;lib = e.library;pin = lib.current_pin()
    lib.apply_photograph('a', e.keys[0], e.records[0], pin)
    lib.apply_photograph('b', e.keys[1], e.records[1], pin)
    lib.toggle(False, True, [pin])
    old = e.target
    # Rename the original batch as a game update would, without touching the verified fixture.
    from ba_modding_toolkit.naming import parse_filename
    new = old.with_name(old.name.replace(parse_filename(old.name).date, '2099-01-01'))
    old.rename(new)
    result = lib.toggle(True, False, [pin])
    assert not result.failed and not result.left and not result.stuck
    current = e.game.collection_target(e.records[0]['name'])
    assert current['bundle'] == new.name and core_of(new.name) != core_of(old.name)
    assert lib.photograph_choice(current, pin)['id'] == e.keys[0]
    second = e.game.collection_target(e.records[1]['name'])
    assert lib.photograph_choice(second, pin)['id'] == e.keys[1]
    lib.apply_photograph('a', None, current, pin);lib.apply_photograph('b', None, second, pin)
    assert new.read_bytes() == e.original
