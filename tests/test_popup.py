"""The shared popups (web/js/popup.js) and the update popup (web/js/update.js) are front-end code: their tests run with
Node's test runner on a stand-in DOM, skipped where Node is not installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "popup.test.mjs"


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_popup_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
