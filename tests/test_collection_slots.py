"""Dated Collection batches coexist; legacy configurations keep their exact targets."""

import hashlib
from pathlib import Path

from ba_modding_toolkit.library import ModLibrary
from ba_modding_toolkit.library.judge import core_of
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.utils import CRCUtils
from test_library import header_bundle, make_mod, setup_library


def collection(folder, date, payload):
    raw = header_bundle(payload)
    name = f'uis-01_common-14_charactercollect-_mxload-{date}_000_assets_all_{CRCUtils.compute_crc32(raw)}.bundle'
    path = folder / name;path.write_bytes(raw)
    return path


def test_collection_batches_have_distinct_slots_and_exact_targets(setup_library):
    e = setup_library
    old = collection(e.game_dir, '2024-11-18', b'old collection batch')
    new = collection(e.game_dir, '2026-07-02', b'new collection batch')
    assert core_of(old.name) != core_of(new.name)
    source = make_mod(old, e.tmp / 'upload', payload=b'only old batch changed')
    mod, = e.library.add([source], kind='other', direct=True)
    untouched = new.read_bytes()
    e.library.apply(mod.target, f'mod:{mod.id}', kind='other')
    assert old.read_bytes() == source.read_bytes() and new.read_bytes() == untouched


def test_legacy_collection_slot_profile_is_migrated_without_game_writes(setup_library):
    e = setup_library
    path = collection(e.game_dir, '2024-11-18', b'original collection')
    mod, = e.library.add([make_mod(path, e.tmp / 'upload')], kind='other', direct=True)
    e.library.apply(mod.target, f'mod:{mod.id}', kind='other')
    parsed = parse_filename(path.name)
    old = 'other:' + hashlib.sha256(repr((parsed.prefix, parsed.res_type)).encode()).hexdigest()
    new = core_of(path.name)
    def legacy(data):
        for folder in data['folders'].values():
            if new in folder['configured']:
                folder['configured'][old] = folder['configured'].pop(new)
                if new in folder.get('built', {}):
                    folder['built'][old] = folder['built'].pop(new)
        for item in data['unfinished']:
            if item.get('core') == new:item['core'] = old
    e.library.profiles.update(legacy)
    before = path.read_bytes()
    fresh = ModLibrary(e.root, e.catalog, object(), e.settings)
    configured = fresh.profiles.read()['folders'][fresh.current_pin().key]['configured']
    assert new in configured and old not in configured
    assert path.read_bytes() == before
    assert configured[new]['source'] == f'mod:{mod.id}'
