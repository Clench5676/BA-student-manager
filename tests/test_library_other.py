"""Generic target slots share the library's transactions, intent and recovery."""

import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import ModLibrary, supports_kind
from ba_modding_toolkit.library.identity import identify
from ba_modding_toolkit.library.integrity import Contents, inspect as inspect_bundle
from ba_modding_toolkit.library.judge import core_of, other_target
from ba_modding_toolkit.models import AssetType, PatchResult
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.utils import CRCUtils

from test_library import game_bundle, header_bundle, make_mod, setup_library


@pytest.fixture
def other_env(setup_library):
    env = setup_library
    env.parts = [game_bundle(env.game_dir, 'common', category=category, part=part, payload=payload)
                 for category, part, payload in [('ui', 'textures', b'official UI'),
                                                 ('backgrounds', 'textures', b'official background'),
                                                 ('music', 'audio', b'official audio')]]
    env.official = {p: p.read_bytes() for p in env.parts}
    env.library = ModLibrary(env.root, env.catalog, object(), env.settings, scan_allowed=lambda: True)
    return env


def test_generic_identity_is_the_official_file_slot_not_a_student_or_bare_core(other_env):
    env = other_env
    assert supports_kind('other')
    assert len({core_of(path.name) for path in env.parts}) == 3
    newer = game_bundle(env.tmp / 'newer', 'common', category='ui', part='textures', date='2026-10-01')
    assert core_of(newer.name) == core_of(env.parts[0].name)
    another_part = game_bundle(env.game_dir, 'common', category='ui', part='materials')
    assert core_of(another_part.name) != core_of(env.parts[0].name)
    name, target, kind = identify(env.parts[0], env.parts[0].name, env.catalog)
    assert (name, target, kind) == (env.parts[0].name, other_target([name]), 'other')
    assert env.catalog.variant_for_core(core_of(name)) is None


def test_generic_multi_file_add_apply_restore_reload_and_remove(other_env):
    env = other_env
    uploads = [make_mod(p, env.tmp / 'upload', payload=f'mod {i}'.encode()) for i, p in enumerate(env.parts)]
    added = env.library.add_files('other', uploads, apply=True)
    mod, = added
    assert mod.kind == 'other' and added.applied == [mod]
    assert [p.read_bytes() for p in env.parts] == [p.read_bytes() for p in uploads]
    assert len(env.library.state(mod.target).files) == 3
    assert all(p.restorable for p in env.library.state(mod.target).files)
    assert all((env.root / 'originals' / p.name).read_bytes() == env.official[p] for p in env.parts)
    assert env.library.add_files('other', uploads).duplicates == [mod]
    library = ModLibrary(env.root, env.catalog, object(), env.settings)
    assert library.apply(mod.target, f'mod:{mod.id}', kind='other').unchanged
    library.restore(mod.target, kind='other')
    assert all(p.read_bytes() == data for p, data in env.official.items())
    assert not library.remove(mod.id, confirm=True).failed
    assert not library.mods()


def test_generic_overlapping_mods_are_independent_alternatives_and_official_restores_each_slot(other_env):
    env = other_env
    first, = env.library.add_files('other', [make_mod(p, env.tmp / 'first', payload=b'first') for p in env.parts[:2]], apply=True)
    second, = env.library.add_files('other', [make_mod(env.parts[0], env.tmp / 'second', payload=b'second')], apply=True)
    assert env.parts[0].read_bytes() == second.file.read_bytes()
    assert env.parts[1].read_bytes() == first.file.parent.joinpath(env.parts[1].name).read_bytes()
    rows = {row['id']: row for row in env.library.other_mods()}
    assert rows[first.id]['state'] == 'mixed' and not rows[first.id]['selected']
    assert rows[second.id]['state'] == 'active' and rows[second.id]['selected']
    assert not env.library.remove(first.id, confirm=True).failed
    assert env.parts[0].read_bytes() == second.file.read_bytes()
    assert env.parts[1].read_bytes() == env.official[env.parts[1]]
    env.library.restore(second.target, kind='other')
    assert env.parts[0].read_bytes() == env.official[env.parts[0]]


def test_generic_master_switch_defers_and_reapplies_multiple_slots(other_env):
    env = other_env
    assert not env.library.toggle(False, True).failed
    added = env.library.add_files('other', [make_mod(p, env.tmp / 'upload') for p in env.parts], apply=True)
    mod, = added
    assert added.configured == [mod] and not added.applied
    assert env.library.variant_cores(mod.target) == {core_of(path.name) for path in env.parts}
    assert env.library.other_mods()[0]['state'] == 'set'
    assert all(p.read_bytes() == data for p, data in env.official.items())
    for on in [True, False, True]:
        assert not env.library.toggle(on, not on).failed
        for path in env.parts:
            assert path.read_bytes() == ((mod.file.parent / path.name).read_bytes() if on else env.official[path])
    assert not env.library.remove(mod.id, confirm=True).failed
    assert all(p.read_bytes() == data for p, data in env.official.items())


