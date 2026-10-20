"""Atomic file storage and cached bundle fingerprints."""

from __future__ import annotations

import errno
import hashlib
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..bundle import Bundle

logger = logging.getLogger(__name__)


def sync_directory(path: Path) -> None:
    """Persist a rename on filesystems that support flushing directory handles."""
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        try:
            os.fsync(fd)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(fd)


def _make_parents(path: Path) -> None:
    """Persist new directory entries before a transfer can remove its source."""
    missing = []
    directory = path.parent
    while not directory.exists():
        missing.append(directory)
        directory = directory.parent
    path.parent.mkdir(parents=True, exist_ok=True)
    for directory in reversed(missing):
        sync_directory(directory.parent)


def atomic_json(path: Path, data: dict[str, Any]) -> None:
    """Replace a JSON file only after the complete new contents are flushed."""
    _make_parents(path)
    fd, name = tempfile.mkstemp(prefix=".state-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_copy(source: Path, target: Path) -> None:
    """Copy bytes and atomically replace a destination on its own filesystem."""
    _make_parents(target)
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
        sync_directory(target.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _clone(source: Path, target: Path) -> bool:
    """Create a native copy-on-write clone, or report an unsupported operation."""
    if sys.platform == "darwin":
        import ctypes

        clonefile = ctypes.CDLL(None, use_errno=True).clonefile
        clonefile.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
        clonefile.restype = ctypes.c_int
        return clonefile(os.fsencode(source), os.fsencode(target), 0) == 0
    if os.name == "nt":
        _refs_clone(source, target)
        return True
    return False


def _refs_clone(source: Path, target: Path) -> None:
    """Clone aligned ReFS extents; only a final partial cluster needs a byte copy."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    class Extents(ctypes.Structure):
        _fields_ = [("FileHandle", wintypes.HANDLE), ("SourceFileOffset", ctypes.c_int64),
                    ("TargetFileOffset", ctypes.c_int64), ("ByteCount", ctypes.c_int64)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetDiskFreeSpaceW.argtypes = [wintypes.LPCWSTR, *([ctypes.POINTER(wintypes.DWORD)] * 4)]
    kernel.GetDiskFreeSpaceW.restype = wintypes.BOOL
    kernel.DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                                      wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                      wintypes.LPVOID]
    kernel.DeviceIoControl.restype = wintypes.BOOL
    sectors, sector_size, free, total = (wintypes.DWORD() for _ in range(4))
    if not kernel.GetDiskFreeSpaceW(source.anchor, ctypes.byref(sectors), ctypes.byref(sector_size),
                                   ctypes.byref(free), ctypes.byref(total)):
        raise ctypes.WinError(ctypes.get_last_error())
    cluster = sectors.value * sector_size.value
    with source.open("r+b") as input_stream, target.open("x+b") as output:
        os.fsync(input_stream.fileno())
        size = os.fstat(input_stream.fileno()).st_size
        aligned = size - size % cluster
        if not aligned:
            raise OSError(errno.ENOTSUP, "File smaller than a clone extent", str(source))
        output.truncate(size)
        offset = 0
        while offset < aligned:
            count = min(aligned - offset, (1024 ** 3 // cluster) * cluster)
            extents = Extents(msvcrt.get_osfhandle(input_stream.fileno()), offset, offset, count)
            returned = wintypes.DWORD()
            if not kernel.DeviceIoControl(msvcrt.get_osfhandle(output.fileno()), 0x00098344,
                                          ctypes.byref(extents), ctypes.sizeof(extents), None, 0,
                                          ctypes.byref(returned), None):
                raise ctypes.WinError(ctypes.get_last_error())
            offset += count
        if aligned < size:
            input_stream.seek(aligned)
            output.seek(aligned)
            shutil.copyfileobj(input_stream, output)
        output.flush()
        os.fsync(output.fileno())


def atomic_clone(source: Path, target: Path) -> bool:
    """Publish a flushed native clone, never silently substitute a full byte copy."""
    _make_parents(target)
    temporary = target.parent / f".library-{uuid.uuid4().hex}"
    try:
        try:
            if not _clone(source, temporary):
                return False
        except (OSError, AttributeError):
            return False
        if target.exists():
            temporary.chmod(target.stat().st_mode & 0o777)
        with temporary.open("r+b" if os.name == "nt" else "rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        sync_directory(target.parent)
        return True
    finally:
        temporary.unlink(missing_ok=True)


def verify_file(path: Path, sha1: str) -> None:
    """Verify the actual destination bytes before deleting any source."""
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha1").hexdigest()
    if actual != sha1:
        raise OSError(errno.EIO, "File verification failed", str(path))


def verified_move(source: Path, target: Path, sha1: str) -> None:
    """Rename, or copy across volumes and delete only after verification; callers journal first."""
    _make_parents(target)
    with source.open("r+b" if os.name == "nt" else "rb") as stream:
        os.fsync(stream.fileno())
    try:
        os.replace(source, target)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        atomic_copy(source, target)
        verify_file(target, sha1)
        source.unlink()
    sync_directory(target.parent)
    sync_directory(source.parent)
    verify_file(target, sha1)


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
        sha1, crc = hashlib.sha1(), 0
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                sha1.update(block)
                crc = zlib.crc32(block, crc)
        value = Fingerprint(sha1.hexdigest(), crc, Bundle.get_trailing_bytes(path), stat.st_size)
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
