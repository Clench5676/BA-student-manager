"""The 3D candidate still queue and real renderer with a stand-in GPU."""
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
@pytest.mark.parametrize("name", ["model_still", "model_still_render"])
def test_model_still_in_node(name):
    path = Path(__file__).parent / "js" / f"{name}.test.mjs"
    result = subprocess.run([shutil.which("node"), "--test", str(path)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
