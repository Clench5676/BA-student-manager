"""Update check and in-app update from the project's GitHub releases.

Releases are tagged with the bare version (e.g. ``0.1.0-alpha``) and carry the platform builds plus one ``.md5`` file
per build (``<hash>  <file name>``). An update downloads the build for this platform, checks its MD5, and swaps it in
after the app quits: a small script waits for the process to end, replaces the program and starts it again.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import re
import shlex
import subprocess
import sys
import sysconfig
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from .errors import ServiceError
from .utils import get_version_info

logger = logging.getLogger(__name__)

REPO = "Clench5676/BlueArchive-Modding-and-Patching-Tool"
API = f"https://api.github.com/repos/{REPO}/releases?per_page=30"
USER_AGENT = "Blue-Archive-Modding-and-Patching-Tool-updater"
CHUNK = 1 << 16

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def parse_version(text: str) -> tuple | None:
    """A sortable key following SemVer 2.0.0 precedence, or None when ``text`` is not a version.

    A version without a pre-release ranks above the same version with one; pre-release identifiers compare one by one,
    numbers numerically and below any text."""
    m = _SEMVER.match(text.strip())
    if not m:
        return None
    core = tuple(int(x) for x in m.group(1, 2, 3))
    pre = m.group(4)
    if not pre:
        return core + ((1,),)
    ids = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split("."))
    return core + ((0, ids),)


def current_version() -> str:
    """This build's version; development runs report ``<version>-dev``."""
    return get_version_info().get("version") or "0.0.0"


def is_compiled() -> bool:
    return "__compiled__" in globals() or getattr(sys, "frozen", False)


@dataclass
class Asset:
    name: str
    url: str
    size: int

    def to_json(self) -> dict:
        return {"name": self.name, "size": self.size}


@dataclass
class UpdateInfo:
    version: str
    current: str
    page: str
    asset: Asset | None
    checksum: Asset | None
    prerelease: bool = False
    installable: bool = field(default=False)

    def to_json(self) -> dict:
        return {"version": self.version, "current": self.current, "page": self.page, "prerelease": self.prerelease,
                "asset": self.asset.to_json() if self.asset else None, "installable": self.installable}


def platform_suffix() -> str | None:
    """The end of this platform's build name: ``-macos-arm64.dmg`` or ``-windows-x64.exe``."""
    machine = platform.machine().lower()
    if sys.platform == "darwin":
        return f"-macos-{'arm64' if machine in ('arm64', 'aarch64') else 'x86_64'}.dmg"
    if sys.platform == "win32":
        # The x64 build also runs on ARM hosts; only x64 Windows assets are published.
        return "-windows-x64.exe" if sysconfig.get_platform().lower() == "win-amd64" else None
    return None


def pick_assets(assets: list[dict], suffix: str | None, version: str) -> tuple[Asset | None, Asset | None]:
    """The GUI build for this platform and its ``.md5`` file (the CLI builds are named ``...-cli-...``)."""
    if not suffix:
        return None, None
    by_name = {a["name"]: Asset(a["name"], a["browser_download_url"], int(a.get("size") or 0)) for a in assets}
    builds = [a for n, a in by_name.items() if n.endswith(f"-{version}{suffix}") and "-cli-" not in n.lower()]
    if not builds:
        return None, None
    build = sorted(builds, key=lambda a: a.name)[0]
    return build, by_name.get(build.name + ".md5")


