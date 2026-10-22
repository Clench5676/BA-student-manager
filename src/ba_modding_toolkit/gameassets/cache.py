"""Consent-controlled disk storage and a byte-bounded memory LRU."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import shutil
import struct
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from PIL import Image

from .. import config, devmode

logger = logging.getLogger(__name__)


class AssetCache:
    """Cache assets by version and key; disk entries are bytes and require consent.

    ``root`` overrides :func:`config.user_cache_dir` (useful for tests). Images
    and other decoded values are memory-only. Callers must pass ``disk=False``
    for heavy assets, including their lookups. No directories are created until
    the first permitted disk write. Changing ``allowed`` is synchronous with I/O.
    In dev mode (devmode) the root must lie inside the dev roots.
    """

    def __init__(self, resource_version: str = "", *, allowed: bool = False,
                 max_bytes: int = 512 * 1024 * 1024, root: Path | None = None):
        if max_bytes < 0:
            raise ValueError("max_bytes must be nonnegative")
        self.resource_version = resource_version
        self.root = Path(root) if root is not None else config.user_cache_dir()
        devmode.check_read(self.root)
        self.max_bytes = max_bytes
        self._allowed = allowed
        self._lock = threading.RLock()
        self._items: OrderedDict[tuple[str, str, bool], tuple[Any, int]] = OrderedDict()
        self._bytes = 0
        self._generation = 0

    @property
    def generation(self) -> int:
        """A clear invalidates work that started before it."""
        with self._lock:
            return self._generation

    @property
    def allowed(self) -> bool:
        """Whether light assets may currently be read from or written to disk."""
        with self._lock:
            return self._allowed

    @allowed.setter
    def allowed(self, value: bool) -> None:
        with self._lock:
            self._allowed = bool(value)

    @property
    def memory_bytes(self) -> int:
        """The accounted size of entries in the memory LRU."""
        with self._lock:
            return self._bytes

    def _path(self, version: str, key: str) -> Path:
        # Version folders remain readable SHA-1s; arbitrary caller input cannot
        # escape the cache root. Keys never become filesystem paths.
        is_digest = len(version) == 40 and all(c in "0123456789abcdef" for c in version)
        safe_version = version if is_digest else hashlib.sha1(version.encode()).hexdigest()
        return self.root / safe_version / (hashlib.sha256(key.encode()).hexdigest() + ".cache")

    def has_disk_entries(self, version: str) -> bool:
        """Whether this resource version has any consented light assets on disk."""
        with self._lock:
            if not self._allowed:
                return False
            try:
                return any(path.is_file() for path in self._path(version, "").parent.glob("*.cache"))
            except OSError:
                return False

    def get(self, key: str, *, version: str | None = None, disk: bool = True) -> Any | None:
        """Return an entry, promoting it to most recently used, or ``None``."""
        version = self.resource_version if version is None else version
        token = (version, key, disk)
        with self._lock:
            if token in self._items:
                self._items.move_to_end(token)
                return self._items[token][0]
            if disk and self._allowed:
                try:
                    value = self._path(version, key).read_bytes()
                except FileNotFoundError:
                    return None
                except OSError:
                    logger.warning("Cannot read asset cache entry %s", key, exc_info=True)
                    return None
                self._remember(token, value, len(value))
                return value
        return None

    def _remember(self, token: tuple[str, str, bool], value: Any, size: int) -> None:
        old = self._items.pop(token, None)
        if old is not None:
            self._bytes -= old[1]
        if size > self.max_bytes:
            return
        while self._items and self._bytes + size > self.max_bytes:
            _, (_, removed_size) = self._items.popitem(last=False)
            self._bytes -= removed_size
        self._items[token] = (value, size)
        self._bytes += size

    def put(self, key: str, value: Any, *, version: str | None = None,
            disk: bool = True, size: int | None = None, generation: int | None = None) -> None:
        """Store an asset, atomically writing bytes to disk when permitted.

        Non-byte values need an explicit byte size, except Pillow images whose
        decoded pixel storage is counted automatically.
        """
        version = self.resource_version if version is None else version
        if size is None:
            if isinstance(value, bytes):
                size = len(value)
            elif isinstance(value, Image.Image):
                size = value.width * value.height * len(value.getbands())
            else:
                raise TypeError("Non-byte cache values require a size")
        if size < 0:
            raise ValueError("size must be nonnegative")
        with self._lock:
            if generation is not None and generation != self._generation:
                return
            self._remember((version, key, disk), value, size)
            if disk and self._allowed and isinstance(value, bytes):
                temporary = None
                try:
                    path = self._path(version, key)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
                        temporary = Path(stream.name)
                        stream.write(value)
                    os.replace(temporary, path)
                except OSError:
                    logger.warning("Cannot write asset cache entry %s", key, exc_info=True)
                finally:
                    if temporary is not None:
                        temporary.unlink(missing_ok=True)

    def clear(self) -> None:
        """Remove all memory entries and all resource versions on disk."""
        with self._lock:
            self.clear_memory()
            if self.root.exists():
                shutil.rmtree(self.root)

    def clear_memory(self) -> None:
        with self._lock:
            self._generation += 1
            self._items.clear()
            self._bytes = 0


# Increment when an exporter changes its output or interpretation of source files.
PREVIEW_SCHEMA = "preview-exports-v1"
PREVIEW_ENTRY_LIMIT = 256 * 1024 * 1024
_PREVIEW_MAGIC = b"BAMTPreview1\n"


class PreviewCache:
    """Separately consented, bounded disk storage for lossless preview exports.

    Entries are opaque bytes with a SHA-256 checksum. Keys are hashed, never paths;
    both the game installation and the complete source revision belong in the key.
    A session generation prevents pending exports from recreating cleared data.
    Reads touch entries for LRU eviction, which also removes old resource versions.
    """

    def __init__(self, root: Path, *, allowed: bool = False, max_bytes: int = 2 * 1024 ** 3):
        self.root = Path(root)
        devmode.check_read(self.root)
        if max_bytes < 0:
            raise ValueError("max_bytes must be nonnegative")
        self.max_bytes = max_bytes
        self._allowed = bool(allowed)
        self._generation = secrets.token_hex(16)
        self._lock = threading.RLock()
        self._inventory: OrderedDict[Path, int] | None = None
        self._inventory_bytes = 0
        self._inventory_stamp: tuple[int, int, int, int] | None = None

    @property
    def generation(self) -> str:
        with self._lock:
            return self._generation

    @property
    def allowed(self) -> bool:
        with self._lock:
            return self._allowed

    @allowed.setter
    def allowed(self, value: bool) -> None:
        with self._lock:
            if self._allowed != bool(value):
                self._generation = secrets.token_hex(16)
            self._allowed = bool(value)

    def _path(self, key: str) -> Path:
        digest = hashlib.sha256((PREVIEW_SCHEMA + "\n" + key).encode()).hexdigest()
        return self.root / (digest + ".preview")

    def get(self, key: str) -> bytes | None:
        with self._lock:
            if not self._allowed:
                return None
            path = self._path(key)
            try:
                self._sync_inventory()
                if path.stat().st_size > PREVIEW_ENTRY_LIMIT + len(_PREVIEW_MAGIC) + 32:
                    raise ValueError("Oversized preview cache entry")
                raw = path.read_bytes()
                header = len(_PREVIEW_MAGIC)
                value = raw[header + 32:]
                if raw[:header] != _PREVIEW_MAGIC or raw[header:header + 32] != hashlib.sha256(value).digest():
                    raise ValueError("Invalid preview cache checksum")
                try:
                    os.utime(path, None)
                except OSError:
                    pass
                self._remember_disk(path, len(raw))
                self._prune()
                self._inventory_stamp = self._directory_stamp()
                return value
            except FileNotFoundError:
                self._forget_disk(path)
                return None
            except (OSError, ValueError):
                # A cache failure must never prevent loading the original assets.
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass
                self._forget_disk(path)
                self._inventory = None
                return None

    def put(self, key: str, value: bytes, *, generation: str) -> bool:
        if not isinstance(value, bytes) or len(value) > min(self.max_bytes, PREVIEW_ENTRY_LIMIT):
            return False
        with self._lock:
            if not self._allowed or generation != self._generation:
                return False
            temporary = None
            try:
                self.root.mkdir(parents=True, exist_ok=True)
                self._sync_inventory()
                path = self._path(key)
                with tempfile.NamedTemporaryFile(dir=self.root, delete=False) as stream:
                    temporary = Path(stream.name)
                    stream.write(_PREVIEW_MAGIC)
                    stream.write(hashlib.sha256(value).digest())
                    stream.write(value)
                os.replace(temporary, path)
                self._remember_disk(path, len(_PREVIEW_MAGIC) + 32 + len(value))
                self._prune()
                self._inventory_stamp = self._directory_stamp()
                return path in self._inventory
            except OSError:
                self._inventory = None
                logger.warning("Cannot write preview cache entry")
                return False
            finally:
                if temporary is not None:
                    try:
                        temporary.unlink(missing_ok=True)
                    except OSError:
                        pass

    def discard(self, key: str) -> None:
        with self._lock:
            try:
                self._sync_inventory()
                path = self._path(key)
                path.unlink(missing_ok=True)
                self._forget_disk(path)
                self._inventory_stamp = self._directory_stamp()
            except OSError:
                self._inventory = None

    def _directory_stamp(self) -> tuple[int, int, int, int] | None:
        try:
            stat = self.root.stat()
            return stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns
        except FileNotFoundError:
            return None

    def _scan_inventory(self) -> OrderedDict[Path, int]:
        entries = []
        for path in self.root.glob("*.preview"):
            try:
                stat = path.stat()
            except FileNotFoundError:
                continue
            entries.append((stat.st_mtime_ns, path, stat.st_size))
        return OrderedDict((path, size) for _, path, size in sorted(entries))

    def _sync_inventory(self) -> None:
        """Scan once, then only after directory changes made outside this instance.

        Own atomic writes, deletions and LRU touches update the accounting directly.
        The directory's identity and timestamps detect another process replacing an
        entry, adding/removing files, clearing the cache or recreating its folder.
        """
        stamp = self._directory_stamp()
        if self._inventory is not None and stamp == self._inventory_stamp:
            return
        for _ in range(2):
            entries = self._scan_inventory() if stamp is not None else OrderedDict()
            after = self._directory_stamp()
            if after == stamp:
                self._inventory = entries
                self._inventory_bytes = sum(entries.values())
                self._inventory_stamp = after
                return
            stamp = after
        raise OSError("Preview cache directory changed during inventory")

    def _remember_disk(self, path: Path, size: int) -> None:
        if self._inventory is None:
            return
        self._inventory_bytes -= self._inventory.pop(path, 0)
        self._inventory[path] = size
        self._inventory_bytes += size

    def _forget_disk(self, path: Path) -> None:
        if self._inventory is not None:
            self._inventory_bytes -= self._inventory.pop(path, 0)

    def _prune(self) -> None:
        while self._inventory and self._inventory_bytes > self.max_bytes:
            path = next(iter(self._inventory))
            path.unlink(missing_ok=True)
            self._forget_disk(path)

    def _clear_files(self) -> None:
        self._inventory = None
        self._inventory_bytes = 0
        self._inventory_stamp = None
        if self.root.exists():
            shutil.rmtree(self.root)

    def clear(self) -> None:
        with self._lock:
            self._generation = secrets.token_hex(16)
            self._clear_files()

    def clear_with(self, clear: Any) -> None:
        """Clear the parent UI cache under the same lock as preview writes."""
        with self._lock:
            self.clear()
            clear()

    def relocate(self, root: Path, clear: Any) -> None:
        """Move the cache boundary atomically with respect to pending exports."""
        root = Path(root)
        devmode.check_read(root)
        with self._lock:
            self.clear()
            clear()
            self.root = root


def pack_preview_files(files: dict[str, bytes]) -> bytes:
    """Pack unchanged bytes with a bounded JSON directory; no executable serialization."""
    directory, chunks, offset = [], [], 0
    # Atlas aliases often share the same PNG object. Keep one byte copy on disk.
    seen: dict[int, tuple[int, int]] = {}
    for name, data in files.items():
        if id(data) not in seen:
            seen[id(data)] = (offset, len(data))
            chunks.append(data)
            offset += len(data)
        directory.append([name, *seen[id(data)]])
    header = json.dumps(directory, ensure_ascii=True, separators=(",", ":")).encode()
    return struct.pack("<I", len(header)) + header + b"".join(chunks)


def unpack_preview_files(data: bytes) -> dict[str, bytes]:
    """Read the private container without extracting any path to the filesystem."""
    if len(data) < 4:
        raise ValueError("Invalid preview container")
    size, = struct.unpack_from("<I", data)
    if size > 1024 * 1024 or size > len(data) - 4:
        raise ValueError("Invalid preview directory")
    directory = json.loads(data[4:4 + size])
    if not isinstance(directory, list) or len(directory) > 8192:
        raise ValueError("Invalid preview file count")
    base = 4 + size
    records, parts, names = [], set(), set()
    for item in directory:
        if not isinstance(item, list) or len(item) != 3:
            raise ValueError("Invalid preview file")
        name, offset, length = item
        if (not isinstance(name, str) or len(name) > 4096 or type(offset) is not int or type(length) is not int
                or offset < 0 or length < 0 or offset + length > len(data) - base):
            raise ValueError("Invalid preview file bounds")
        if name in names:
            raise ValueError("Duplicate preview file")
        names.add(name)
        parts.add((offset, length))
        records.append((name, (offset, length)))
    # Validate the whole directory before allocating a single slice. Exact aliases
    # share bytes; all other ranges emitted by the packer must be disjoint.
    end = 0
    for offset, length in sorted(parts):
        if offset < end:
            raise ValueError("Overlapping preview files")
        end = offset + length
    chunks = {part: data[base + part[0]:base + part[0] + part[1]] for part in parts}
    return {name: chunks[part] for name, part in records}
