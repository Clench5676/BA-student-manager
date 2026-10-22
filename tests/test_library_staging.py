"""Crash recovery for import staging, using temporary libraries only."""

from pathlib import Path
import subprocess
import sys

from ba_modding_toolkit.filelock import file_lock
from ba_modding_toolkit.library.service import ModLibrary
from ba_modding_toolkit.library.staging import import_directory

from test_library import setup_library


def test_startup_removes_abandoned_imports_but_keeps_active_and_unrelated_files(setup_library):
    env = setup_library
    staging = env.library.root / "staging"
    stale, active, unrelated = [staging / name for name in ("import-stale", "import-active", "keep")]
    for path in (stale, active, unrelated):
        path.mkdir(parents=True)
        (path / "output.bundle").write_bytes(b"temporary data")
    lease = staging / "import-active.lock"
    with file_lock(lease, timeout=0):
        ModLibrary(env.library.root, env.catalog, settings=env.settings)
        assert not stale.exists()
        assert (active / "output.bundle").read_bytes() == b"temporary data"
        assert unrelated.is_dir()
    ModLibrary(env.library.root, env.catalog, settings=env.settings)
    assert not active.exists() and not lease.exists()
    assert unrelated.is_dir()


def test_startup_does_not_follow_staging_symlinks(setup_library):
    env = setup_library
    outside = env.tmp / "outside"
    outside.mkdir()
    (outside / "keep.bundle").write_bytes(b"keep")
    staging = env.library.root / "staging"
    staging.mkdir(parents=True)
    (staging / "import-link").symlink_to(outside, target_is_directory=True)
    ModLibrary(env.library.root, env.catalog, settings=env.settings)
    assert (outside / "keep.bundle").read_bytes() == b"keep"


def test_import_lease_survives_another_library_startup_and_is_cleaned_on_exit(setup_library):
    env = setup_library
    with import_directory(env.library.root) as path:
        (path / "output.bundle").write_bytes(b"building")
        ModLibrary(env.library.root, env.catalog, settings=env.settings)
        assert (path / "output.bundle").read_bytes() == b"building"
    assert not path.exists()
    assert not list((env.library.root / "staging").glob("import-*"))


def test_startup_preserves_another_process_then_cleans_after_forced_quit(setup_library):
    env = setup_library
    script = """
from pathlib import Path
import sys
from ba_modding_toolkit.library.staging import import_directory
with import_directory(Path(sys.argv[1])) as path:
    (path / 'output.bundle').write_bytes(b'building')
    print(path, flush=True)
    sys.stdin.readline()
"""
    process = subprocess.Popen([sys.executable, "-c", script, str(env.library.root)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        path = Path(process.stdout.readline().strip())
        assert path.parent == env.library.root / "staging"
        ModLibrary(env.library.root, env.catalog, settings=env.settings)
        assert (path / "output.bundle").read_bytes() == b"building"
    finally:
        process.kill()
        process.communicate(timeout=5)
    ModLibrary(env.library.root, env.catalog, settings=env.settings)
    assert not path.exists()
