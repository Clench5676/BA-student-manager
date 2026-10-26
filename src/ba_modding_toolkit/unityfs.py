"""Shared UnityFS directory parsing without decompressing asset data blocks."""

from __future__ import annotations

import os
import struct
from pathlib import Path

from UnityPy.enums.BundleFile import ArchiveFlags, ArchiveFlagsOld
from UnityPy.helpers.CompressionHelper import DECOMPRESSION_MAP

# This bounds metadata allocation, not the size of the bundle or its asset data.
_MAX_BLOCK_INFO = 64 * 1024 * 1024


def _cstring(stream) -> bytes:
    out = bytearray()
    for _ in range(4096):
        char = stream.read(1)
        if not char or char == b"\0":
            return bytes(out)
        out.extend(char)
    raise ValueError("UnityFS header string is too long")


def _engine_version(value: bytes) -> tuple[int, ...]:
    parts = []
    for token in value.decode("ascii", "ignore").split("."):
        digits = "".join(char for char in token if char.isdigit()) if token.isdigit() else ""
        if not digits:
            for char in token:
                if not char.isdigit():
                    break
                digits += char
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def read_cab_names(path: Path) -> list[str] | None:
    """Return original-case internal names, or None for a non-UnityFS file.

    Corrupt, encrypted and unsupported directories raise ValueError. File-system
    errors remain OSError. Only the header and compressed directory are read.
    """
    try:
        with open(path, "rb") as stream:
            if stream.read(8) != b"UnityFS\0":
                return None
            version = struct.unpack(">I", stream.read(4))[0]
            _cstring(stream)
            engine = _engine_version(_cstring(stream))
            length, compressed, uncompressed, flags = struct.unpack(">qIII", stream.read(20))
            physical = os.fstat(stream.fileno()).st_size
            if (length < stream.tell() or length > physical or not 0 < compressed <= _MAX_BLOCK_INFO
                    or not 24 <= uncompressed <= _MAX_BLOCK_INFO):
                raise ValueError("Invalid UnityFS directory size")
            old = (engine < (2020,) or engine[0] == 2020 and engine < (2020, 3, 34)
                   or engine[0] == 2021 and engine < (2021, 3, 2)
                   or engine[0] == 2022 and engine < (2022, 1, 1))
            archive_flags = ArchiveFlagsOld(flags) if old else ArchiveFlags(flags)
            if archive_flags & archive_flags.UsesAssetBundleEncryption:
                raise ValueError("Encrypted UnityFS directory")
            if flags & ArchiveFlags.BlocksInfoAtTheEnd:
                # A CRC correction may append bytes outside the declared bundle.
                start = length - compressed
                if start < stream.tell():
                    raise ValueError("UnityFS directory overlaps its header")
                stream.seek(start)
            else:
                if version >= 7:
                    stream.seek((stream.tell() + 15) & ~15)
                elif engine >= (2019, 4):
                    # Version 6 files can use either alignment, as in UnityPy.
                    start = stream.tell()
                    if any(stream.read((-start) % 16)):
                        stream.seek(start)
                if stream.tell() + compressed > length:
                    raise ValueError("Truncated UnityFS directory")
            packed = stream.read(compressed)
            if len(packed) != compressed:
                raise ValueError("Truncated UnityFS directory")
        data = DECOMPRESSION_MAP[flags & 0x3F](packed, uncompressed)
        if len(data) != uncompressed:
            raise ValueError("Invalid UnityFS directory length")
        count = struct.unpack_from(">i", data, 16)[0]
        pos = 20 + count * 10
        if count < 0 or pos + 4 > len(data):
            raise ValueError("Invalid UnityFS block table")
        nodes = struct.unpack_from(">i", data, pos)[0]
        pos += 4
        if nodes < 0 or nodes > (len(data) - pos) // 21:
            raise ValueError("Invalid UnityFS node table")
        names = []
        for _ in range(nodes):
            pos += 20
            end = data.index(b"\0", pos)
            names.append(data[pos:end].decode("utf-8", "replace"))
            pos = end + 1
        return names
    except OSError:
        raise
    except Exception as exc:
        raise ValueError(f"Not a readable UnityFS directory: {path}") from exc
