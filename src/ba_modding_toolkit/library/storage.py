"""Atomic file storage and cached bundle fingerprints."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..bundle import Bundle
from ..utils import CRCUtils

logger = logging.getLogger(__name__)


def atomic_json(path: Path, data: dict[str, Any]) -> None:
    """Replace a JSON file only after the complete new contents are flushed."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_copy(source: Path, target: Path) -> None:
    """Copy bytes and atomically replace a destination on its own filesystem."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".library-", dir=target.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_stream:
            shutil.copyfileobj(input_stream, output)
            output.flush()
            os.fsync(output.fileno())
        if target.exists():
            temporary.chmod(target.stat().st_mode & 0o777)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class Fingerprint:
    """Cheap bundle metadata plus lazily cached content hashes."""

    sha1: str
    crc: int
    trailing: int | None
    size: int


class Fingerprints:
    """Cache hashes by resolved path, nanosecond mtime and file size. The lock guards the dictionary only, never the
    hashing: two threads may hash one file once each, and the later result wins."""

    def __init__(self) -> None:
        self._values: dict[Path, tuple[tuple[int, int, int], Fingerprint]] = {}
        self._lock = threading.Lock()

    def get(self, path: Path) -> Fingerprint:
        """Read a header and hashes once for each observed file version."""
        path = path.resolve()
        stat = path.stat()
        signature = (stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns)
        with self._lock:
            cached = self._values.get(path)
        if cached and cached[0] == signature:
            return cached[1]
        with path.open("rb") as stream:
            sha1 = hashlib.file_digest(stream, "sha1").hexdigest()
        value = Fingerprint(sha1, CRCUtils.compute_crc32(path), Bundle.get_trailing_bytes(path), stat.st_size)
        with self._lock:
            self._values[path] = (signature, value)
        return value


TAIL = 8  # the last bytes read to tell a file with trailing bytes (a CRC-fixed mod) from another of its size


def trailing_bytes(path: Path) -> int | None:
    """The bytes after the bundle's declared size, from its header alone (never the whole file); None when the
    header cannot be read or the file is shorter than its header says."""
    return Bundle.get_trailing_bytes(path)


def read_tail(path: Path, count: int = TAIL) -> str | None:
    """A file's last ``count`` bytes in hex; None when it cannot be read or is shorter."""
    try:
        with path.open("rb") as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            if size < count:
                return None
            stream.seek(size - count)
            return stream.read(count).hex()
    except OSError:
        return None
