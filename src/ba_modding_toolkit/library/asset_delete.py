"""Undo managed-asset deletion together with its protected game writes and metadata."""
from __future__ import annotations

import copy
import json
import re
import shutil
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from ..errors import ServiceError
from .storage import atomic_copy, atomic_json


class Deletion:
    def __init__(self, library, directory=None, data=None):
        self.library = library
        self.directory = directory or library.root / 'asset-deletions' / uuid4().hex
        self.rolling_back = False
        self.data = data or {'version': 1, 'phase': 'active', 'records': copy.deepcopy(library._records),
                            'applied': copy.deepcopy(library._applied), 'profiles': copy.deepcopy(library.profiles.read()),
                            'mods': [], 'built': [], 'games': []}

    def publish(self):
        atomic_json(self.directory / 'journal.json', self.data)

    def remember_mods(self, ids):
        if self.rolling_back:
            return
        for key in ids:
            if key in self.data['mods'] or key not in self.data['records']:
                continue
            record = self.data['records'][key]
            for path in self.library._paths(record):
                atomic_copy(path, self.directory / 'mods' / key / path.name)
            self.data['mods'].append(key)
            self.publish()

    def remember_built(self, path):
        if self.rolling_back or path.name in self.data['built'] or not path.exists():
            return
        atomic_copy(path, self.directory / 'built' / path.name)
        self.data['built'].append(path.name)
        self.publish()

    def remember_game(self, replacements, pin):
        if self.rolling_back:
            return
        from .safety import check_resource_path
        for path, prepared in replacements.items():
            check_resource_path(path, list(pin.dirs))
            digest = self.library._hashes.get(prepared).sha1
            entry = next((entry for entry in self.data['games'] if entry['target'] == str(path.resolve())), None)
            if entry is None:
                backup = f'game/{len(self.data["games"])}.bundle'
                atomic_copy(path, self.directory / backup)
                entry = {'target': str(path.resolve()), 'backup': backup, 'before': self.library._hashes.get(path).sha1,
                         'after': [], 'pin': {'root': str(pin.root), 'key': pin.key, 'server': pin.server}}
                self.data['games'].append(entry)
            if digest not in entry['after']:
                entry['after'].append(digest)
            self.publish()

    def remember_photo(self, variant, key):
        store = self.library.photographs
        self.data['photo'] = {'variant': variant, 'key': key, 'entry': copy.deepcopy(store._entry(variant, key)),
                              'selected': [v for v, chosen in store._read()['selected'].items() if chosen == key]}
        atomic_copy(store._path(key), self.directory / 'photo.png')
        self.publish()

    def rollback(self):
        library, data = self.library, self.data
        self.rolling_back = True
        # Restore source bytes before publishing any references to them.
        for key in data['mods']:
            directory = library.root / 'mods' / key
            if directory.is_symlink():
                raise ServiceError('mod_unsupported', file=directory)
            directory.mkdir(parents=True, exist_ok=True)
            shutil.copytree(self.directory / 'mods' / key, directory, dirs_exist_ok=True, copy_function=lambda source, target: atomic_copy(Path(source), Path(target)))
        for name in data['built']:
            atomic_copy(self.directory / 'built' / name, library.root / 'built' / name)
        # Every rollback uses the normal protected writer, with an outside-change fence.
        for entry in reversed(data['games']):
            target = Path(entry['target'])
            current = library._hashes.get(target).sha1
            if current == entry['before']:
                continue
            if current not in entry['after']:
                raise ServiceError('entry_changed', core=target.name)
            pin = library._pin(Path(entry['pin']['root']), entry['pin']['server'])
            if pin is None or pin.key != entry['pin']['key']:
                raise ServiceError('folder_changed')
            from .storage import verify_file
            verify_file(self.directory / entry['backup'], entry['before'])
            source = (data['applied'].get(str(target)) or {}).get('source', 'official')
            library._commit({target: self.directory / entry['backup']}, source, lambda _: None,
                            pin=pin, prune=False, expected={target: current})
        new_ids = set(library._records) - set(data['records'])
        library._refresh_state()
        library._records = copy.deepcopy(data['records'])
        library._applied = copy.deepcopy(data['applied'])
        for entry in data['games']:
            if entry['target'] in library._applied:
                library._applied[entry['target']]['mtime'] = Path(entry['target']).stat().st_mtime_ns
        previous = data['profiles']
        if library.profiles.read() != previous:
            def restore(current):
                current.clear()
                current.update(copy.deepcopy(previous or {}))
            library.profiles.update(restore)
        if photo := data.get('photo'):
            from ..filelock import file_lock
            store = library.photographs
            with store._lock, file_lock(store.root / 'index.lock'):
                atomic_copy(self.directory / 'photo.png', store._path(photo['key']))
                store._cached = None
                manifest = copy.deepcopy(store._read())
                manifest['photos'][photo['key']] = photo['entry']
                for variant in photo['selected']:
                    if manifest['selected'].get(variant) is None:
                        manifest['selected'][variant] = photo['key']
                store._write(manifest)
        library._save()
        for key in new_ids:
            shutil.rmtree(library.root / 'mods' / key, ignore_errors=True)


def _validate(library, directory, data):
    if (directory.is_symlink() or directory.parent.is_symlink() or data.get('version') != 1
            or data.get('phase') not in ('active', 'committed')):
        raise ServiceError('library_io_error', file=directory)
    for backup in directory.rglob('*'):
        if backup.is_symlink() or not backup.resolve().is_relative_to(directory.resolve()):
            raise ServiceError('library_io_error', file=directory)
    for key in data['mods']:
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', key) or key not in data['records']:
            raise ServiceError('library_io_error', file=directory)
    for name in data['built']:
        if not re.fullmatch(r'[a-f0-9]{40}\.bundle', name):
            raise ServiceError('library_io_error', file=directory)
    if data.get('photo') and not re.fullmatch(r'[a-f0-9]{32}', data['photo']['key']):
        raise ServiceError('library_io_error', file=directory)
    for index, entry in enumerate(data['games']):
        if entry['backup'] != f'game/{index}.bundle':
            raise ServiceError('library_io_error', file=directory)
        pin = library._pin(Path(entry['pin']['root']), entry['pin']['server'])
        if pin is None or pin.key != entry['pin']['key']:
            raise ServiceError('folder_changed')
        from .safety import check_resource_path
        check_resource_path(Path(entry['target']), list(pin.dirs))


def recover(library):
    for journal in sorted((library.root / 'asset-deletions').glob('*/journal.json')):
        try:
            data = json.loads(journal.read_text(encoding='utf-8'))
            _validate(library, journal.parent, data)
            if data['phase'] != 'committed':
                deletion = Deletion(library, journal.parent, data)
                library._asset_deletion = deletion
                try:
                    deletion.rollback()
                finally:
                    library._asset_deletion = None
            shutil.rmtree(journal.parent)
        except (ValueError, TypeError, KeyError) as error:
            raise ServiceError('library_io_error', file=journal) from error


@contextmanager
def transaction(library):
    if getattr(library, '_asset_deletion', None):
        yield library._asset_deletion
        return
    deletion = Deletion(library)
    deletion.publish()
    library._asset_deletion = deletion
    try:
        yield deletion
        deletion.data['phase'] = 'committed'
        deletion.publish()
    except BaseException:
        # Keep the journal and its verified bytes if protected rollback cannot finish.
        deletion.rollback()
        shutil.rmtree(deletion.directory)
        raise
    else:
        shutil.rmtree(deletion.directory, ignore_errors=True)
    finally:
        library._asset_deletion = None