def _get(url: str, timeout: float) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def latest(releases: list[dict], current: str, suffix: str | None) -> UpdateInfo | None:
    """The newest release above ``current`` (drafts skipped; pre-releases included, the project is in alpha)."""
    mine = parse_version(current.removesuffix("-dev")) or parse_version("0.0.0")
    best = None
    for rel in releases:
        if rel.get("draft"):
            continue
        key = parse_version(rel.get("tag_name", ""))
        if key is None or key <= mine:
            continue
        if best is None or key > best[0]:
            best = (key, rel)
    if best is None:
        return None
    rel = best[1]
    version = rel["tag_name"].removeprefix("v")
    asset, checksum = pick_assets(rel.get("assets", []), suffix, version)
    return UpdateInfo(version=version, current=current, page=rel.get("html_url", ""),
                      asset=asset, checksum=checksum, prerelease=bool(rel.get("prerelease")),
                      installable=bool(asset and checksum and is_compiled() and install_target() is not None))


def check(timeout: float = 10.0) -> UpdateInfo | None:
    """Ask GitHub for a newer release. ``ServiceError("update_check_failed")`` when it cannot be reached."""
    try:
        releases = json.loads(_get(API, timeout))
    except Exception as e:  # network errors, HTTP errors, bad JSON
        raise ServiceError("update_check_failed", error=str(e)) from e
    return latest(releases, current_version(), platform_suffix())


def parse_md5(text: str, name: str) -> str | None:
    """The hash for ``name`` in an md5sum-style file (``<hash>  <name>``), or a lone hash."""
    for line in text.splitlines():
        parts = line.strip().split()
        if not parts or not re.fullmatch(r"[0-9a-fA-F]{32}", parts[0]):
            continue
        if len(parts) == 1 or parts[-1].lstrip("*") == name:
            return parts[0].lower()
    return None


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def download(info: UpdateInfo, dest: Path, progress: Callable[[int, int, str], None] | None = None,
             timeout: float = 30.0) -> tuple[Path, str]:
    """Download and verify the build; return its path and the MD5 to retain for ``install``."""
    if not info.asset or not info.checksum:
        raise ServiceError("update_unavailable", version=info.version)
    dest.mkdir(parents=True, exist_ok=True)
    try:
        expected = parse_md5(_get(info.checksum.url, timeout).decode("utf-8", "replace"), info.asset.name)
    except Exception as e:
        raise ServiceError("update_download_failed", error=str(e)) from e
    if not expected:
        raise ServiceError("update_checksum_mismatch", file=info.asset.name)
    target = dest / info.asset.name
    partial = target.with_suffix(target.suffix + ".part")
    try:
        req = urllib.request.Request(info.asset.url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=timeout) as res, partial.open("wb") as out:
            total = int(res.headers.get("Content-Length") or info.asset.size or 0)
            done = 0
            while True:
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if progress:
                    progress(done, total, info.asset.name)
    except Exception as e:
        partial.unlink(missing_ok=True)
        raise ServiceError("update_download_failed", error=str(e)) from e
    if md5_of(partial) != expected:
        partial.unlink(missing_ok=True)
        raise ServiceError("update_checksum_mismatch", file=info.asset.name)
    os.replace(partial, target)
    return target, expected


# --- installing: a script swaps the program in once this process has quit ---

def install_target() -> Path | None:
    """The writable ``.app`` bundle or ``.exe`` an update can replace, or None."""
    target = None
    if sys.platform == "darwin":
        for parent in Path(sys.executable).resolve().parents:
            if parent.suffix == ".app":
                if parent.is_relative_to("/Volumes") or "AppTranslocation" in parent.parts:
                    return None
                target = parent
                break
    elif sys.platform == "win32":
        # Nuitka onefile runs from a temporary folder; argv[0] is the program the user started
        exe = Path(sys.argv[0]).resolve()
        if exe.suffix.lower() == ".exe" and exe.is_file():
            target = exe
    if target is None or not os.access(target.parent, os.W_OK) or not os.access(target, os.W_OK):
        return None
    try:
        # Windows os.access does not check directory ACLs (notably those on Program Files).
        with tempfile.TemporaryFile(prefix=".bamt-write-test-", dir=target.parent):
            pass
    except OSError:
        return None
    return target