def test_generic_drift_untracked_adoption_and_relocation(other_env):
    env = other_env
    target = env.parts[0]
    mod, = env.library.add_files('other', [make_mod(target, env.tmp / 'upload')], apply=True)
    target.write_bytes(env.official[target])
    state = next(e for e in env.library.scan().entries if e.core == core_of(target.name))
    assert state.kind == 'other' and state.state == 'reset'
    assert not env.library.restore_drift([{'install': state.install, 'core': state.core}]).failed
    assert target.read_bytes() == mod.file.read_bytes()
    env.library.restore(mod.target, kind='other')
    Path(str(target) + '.backup').write_bytes(env.official[target])
    target.write_bytes(header_bundle(b'outside'))
    state = next(e for e in env.library.scan().entries if e.core == core_of(target.name))
    assert state.state == 'untracked'
    adopted = env.library.adopt([{'install': state.install, 'core': state.core}])
    assert adopted.added and not adopted.failed and adopted.added[0].kind == 'other'
    relocated = env.tmp / 'relocated'
    shutil.move(env.root, relocated)
    library = ModLibrary(relocated, env.catalog, object(), env.settings)
    assert not library.remove(adopted.added[0].id, confirm=True).failed
    assert target.read_bytes() == env.official[target]


def test_generic_missing_dependencies_and_platform_are_checked_before_storage(other_env, monkeypatch):
    env = other_env
    upload = make_mod(env.parts[0], env.tmp / 'upload')
    for contents, code in [(Contents(platforms={'Android'}), 'mod_platform_mismatch'),
                           (Contents(platforms={'StandaloneWindows64'}, streams={'missing.ress'}), 'mod_parts_missing')]:
        monkeypatch.setattr('ba_modding_toolkit.library.integrity.inspect',
                            lambda path: contents if path == upload else Contents(platforms={'StandaloneWindows64'}))
        with pytest.raises(ServiceError, match=code):
            env.library.add_files('other', [upload])
        assert not env.library.mods()


def test_generic_update_target_match_uses_container_name_and_type(other_env, monkeypatch):
    env = other_env
    old = game_bundle(env.tmp / 'old', 'common', category='ui', part='textures', date='2025-01-01')
    key = ('Assets/UI/title.png', 'title', 'Texture2D')
    wrong = game_bundle(env.game_dir, 'common', category='ui', part='materials')
    monkeypatch.setattr(Bundle, 'load', lambda path, *args: SimpleNamespace(
        get_asset_keys=lambda strategy: {key} if path in (old, env.parts[0]) else {('Other/container', 'title', 'Texture2D')}))
    report = env.library.inspect_import({old.name: old})
    assert report['targets'] == [env.parts[0]]
    assert wrong not in report['targets']


@pytest.mark.parametrize('crc_needed', [False, True])
def test_generic_older_name_update_creates_output_before_core_save(other_env, monkeypatch, crc_needed):
    env = other_env
    target = env.parts[0]
    upload = game_bundle(env.tmp / 'old', 'common', category='ui', part='textures',
                         date='2025-01-01', payload=b'old mod')
    key = ('Assets/UI/title.png', 'title', 'Texture2D')
    updated = header_bundle(b'updated UI')
    saves = []

    class FakeBundle:
        env = SimpleNamespace(objects=[SimpleNamespace(
            type=AssetType.Texture2D, container=key[0], peek_name=lambda: key[1])])

        def get_asset_keys(self, strategy):
            assert strategy == 'cont_name_type'
            return {key}

        def extract_patch(self, types, strategy, spine, *, scope):
            assert strategy == 'cont_name_type'
            assert set(scope.counterparts) == {key}
            return {key: b'updated UI'}, []

        def apply_patch(self, patch, strategy, anim_check):
            assert patch == {key: b'updated UI'}
            return PatchResult(1, 0, [], [], [key])

        def save(self, path, options):
            # Exercise the real core update through its save; it does not create this directory.
            assert path.parent.is_dir()
            assert options.perform_crc == crc_needed
            data = CRCUtils.apply_crc_fix(updated, int(parse_filename(path.name).crc)) if crc_needed else updated
            path.write_bytes(data)
            saves.append(path.name)
            return True, ''

    monkeypatch.setattr(Bundle, 'load', lambda *args: FakeBundle())
    monkeypatch.setattr(env.settings, 'crc_needed', lambda path: crc_needed)
    mod, = env.library.add_files('other', [upload])
    result = env.library.apply(mod.target, f'mod:{mod.id}', kind='other')
    assert result.files == [target]
    assert saves == [target.name]
    expected = CRCUtils.apply_crc_fix(updated, int(parse_filename(target.name).crc)) if crc_needed else updated
    assert target.read_bytes() == expected
    env.library.restore(mod.target, kind='other')
    assert target.read_bytes() == env.official[target]


