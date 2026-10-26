"""Photography camera, snapshot and lifecycle regressions run without a browser or game assets."""

import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_photography_in_node():
    scripts = sorted((Path(__file__).parent / "js").glob("photography_*.test.mjs"))
    result = subprocess.run([NODE, "--test", *map(str, scripts)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
