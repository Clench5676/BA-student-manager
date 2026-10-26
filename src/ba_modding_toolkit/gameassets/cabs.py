"""Demand-driven, revision-checked CAB discovery with bounded persistent metadata."""

from __future__ import annotations

import json
import logging
import os
import threading
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterable

from ..naming import PRELOAD_PREFIX, parse_filename
from .cache import PreviewCache
from .discovery import cab_names

logger = logging.getLogger(__name__)
_SCHEMA = "cab-discovery-v1"
_MAX_ENTRIES = 40000
_MAX_SNAPSHOT = 16 * 1024 * 1024
_MAX_METADATA_BYTES = 64 * 1024 * 1024
_MAX_ORDERS = 8


def revision(path: Path) -> tuple[int, ...] | None:
    try:
        value = path.stat()
        return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns
    except OSError:
        return None


class CabIndex:
    """Locate only requested dependencies; never decode textures or asset blocks.

    Persistence uses the existing checksummed, atomic, bounded preview store.
    Batch contexts coalesce metadata writes during graph traversal. File revisions
    include inode and ctime, so preserving size and mtime cannot retain stale names.
    """

    def __init__(self, directories: Iterable[Path], *, cache: PreviewCache | None = None,
                 namespace: str = "", reader: Callable = cab_names):
        self.directories = tuple(Path(path).resolve() for path in directories)
        self.cache, self.reader = cache, reader
        self.key = json.dumps([namespace, [str(path) for path in self.directories]], separators=(",", ":")) + "/" + _SCHEMA
        self._lock = threading.RLock()
        self._entries: OrderedDict[Path, tuple[tuple[int, ...], tuple[str, ...]]] = OrderedDict()
        self._reverse: dict[str, set[Path]] = {}
        self._paths: list[Path] | None = None
        self._orders: OrderedDict[tuple[str, str], list[Path]] = OrderedDict()
        self._metadata_bytes = 0
        self._directory_revision = None
        self._safe_roots = set(self.directories)
        self._generation = None
        self._loaded = self._dirty = False
        self._depth = 0
        self._validated: set[Path] = set()
        self._complete = False

    def _permitted(self, path: Path) -> bool:
        return (path.parent in self._safe_roots
                and (not path.is_symlink() or path.resolve().parent in self._safe_roots))

    def _drop(self, path: Path) -> None:
        prior = self._entries.pop(path, None)
        if prior:
            self._metadata_bytes -= self._cost(path, prior[1])
            for name in prior[1]:
                paths = self._reverse.get(name, set())
                paths.discard(path)
                if not paths:
                    self._reverse.pop(name, None)
            self._dirty = True

    @staticmethod
    def _cost(path: Path, names: Iterable[str]) -> int:
        return 256 + len(str(path).encode()) + sum(256 + len(name.encode()) for name in names)

    def _remember(self, path: Path, stamp: tuple[int, ...], names: Iterable[str]) -> tuple[str, ...]:
        self._drop(path)
        names = tuple(dict.fromkeys(name.lower() for name in names))
        cost = self._cost(path, names)
        if cost > _MAX_METADATA_BYTES:
            return names
        self._entries[path] = stamp, names
        self._metadata_bytes += cost
        for name in names:
            self._reverse.setdefault(name, set()).add(path)
        while len(self._entries) > _MAX_ENTRIES or self._metadata_bytes > _MAX_METADATA_BYTES:
            self._drop(next(iter(self._entries)))
        self._dirty = True
        return names

    def _sync(self) -> None:
        generation = self.cache.generation if self.cache else None
        if generation != self._generation:
            self._entries.clear()
            self._metadata_bytes = 0
            self._reverse.clear()
            self._validated.clear()
            self._loaded = self._dirty = self._complete = False
            self._generation = generation
        self._safe_roots = {path for path in self.directories if path.resolve() == path}
        stamps = tuple(revision(path) if path in self._safe_roots else None for path in self.directories)
        if stamps != self._directory_revision:
            self._directory_revision, self._paths = stamps, None
            self._orders.clear()
            self._validated.clear()
            self._complete = False
        if not self._loaded:
            self._loaded = True
            self._load()

    def _load(self) -> None:
        data = self.cache.get(self.key) if self.cache else None
        if data is None or len(data) > _MAX_SNAPSHOT:
            return
        try:
            saved = json.loads(data)
            if saved["schema"] != _SCHEMA or len(saved["entries"]) > _MAX_ENTRIES:
                return
            records = []
            for root, name, stamp, names in saved["entries"]:
                if (type(root) is not int or not 0 <= root < len(self.directories) or not isinstance(name, str)
                        or name in (".", "..") or Path(name).name != name or not name.endswith(".bundle")
                        or len(stamp) != 5 or not all(type(n) is int for n in stamp)
                        or not isinstance(names, list) or len(names) > 8192
                        or not all(isinstance(n, str) and len(n) <= 4096 for n in names)):
                    raise ValueError("Invalid CAB cache entry")
                path = self.directories[root] / name
                if path.parent not in self.directories:
                    raise ValueError("CAB cache entry escapes its installation")
                records.append((path, tuple(stamp), names))
            for path, stamp, names in records:
                self._remember(path, stamp, names)
            self._dirty = False
        except (KeyError, TypeError, ValueError, OSError):
            logger.debug("Rebuilding invalid CAB metadata cache", exc_info=True)

    def _save(self) -> None:
        if not self._dirty or self.cache is None:
            return
        roots = {path: i for i, path in enumerate(self.directories)}
        data = json.dumps({"schema": _SCHEMA, "entries": [
            [roots[path.parent], path.name, stamp, names] for path, (stamp, names) in self._entries.items()
        ]}, separators=(",", ":")).encode()
        if len(data) <= _MAX_SNAPSHOT:
            self.cache.put(self.key, data, generation=self._generation)
        self._dirty = False

    @contextmanager
    def batch(self):
        with self._lock:
            self._sync()
            if self._depth == 0:
                self._validated.clear()
                self._complete = False
            self._depth += 1
        try:
            yield self
        finally:
            with self._lock:
                self._depth -= 1
                if self._depth == 0:
                    self._save()
                    self._validated.clear()
                    self._complete = False

    def _inventory(self) -> list[Path]:
        if self._paths is None:
            found: dict[str, tuple[Path, int]] = {}
            for directory in self.directories:
                if directory not in self._safe_roots:
                    continue
                try:
                    with os.scandir(directory) as entries:
                        for entry in entries:
                            path = Path(entry.path)
                            if (entry.name.endswith(".bundle") and entry.name not in found
                                    and entry.is_file()
                                    and (not entry.is_symlink() or self._permitted(path))):
                                found[entry.name] = path, entry.stat().st_size
                except OSError:
                    logger.debug("Cannot enumerate CAB source directory %s", directory, exc_info=True)
            self._paths = [path for path, _ in sorted(found.values(), key=lambda item: (item[1], item[0].name))]
        return self._paths

    def _read(self, path: Path, *, revalidate: bool = True) -> tuple[str, ...]:
        if not revalidate and self._depth and path in self._validated and path in self._entries:
            return self._entries[path][1]
        if not self._permitted(path):
            self._drop(path)
            return ()
        before = revision(path)
        saved = self._entries.get(path)
        if before is None:
            self._drop(path)
            return ()
        if saved is None or saved[0] != before:
            self._drop(path)
            try:
                names = self.reader(path)
            except (OSError, ValueError):
                logger.debug("Cannot read CAB directory %s", path, exc_info=True)
                names = ()
            if revision(path) != before:
                return ()
            names = self._remember(path, before, names)
        else:
            names = saved[1]
            self._entries.move_to_end(path)
        if self._depth:
            self._validated.add(path)
        return names

    def resolve(self, wanted: set[str], hint_path: Path | None = None) -> dict[str, str]:
        with self._lock:
            self._sync()
            remaining = {name.lower() for name in wanted}
            found = {}
            hint = parse_filename(hint_path.name) if hint_path else None
            prefix, core = (hint.prefix, hint.core.lower()) if hint else ("", "")

            def priority(path):
                name = path.name
                return (0 if prefix and name.startswith(prefix) or core and f"-{core}-" in name.lower()
                        else 1 if name.startswith(PRELOAD_PREFIX) else 2)

            def rank(path):
                return priority(path), self.directories.index(path.parent), path.name

            for name in list(remaining):
                for path in sorted(self._reverse.get(name, ()), key=rank):
                    if name in self._read(path):
                        found[name] = str(path)
                        remaining.remove(name)
                        break
            if remaining and not self._complete:
                paths = self._inventory()
                order = (prefix, core)
                if order not in self._orders:
                    self._orders[order] = sorted(paths, key=priority)
                    while len(self._orders) > _MAX_ORDERS:
                        self._orders.popitem(last=False)
                self._orders.move_to_end(order)
                visited = 0
                for path in self._orders[order]:
                    visited += 1
                    names = self._read(path, revalidate=False)
                    for name in remaining.intersection(names):
                        found[name] = str(path)
                        remaining.remove(name)
                    if not remaining:
                        break
                if self._depth and visited == len(paths):
                    self._complete = True
            # Recheck just the returned files; repeated scan prefixes can reuse batch metadata.
            found = {name: path for name, path in found.items() if name in self._read(Path(path))}
            if not self._depth:
                self._save()
            return found

    def all(self, predicate: Callable[[Path], bool] = lambda path: True) -> dict[str, str]:
        """Compatibility/full-index operation, reusing the same file metadata."""
        with self._lock, self.batch():
            self._sync()
            result = {}
            for path in self._inventory():
                if predicate(path):
                    for name in self._read(path):
                        result.setdefault(name, str(path))
            return result
