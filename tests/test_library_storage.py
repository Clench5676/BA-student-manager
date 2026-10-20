"""Native clone adapters and verified cross-volume transfers, using temporary files only."""

import ctypes
import errno
import hashlib
import os
import sys
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.library import storage


def digest(data):
    return hashlib.sha1(data).hexdigest()


def test_failed_clone_cleans_partial_output_and_falls_back_to_rename(tmp_path, monkeypatch):
    source, target = tmp_path / "official", tmp_path / "originals" / "official"
    source.write_bytes(b"official bytes")
    inode = source.stat().st_ino

    def unsupported(source, temporary):
        temporary.write_bytes(b"partial clone")
        raise OSError(errno.ENOTSUP, "Cloning unavailable")

    monkeypatch.setattr(storage, "_clone", unsupported)
    assert not storage.atomic_clone(source, target)
    assert list(target.parent.iterdir()) == []
    monkeypatch.setattr(storage, "atomic_copy", lambda *args: pytest.fail("A same-volume move must not copy"))
    storage.verified_move(source, target, digest(b"official bytes"))
    assert not source.exists() and target.stat().st_ino == inode
    assert target.read_bytes() == b"official bytes"


def test_move_persists_new_parent_directories_before_renaming(tmp_path, monkeypatch):
    source, target = tmp_path / "official", tmp_path / "library" / "originals" / "official"
    source.write_bytes(b"official bytes")
    synced = []
    replace = storage.os.replace

    def replacing(src, dst):
        assert synced == [tmp_path, tmp_path / "library"]
        return replace(src, dst)

    monkeypatch.setattr(storage, "sync_directory", synced.append)
    monkeypatch.setattr(storage.os, "replace", replacing)
    storage.verified_move(source, target, digest(b"official bytes"))
    assert synced[-2:] == [target.parent, source.parent]
    assert target.read_bytes() == b"official bytes" and not source.exists()


def test_clone_preserves_destination_permissions(tmp_path, monkeypatch):
    source, target = tmp_path / "official", tmp_path / "game"
    source.write_bytes(b"official bytes")
    source.chmod(0o444)
    target.write_bytes(b"modded bytes")
    target.chmod(0o640)

    def clone(src, dst):
        import shutil
        shutil.copy2(src, dst)
        return True

    monkeypatch.setattr(storage, "_clone", clone)
    try:
        assert storage.atomic_clone(source, target)
        assert target.stat().st_mode & 0o777 == 0o640
        assert target.read_bytes() == b"official bytes"
    finally:
        source.chmod(0o644)


@pytest.mark.parametrize("corrupt", [False, True])
def test_cross_volume_move_verifies_before_removing_source(tmp_path, monkeypatch, corrupt):
    source, target = tmp_path / "official", tmp_path / "other-volume" / "official"
    source.write_bytes(b"official bytes")
    replace, copy, verify = storage.os.replace, storage.atomic_copy, storage.verify_file
    observations = []

    def across_volumes(src, dst):
        if src == source and dst == target:
            raise OSError(errno.EXDEV, "Different volumes")
        return replace(src, dst)

    def copying(src, dst):
        assert source.exists()
        copy(src, dst)
        if corrupt:
            dst.write_bytes(b"damaged bytes")

    def verifying(path, sha1):
        observations.append(source.exists())
        return verify(path, sha1)

    monkeypatch.setattr(storage.os, "replace", across_volumes)
    monkeypatch.setattr(storage, "atomic_copy", copying)
    monkeypatch.setattr(storage, "verify_file", verifying)
    if corrupt:
        with pytest.raises(OSError, match="verification failed"):
            storage.verified_move(source, target, digest(b"official bytes"))
        assert source.read_bytes() == b"official bytes"
        assert observations == [True]
    else:
        storage.verified_move(source, target, digest(b"official bytes"))
        assert observations == [True, False]
        assert not source.exists() and target.read_bytes() == b"official bytes"


@pytest.mark.skipif(sys.platform != "darwin", reason="APFS clonefile requires macOS")
def test_native_apfs_clone_is_independent_and_preserves_source(tmp_path):
    source, target = tmp_path / "source", tmp_path / "clone"
    data = b"official bytes" * 4096
    source.write_bytes(data)
    if not storage.atomic_clone(source, target):
        pytest.skip("The temporary volume does not support APFS clones")
    assert source.stat().st_ino != target.stat().st_ino
    source.write_bytes(b"changed source")
    assert target.read_bytes() == data


def test_refs_adapter_flushes_then_clones_aligned_extents_and_copies_tail(tmp_path, monkeypatch):
    source, target = tmp_path / "source", tmp_path / "clone"
    data = b"official" * 1300  # two 4096-byte clusters and a partial tail
    source.write_bytes(data)
    calls = []
    fsync = storage.os.fsync

    class Function:
        def __init__(self, call):
            self.call = call

        def __call__(self, *args):
            return self.call(*args)

    def space(root, sectors, sector_size, free, total):
        sectors._obj.value, sector_size._obj.value = 8, 512
        return True

    def ioctl(output, code, pointer, size, *args):
        extent = pointer._obj
        assert code == 0x00098344 and calls[0] == "flush"
        assert extent.SourceFileOffset % 4096 == extent.TargetFileOffset % 4096 == extent.ByteCount % 4096 == 0
        calls.append((extent.SourceFileOffset, extent.ByteCount))
        os.pwrite(output, os.pread(extent.FileHandle, extent.ByteCount, extent.SourceFileOffset),
                  extent.TargetFileOffset)
        return True

    def flush(fd):
        calls.append("flush")
        return fsync(fd)

    kernel = SimpleNamespace(GetDiskFreeSpaceW=Function(space), DeviceIoControl=Function(ioctl))
    monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **kw: kernel, raising=False)
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(get_osfhandle=lambda fd: fd))
    monkeypatch.setattr(storage.os, "fsync", flush)
    storage._refs_clone(source, target)
    assert (0, 8192) in calls
    assert target.read_bytes() == source.read_bytes() == data