def macos_script(dmg: Path, app: Path, pid: int) -> str:
    q = shlex.quote
    staged = app.with_name(f".{app.stem}.update.app")
    return f"""#!/bin/sh
# waits for the app to quit, then replaces it with the one in the downloaded disk image and starts it again
while kill -0 {pid} 2>/dev/null; do sleep 0.5; done
MNT=$(mktemp -d)
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" {q(str(dmg))} >/dev/null || exit 1
SRC=$(find "$MNT" -maxdepth 1 -name '*.app' | head -n 1)
if [ -n "$SRC" ]; then
  rm -rf {q(str(staged))}
  ditto "$SRC" {q(str(staged))} && rm -rf {q(str(app))} && mv {q(str(staged))} {q(str(app))}
fi
hdiutil detach "$MNT" >/dev/null
rmdir "$MNT"
xattr -dr com.apple.quarantine {q(str(app))} 2>/dev/null
rm -f {q(str(dmg))}
open {q(str(app))}
"""


def windows_script(pids: list[int]) -> str:
    """An ASCII helper; paths arrive through Unicode environment variables, expanded only once."""
    labels = "\n".join(f":wait{pid}\n" + f'tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait{pid})'
                        for pid in pids)
    return f"""@echo off
setlocal DisableDelayedExpansion
rem waits for the program (the onefile launcher and the program it started) to quit, then replaces it with the
rem downloaded build and starts it again; the move is retried while Windows still holds the old file
{labels}
set tries=0
:move
move /Y "%BAMT_UPDATE_NEW_EXE%" "%BAMT_UPDATE_EXE%" >nul && goto start
set /a tries+=1
if %tries% geq 60 goto end
timeout /t 1 /nobreak >nul
goto move
:start
start "" "%BAMT_UPDATE_EXE%"
:end
del "%~f0"
"""


def install(downloaded: Path, expected_md5: str) -> None:
    """Recheck the MD5 retained from ``download``, then start the swap helper; the caller must quit."""
    target = install_target()
    if not is_compiled() or target is None:
        raise ServiceError("update_unsupported")
    if not re.fullmatch(r"[0-9a-fA-F]{32}", expected_md5):
        raise ServiceError("update_checksum_mismatch", file=downloaded.name)
    try:
        actual = md5_of(downloaded)
    except OSError as e:
        raise ServiceError("update_download_failed", error=str(e)) from e
    if actual != expected_md5.lower():
        raise ServiceError("update_checksum_mismatch", file=downloaded.name)
    pid = os.getpid()
    if sys.platform == "darwin":
        fd, name = tempfile.mkstemp(prefix="bamt-update-", suffix=".sh")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(macos_script(downloaded, target, pid))
        os.chmod(name, 0o755)
        subprocess.Popen(["/bin/sh", name], start_new_session=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif sys.platform == "win32":
        fd, name = tempfile.mkstemp(prefix="bamt-update-", suffix=".cmd")
        with os.fdopen(fd, "w", encoding="ascii") as f:
            # a onefile build runs as a launcher process plus this one; wait for both
            parent = os.environ.get("NUITKA_ONEFILE_PARENT", "")
            pids = [pid] + ([int(parent)] if parent.isdigit() else [])
            f.write(windows_script(pids))
        env = os.environ.copy()
        env.update(BAMT_UPDATE_SCRIPT=name, BAMT_UPDATE_NEW_EXE=str(downloaded.resolve()), BAMT_UPDATE_EXE=str(target))
        # cmd expands these variables once. Literal percent signs in their values are not expanded again.
        # Quoting the variable also protects the helper's own path when TEMP contains spaces or percent signs.
        cmd = env.get("COMSPEC", "cmd.exe")
        command = f'"{cmd}" /d /v:off /s /c ""%BAMT_UPDATE_SCRIPT%""'
        hidden = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        subprocess.Popen(command, env=env, creationflags=hidden, close_fds=True)
    else:
        raise ServiceError("update_unsupported")
