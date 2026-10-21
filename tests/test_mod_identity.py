"""Uploaded targets come from bundle names and internal Spine identities, never a selected card."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.catalog import Catalog
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.i18n import t
from ba_modding_toolkit.library.identity import content_cores, identify
from ba_modding_toolkit.naming import parse_filename

from test_library import FakeVariant, game_bundle, make_mod, setup_library


@pytest.fixture
def catalog():
    game = SimpleNamespace(
        spine_cores=lambda kind: {core: [] for core in (
            ['mutsuki_spr', 'ch0246_spr', 'shun_spr', 'ch0066_spr', 'np0167_spr'] if kind == 'spr'
            else ['mutsuki_home', 'mutsuki_dress_home', 'shun_home', 'shun_small_home'])},
        collection_names=lambda: {},
    )
    return Catalog(game, None)


def objects(monkeypatch, names=(), containers=()):
    env = SimpleNamespace(container=dict.fromkeys(containers), objects=[
        SimpleNamespace(peek_name=lambda name=name: name, container=None) for name in names])
    monkeypatch.setattr(Bundle, 'load', lambda *args: SimpleNamespace(env=env))


@pytest.mark.parametrize('name, core', [
    ('CH0246_home.atlas', 'ch0246_home'),
    ('Assets/_MX/SpineLobbies/mutsuki_dress_home/mutsuki_dress_home.skel', 'mutsuki_dress_home'),
    ('mutsuki_dress_home_gl_2', 'mutsuki_dress_home_gl'),
    ('Assets/_MX/SpineCharacters/CH0246/CH0246.skel', 'ch0246_spr'),
])
def test_content_names_and_container_paths(monkeypatch, name, core):
    objects(monkeypatch, [name], [name])
    assert content_cores(Path('upload.bundle')) == {core}


def test_unreadable_bundle_is_refused(monkeypatch):
    monkeypatch.setattr(Bundle, 'load', lambda *args: None)
    with pytest.raises(ServiceError, match='bundle_invalid'):
        content_cores(Path('upload.bundle'))


def test_dress_lobby_overrules_base_filename_and_uses_installed_core(catalog, tmp_path, monkeypatch):
    source = game_bundle(tmp_path, 'mutsuki_home')
    objects(monkeypatch, ['CH0246_home.atlas', 'mutsuki_dress_home.skel'])
    name, target, kind = identify(source, source.name, catalog)
    assert (parse_filename(name).core, target, kind) == ('mutsuki_dress_home', 'ch0246', 'lobby')
    assert parse_filename(name).date == parse_filename(source.name).date


@pytest.mark.parametrize('category, filename_core, core, kind', [
    ('SpineCharacters', 'mutsuki_home', 'ch0246_spr', 'spr'),
    ('SpineLobbies', 'mutsuki_spr', 'mutsuki_dress_home', 'lobby'),
])
def test_container_kind_overrules_upload_name_and_bare_object_names(
        catalog, tmp_path, monkeypatch, category, filename_core, core, kind):
    source = game_bundle(tmp_path, filename_core)
    objects(monkeypatch, ['CH0246.skel', 'CH0246.atlas'],
            [f'Assets/_MX/{category}/CH0246/CH0246.skel'])
    assert content_cores(source) == {f'ch0246_{"spr" if kind == "spr" else "home"}'}
    name, target, detected_kind = identify(source, source.name, catalog)
    assert (parse_filename(name).core, target, detected_kind) == (core, 'ch0246', kind)


@pytest.mark.parametrize('names', [['CH0246_home.atlas'], ['generic_mesh']])
def test_matching_variant_alias_is_canonicalized_and_can_be_applied(setup_library, catalog, monkeypatch, names):
    env = setup_library
    env.library.catalog = catalog
    original = game_bundle(env.game_dir, 'mutsuki_dress_home')
    source = game_bundle(env.tmp / 'upload', 'ch0246_home')
    source.write_bytes(original.read_bytes() + b'lobby mod')
    with monkeypatch.context() as patch:
        objects(patch, names)
        patch.setattr('ba_modding_toolkit.library.identity.content_cores', content_cores)
        entry, = env.library.add([source])
    assert (entry.core, entry.target, entry.kind) == ('mutsuki_dress_home', 'ch0246', 'lobby')
    env.library.apply('ch0246', f'mod:{entry.id}', kind='lobby')
    assert original.read_bytes() == source.read_bytes()


def test_aliases_and_character_ids_resolve_to_the_same_student(catalog):
    assert catalog.variant_for_asset_core('mutsuki_dress_home').key == 'ch0246'
    assert catalog.variant_for_asset_core('CH0246_home').key == 'ch0246'
    assert catalog.variant_for_asset_core('shun_home').key == 'shun'
    assert catalog.variant_for_asset_core('shun_small_home').key == 'ch0066'
    assert catalog.variant_for_asset_core('unknown_home') is None


def test_filename_only_part_uses_catalog_and_keeps_original_spelling(catalog, tmp_path, monkeypatch):
    source = game_bundle(tmp_path, 'shun_home')
    objects(monkeypatch, ['generic_mesh'])
    assert identify(source, source.name, catalog) == (source.name, 'shun', 'lobby')


def test_filename_only_alias_without_an_installed_kind_keeps_its_declared_core(tmp_path, monkeypatch):
    source = game_bundle(tmp_path, 'ch0246_home')
    variant = FakeVariant('ch0246', 'ch0246_spr')
    catalog = SimpleNamespace(variant_for_core=lambda core: variant)
    objects(monkeypatch, ['generic_mesh'])
    assert identify(source, source.name, catalog) == (source.name, 'ch0246', 'lobby')


@pytest.mark.parametrize('names, code', [
    (['no_such_student_home.skel'], 'mod_target_unknown'),
    (['mutsuki_home.skel', 'mutsuki_dress_home.skel'], 'mod_target_ambiguous'),
    (['mutsuki_home.skel', 'mutsuki_spr.skel'], 'mod_target_ambiguous'),
])
def test_unknown_and_conflicting_content_is_refused(catalog, tmp_path, monkeypatch, names, code):
    source = game_bundle(tmp_path, 'mutsuki_home')
    objects(monkeypatch, names)
    with pytest.raises(ServiceError) as caught:
        identify(source, source.name, catalog)
    assert caught.value.code == code


def test_upload_splits_kinds_and_variants_and_reports_files(setup_library, monkeypatch):
    env = setup_library
    env.catalog.variants['dress'] = FakeVariant('dress', 'dress_spr', 'dress_home')
    portrait = game_bundle(env.tmp / 'upload', 'test_spr')
    lobby = game_bundle(env.tmp / 'upload', 'dress_home')
    monkeypatch.setattr('ba_modding_toolkit.library.identity.content_cores',
                        lambda path: {parse_filename(path.name).core})
    progress = []
    entries = env.library.add([portrait, lobby], lambda *p: progress.append(p))
    assert [(e.target, e.kind) for e in entries] == [('test', 'spr'), ('dress', 'lobby')]
    assert progress == [(i, 2, t('webui.progress.add', name=path.name))
                        for i, path in [(0, portrait), (1, lobby), (2, lobby)]]


def test_unknown_part_adds_nothing_from_the_entire_upload(setup_library, monkeypatch):
    env = setup_library
    valid = game_bundle(env.tmp / 'upload', 'test_spr')
    unknown = game_bundle(env.tmp / 'upload', 'unknown_home')
    monkeypatch.setattr('ba_modding_toolkit.library.identity.content_cores', lambda path: set())
    with pytest.raises(ServiceError) as caught:
        env.library.add([valid, unknown])
    assert caught.value.code == 'mod_target_unknown'
    assert env.library.mods() == []
    assert not list(env.root.glob('mods/*/*.bundle'))


def test_renamed_upload_is_stored_under_its_content_target(setup_library, monkeypatch):
    env = setup_library
    env.catalog.variants['dress'] = FakeVariant('dress', 'dress_spr', 'dress_home')
    source = game_bundle(env.tmp / 'upload', 'test_home_gl')
    monkeypatch.setattr('ba_modding_toolkit.library.identity.content_cores', lambda path: {'dress_home'})
    entry, = env.library.add([source])
    assert (entry.target, entry.kind, entry.core) == ('dress', 'lobby', 'dress_home')
    assert entry.file.read_bytes() == source.read_bytes()
    assert parse_filename(entry.file.name).core == 'dress_home'


@pytest.mark.parametrize('apply', [False, True])
@pytest.mark.parametrize('filename_kind, content_kind', [('spr', 'lobby'), ('lobby', 'spr')])
def test_add_files_accepts_the_identified_kind_of_a_renamed_upload(
        setup_library, monkeypatch, filename_kind, content_kind, apply):
    env = setup_library
    targets = {'spr': env.original, 'lobby': game_bundle(env.game_dir, 'test_home_gl')}
    before = {kind: path.read_bytes() for kind, path in targets.items()}
    source = make_mod(targets[filename_kind], env.tmp / 'upload')
    target = targets[content_kind]
    core = parse_filename(target.name).core
    monkeypatch.setattr('ba_modding_toolkit.library.identity.content_cores', lambda path: {core})

    added = env.library.add_files(content_kind, [source], apply=apply)

    entry, = added
    assert (entry.target, entry.kind, entry.core) == ('test', content_kind, core)
    assert entry.file.name == target.name
    assert entry.file.read_bytes() == source.read_bytes()
    assert added.failed == []
    assert added.applied == ([entry] if apply else [])
    assert target.read_bytes() == (source.read_bytes() if apply else before[content_kind])
    assert targets[filename_kind].read_bytes() == before[filename_kind]
