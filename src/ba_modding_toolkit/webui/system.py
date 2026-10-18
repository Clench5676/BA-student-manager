"""Operating-system helpers without Tk: reveal a file, start the classic GUI."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path

from ..errors import ServiceError

logger = logging.getLogger(__name__)

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def reveal(path: str | Path) -> None:
    """Show a file (selected) or a folder in the system file manager."""
    p = Path(path).resolve()
    if not p.exists():
        raise ServiceError("path_not_found", path=str(p))
    try:
        if sys.platform == "win32":
            # explorer parses its command line loosely: quote the whole path as one argument
            subprocess.Popen(f'explorer /select,"{p}"' if p.is_file() else f'explorer "{p}"',
                             creationflags=CREATE_NO_WINDOW)
        elif sys.platform == "darwin":
            subprocess.run(["open", "-R", str(p)] if p.is_file() else ["open", str(p)], check=True)
        elif _is_wsl():
            win = subprocess.run(["wslpath", "-w", str(p)], capture_output=True, text=True, check=True).stdout.strip()
            subprocess.Popen(f'explorer.exe /select,"{win}"' if p.is_file() else f'explorer.exe "{win}"')
        else:
            subprocess.run(["xdg-open", str(p.parent if p.is_file() else p)], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise ServiceError("reveal_failed", path=str(p), error=str(e)) from e


CLASSIC_TABS = ("mod_update", "batch_update", "mod_install", "crc_tool", "asset_packer", "asset_extractor",
                "adb_push", "tools")


def open_classic(tab: str | None = None) -> None:
    """Start the classic Tk GUI in its own process, optionally on a tab."""
    if tab is not None and tab not in CLASSIC_TABS:
        raise ServiceError("bad_params", tab=tab)
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        cmd = [sys.executable]  # a compiled build: the executable itself starts the classic GUI
    else:
        cmd = [sys.executable, "-m", "ba_modding_toolkit"]
    if tab:
        cmd += ["--tab", tab]
    try:
        subprocess.Popen(cmd, creationflags=CREATE_NO_WINDOW, env=os.environ.copy())
    except OSError as e:
        raise ServiceError("classic_failed", error=str(e)) from e
