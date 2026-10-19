"""The lobby's linear-light drawing (web/js/linear.js) is front-end code: its tests run with Node's test runner against
a recording stand-in for WebGL2, skipped where Node is not installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "linear.test.mjs"


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_linear_light_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