@pytest.mark.parametrize('payload', [b'AudioClip:mod music',
                                   b'Texture2D:mod texture|AudioClip:mod music|Material:mod material'])
def test_generic_exact_name_crc_save_preserves_whole_bundle_outside_update_types(other_env, monkeypatch, payload):
    env = other_env
    target = env.parts[-1] if payload.startswith(b'AudioClip:') else env.parts[0]
    upload = make_mod(target, env.tmp / 'upload', payload=payload)
    saves = []

    class WholeBundle:
        def __init__(self, path):
            self.path = path

        def extract_patch(self, *args):
            pytest.fail('Same-name CRC correction must preserve every uploaded object')

        def save(self, path, options):
            assert options.perform_crc
            data = CRCUtils.apply_crc_fix(self.path.read_bytes(), int(parse_filename(path.name).crc))
            path.write_bytes(data)
            saves.append(self.path)
            return True, ''

    monkeypatch.setattr(Bundle, 'load', lambda path, *args: WholeBundle(path))
    monkeypatch.setattr(env.settings, 'crc_needed', lambda path: True)
    monkeypatch.setattr(env.settings, 'asset_types', lambda: {'Texture2D'})
    mod, = env.library.add_files('other', [upload])
    result = env.library.apply(mod.target, f'mod:{mod.id}', kind='other')
    assert result.files == [target]
    assert saves == [mod.file]
    assert target.read_bytes() == CRCUtils.apply_crc_fix(upload.read_bytes(), int(parse_filename(target.name).crc))
    assert payload in target.read_bytes()
    assert Bundle.check_crc_match(target)
    env.library.restore(mod.target, kind='other')
    assert target.read_bytes() == env.official[target]


def test_generic_audio_integrity_tracks_its_stream_companion(other_env, monkeypatch):
    from ba_modding_toolkit.library.integrity import missing_parts

    stream = SimpleNamespace(m_Source='archive:/CAB/music.resS', m_Size=32)
    obj = SimpleNamespace(type=SimpleNamespace(name='AudioClip'), read=lambda: SimpleNamespace(m_Resource=stream))
    serialized = SimpleNamespace(target_platform=SimpleNamespace(name='StandaloneWindows64'), externals=[])
    files = {'CAB': serialized}
    bundle = SimpleNamespace(env=SimpleNamespace(files=files, objects=[obj]))
    monkeypatch.setattr(Bundle, 'load', lambda *args: bundle)
    monkeypatch.setattr('ba_modding_toolkit.library.integrity.inspect', inspect_bundle)
    contents = inspect_bundle(other_env.parts[-1])
    assert contents.streams == {'music.ress'}
    assert missing_parts(contents, Contents()) == {'music.ress'}
    files['music.resS'] = SimpleNamespace()
    assert not missing_parts(inspect_bundle(other_env.parts[-1]), Contents())


def test_generic_library_duplicate_is_recognized_even_when_its_game_files_are_missing(other_env):
    env = other_env
    upload = make_mod(env.parts[0], env.tmp / 'upload')
    mod, = env.library.add_files('other', [upload])
    env.parts[0].unlink()
    report = env.library.inspect_import({upload.name: upload})
    assert report['libraryId'] == mod.id and report['targets'] == []
    assert env.library.other_mods()[0]['state'] == 'missing'


def test_generic_same_slot_versions_conflict_before_storing_any_file(other_env):
    env = other_env
    first = make_mod(env.parts[0], env.tmp / 'upload', payload=b'current')
    old = game_bundle(first.parent, 'common', category='ui', part='textures', date='2025-01-01', payload=b'old')
    with pytest.raises(ServiceError, match='mod_target_ambiguous'):
        env.library.add_files('other', [first, old])
    assert not env.library.mods()


def test_generic_current_alternative_does_not_resolve_through_an_older_mods_assets(other_env):
    env = other_env
    old, = env.library.add_files('other', [make_mod(env.parts[0], env.tmp / 'older')])
    env.parts[0].unlink()
    newer = game_bundle(env.game_dir, 'common', category='ui', part='textures', date='2026-10-21', payload=b'new official')
    current, = env.library.add_files('other', [make_mod(newer, env.tmp / 'current', payload=b'current mod')], apply=True)
    assert old.target == current.target
    assert newer.read_bytes() == current.file.read_bytes()
    rows = {row['id']: row for row in env.library.other_mods()}
    assert rows[old.id]['state'] == 'inactive'
    assert rows[current.id]['selected']
    env.library.restore(current.target, kind='other')
    assert newer.read_bytes() == header_bundle(b'new official')
