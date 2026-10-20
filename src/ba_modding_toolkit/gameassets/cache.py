"""Consent-controlled disk storage and a byte-bounded memory LRU."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
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
            disk: bool = True, size: int | None = None) -> None:
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
            self._items.clear()
            self._bytes = 0
            if self.root.exists():
                shutil.rmtree(self.root)
