"""Import workspaces with process leases and startup crash recovery."""

from contextlib import ExitStack, contextmanager
import logging
from pathlib import Path
import shutil
import tempfile

from .. import devmode
from ..filelock import file_lock

logger = logging.getLogger(__name__)


@contextmanager
def import_directory(root: Path):
    staging = root / "staging"
    devmode.check_read(staging)
    devmode.check_write(staging)
    with ExitStack() as resources:
        # Creation and lease acquisition are atomic with respect to startup cleanup.
        with file_lock(staging / ".lock", timeout=5):
            temporary = resources.enter_context(tempfile.TemporaryDirectory(prefix="import-", dir=staging))
            path = Path(temporary)
            lease = staging / (path.name + ".lock")
            resources.enter_context(file_lock(lease, timeout=0))
        try:
            yield path
        finally:
            with file_lock(staging / ".lock", timeout=5):
                resources.close()
                lease.unlink(missing_ok=True)


def cleanup(root: Path) -> None:
    staging = root / "staging"
    if staging.is_symlink() or not staging.is_dir():
        return
    try:
        devmode.check_read(staging)
        devmode.check_write(staging)
        with file_lock(staging / ".lock", timeout=0):
            for path in staging.glob("import-*"):
                if path.is_symlink() or not path.is_dir():
                    continue
                lease = staging / (path.name + ".lock")
                if lease.is_symlink():
                    continue
                try:
                    with file_lock(lease, timeout=0):
                        shutil.rmtree(path)
                    lease.unlink(missing_ok=True)
                except TimeoutError:
                    continue  # Another instance is still using this workspace.
                except OSError:
                    logger.warning("Could not remove abandoned import %s", path, exc_info=True)
    except TimeoutError:
        pass  # A creation or another cleanup currently owns the directory list.
    except OSError:
        logger.warning("Could not clean import staging %s", staging, exc_info=True)
