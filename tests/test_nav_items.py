"""The bottom navigation's entries (web/js/nav-items.js: greyed entries, the hand-off and its prompt, the greyed look)
are front-end code: their tests run with Node's test runner, skipped where Node is not installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "nav_items.test.mjs"


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_nav_items_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
