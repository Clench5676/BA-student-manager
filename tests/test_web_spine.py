"""The front end's choice of a portrait skeleton's idle (web/js/thumbs.js), run with Node.js when it is installed.

Every Spine portrait load (the detail screen's portrait and the thumbnails) loops this animation on track 0; a few
NPC skeletons have no Idle_01 (the capitalist robot only carries the "00" face), and asking spine-player for a
missing animation fails the whole load.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

THUMBS = Path(__file__).resolve().parents[1] / "src" / "ba_modding_toolkit" / "web" / "js" / "thumbs.js"
NODE = shutil.which("node")


def idle_of(names: list[str]):
    """idleAnimation() on stand-in skeleton data with these animation names, in this order."""
    script = f"""
import {{ idleAnimation }} from {json.dumps(THUMBS.as_uri())};
const names = {json.dumps(names)};
const data = {{
  animations: names.map((name) => ({{ name }})),
  findAnimation: (name) => (names.includes(name) ? {{ name }} : null),
}};
console.log(JSON.stringify(idleAnimation(data)));
"""
    run = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=60)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


@pytest.mark.skipif(NODE is None, reason="needs Node.js")
@pytest.mark.parametrize(("names", "idle"), [
    (["00", "01", "Eye_Close_01", "Idle_01"], "Idle_01"),  # a student: the game's idle, wherever it is listed
    (["00", "Idle_02", "Idle_01"], "Idle_01"),             # Idle_01 before any other idle
    (["00", "01", "idle_loop", "Talk_01_A"], "idle_loop"),  # no Idle_01: the first idle-like animation
    (["00"], None),                                        # only the default face: the setup pose, nothing looped
    (["00", "Dummy", "Start_Idle_01"], None),              # never a face, a dummy or an intro
    ([], None),
])
def test_idle_animation_falls_back_to_the_skeletons_own_idle(names, idle):
    assert idle_of(names) == idle
