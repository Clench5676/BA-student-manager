"""Classic install previews without opening Tk or using game assets or external tools."""

from threading import Barrier
from types import SimpleNamespace

import pytest
from PIL import Image

from ba_modding_toolkit.gui.components import CanvasSyncGroup, DualZoomableCanvas, ZoomableCanvas
from ba_modding_toolkit.gui.windows import mod_install_dialog as preview
from ba_modding_toolkit.models import AnimCheckOptions
from ba_modding_toolkit.mod_install import InstallAction, ModFilePlan, ModGroup
from ba_modding_toolkit.naming import parse_filename


class CanvasHarness:
    _on_wheel = ZoomableCanvas._on_wheel
    _on_press = ZoomableCanvas._on_press
    _on_motion = ZoomableCanvas._on_motion
    _apply_zoom = ZoomableCanvas._apply_zoom
    _schedule_render = ZoomableCanvas._schedule_render
    _render_interactive = ZoomableCanvas._render_interactive
    _render_quality = ZoomableCanvas._render_quality

    def __init__(self, group, fit):
        self._pil = Image.new("RGBA", (10, 10))
        self._fit = self._scale = fit
        self._zoom = 1.0
        self._scale_max = 8.0
        self._sync_group = group
        group.canvases.append(self)
        self._drag_start = None
        self._img_id = "image"
        self._interactive_job = self._quality_job = None
        self.jobs, self.moves, self.renders = {}, [], []
        self._next_job = 0
        self.tk = SimpleNamespace(call=lambda *args: "aqua")

    def winfo_exists(self):
        return True

    def after(self, delay, callback):
        self._next_job += 1
        job = str(self._next_job)
        self.jobs[job] = callback
        return job

    def after_cancel(self, job):
        del self.jobs[job]

    def move(self, item, dx, dy):
        self.moves.append((dx, dy))

    def _render(self, fast=False):
        self.renders.append(fast)


def test_macos_horizontal_wheel_is_ignored_with_synchronized_previews():
    group = CanvasSyncGroup()
    left, right = CanvasHarness(group, 0.5), CanvasHarness(group, 0.25)
    left._on_wheel(SimpleNamespace(delta=120, state=1))
    assert left._zoom == right._zoom == 1.0
    assert left.jobs == right.jobs == {}
    left._on_wheel(SimpleNamespace(delta=120, state=0))
    assert left._zoom == right._zoom == pytest.approx(1.1)
    assert left._scale == pytest.approx(2 * right._scale)


def test_zoom_pan_and_sync_toggle_keep_relative_image_scales():
    group = CanvasSyncGroup()
    left, right = CanvasHarness(group, 0.5), CanvasHarness(group, 0.25)
    dual = SimpleNamespace(sync_group=group, canvases=[left, right])
    left._on_press(SimpleNamespace(x=10, y=20))
    left._on_motion(SimpleNamespace(x=15, y=13))
    assert left.moves == right.moves == [(5, -7)]

    DualZoomableCanvas.set_sync(dual, False)
    left._on_wheel(SimpleNamespace(delta=120, state=0))
    left._on_motion(SimpleNamespace(x=18, y=14))
    assert left._zoom == pytest.approx(1.1) and right._zoom == 1.0
    assert right.moves == [(5, -7)]
    DualZoomableCanvas.set_sync(dual, True)
    assert right._zoom == left._zoom


def test_rapid_zoom_caps_scale_and_coalesces_fast_and_quality_renders():
    canvas = CanvasHarness(CanvasSyncGroup(), 0.5)
    canvas._scale_max = 1.0
    for _ in range(30):
        canvas._on_wheel(SimpleNamespace(delta=120, state=0))
    assert canvas._scale == 1.0
    assert len(canvas.jobs) == 2
    callbacks = list(canvas.jobs.values())
    canvas.jobs.clear()
    for callback in callbacks:
        callback()
    assert canvas.renders == [True, False]
    assert canvas._interactive_job is canvas._quality_job is None


@pytest.mark.parametrize("render_state", ["ok", "absent", "failed"])
def test_preview_pairs_match_names_and_survive_extraction_cleanup(tmp_path, monkeypatch, render_state):
    current, source = tmp_path / "current.bundle", tmp_path / "new.bundle"
    current.write_bytes(b"current")
    source.write_bytes(b"new")
    file = ModFilePlan(source, parse_filename(source.name), InstallAction.DIRECT_REPLACE, current)
    group = ModGroup("prefix", None, "student", [file])
    cache = tmp_path / "cache"
    cache.mkdir()
    monkeypatch.setattr(preview, "_cache_dir", cache)
    monkeypatch.setattr(preview.Bundle, "list_asset_names", lambda *args: set())
    specs = {current: ("alpha.skel", "sprite.png"),
             source: ("alpha.skel", "beta.skel", "sprite.png", "added.png")}

    def extract(bundle, directory, log):
        directory.mkdir(parents=True)
        assets = []
        for name in specs[bundle]:
            path = directory / name
            texture = name.endswith(".png")
            if texture:
                Image.new("RGBA", (8, 12), "red" if bundle == current else "blue").save(path)
            else:
                path.write_bytes(b"synthetic skeleton")
            assets.append(preview._SideAsset(name, "Texture2D" if texture else "TextAsset",
                                             "8x12" if texture else "spine", preview._sha(path), path))
        return assets

    rendered = []

    def render(bundles, directory, viewer, **kwargs):
        rendered.append(bundles)
        if render_state == "failed":
            return False, "synthetic render failure", []
        directory.mkdir(parents=True)
        paths = []
        for name in specs[bundles[0]]:
            if name.endswith(".skel"):
                path = directory / name.replace(".skel", ".png")
                Image.new("RGBA", (8, 12)).save(path)
                paths.append(path)
        return True, "", paths

    monkeypatch.setattr(preview, "_extract_bundle_assets", extract)
    monkeypatch.setattr(preview, "render_spine_preview_from_bundle", render)
    viewer = tmp_path / "synthetic-viewer"
    viewer.touch()
    result = preview._process_group(group, viewer if render_state != "absent" else None,
                                     AnimCheckOptions(), lambda message: None)

    assert result.error is None
    assert [pair.label for pair in result.previews] == [
        f"{preview.t('ui.mod_install.preview_tag_render')} alpha",
        f"{preview.t('ui.mod_install.preview_tag_render')} beta",
        f"{preview.t('ui.mod_install.preview_tag_extract')} added.png",
        f"{preview.t('ui.mod_install.preview_tag_extract')} sprite.png",
    ]
    alpha, beta, added, sprite = result.previews
    assert beta.current_image is None and added.current_image is None
    assert sprite.current_image != sprite.new_image
    assert sprite.current_image.read_bytes() != sprite.new_image.read_bytes()
    for pair in result.previews:
        for path in (pair.current_image, pair.new_image):
            if path is not None:
                assert path.is_relative_to(cache) and path.is_file()
    assert current in result.matched
    if render_state == "ok":
        assert alpha.current_image and alpha.new_image and beta.new_image
    else:
        assert alpha.current_image is alpha.new_image is beta.new_image is None
    if render_state == "failed":
        assert alpha.current_error == alpha.new_error == "synthetic render failure"
    assert rendered == ([] if render_state == "absent" else [[current], [source]])


class Variable:
    def __init__(self, value):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


@pytest.mark.parametrize("current_index", [0, 3])
def test_bulk_decisions_leave_uninstallable_groups_skipped(current_index):
    groups = [SimpleNamespace(group_action=action) for action in (
        InstallAction.DIRECT_REPLACE, InstallAction.UPDATE, InstallAction.NOT_FOUND, InstallAction.ERROR)]
    refreshed = []
    dialog = SimpleNamespace(
        groups=groups, current_index=current_index, decision_vars=[Variable(False) for _ in groups],
        decision_var=Variable(False), _installable=preview.ModInstallDialog._installable,
        _refresh_jump_list=lambda: refreshed.append("list"),
        _update_confirm_text=lambda: refreshed.append("confirm"))
    preview.ModInstallDialog._set_all_decisions(dialog, True)
    assert [var.get() for var in dialog.decision_vars] == [True, True, False, False]
    assert dialog.decision_var.get() is (current_index == 0)
    preview.ModInstallDialog._set_all_decisions(dialog, False)
    assert not any(var.get() for var in dialog.decision_vars)
    assert refreshed == ["list", "confirm", "list", "confirm"]


def test_parallel_preview_pipeline_finishes_classic_busy_tracking(tmp_path, monkeypatch):
    groups = []
    for name in ("first", "second"):
        path = tmp_path / f"{name}.bundle"
        path.touch()
        file = ModFilePlan(path, parse_filename(path.name), InstallAction.NOT_FOUND)
        groups.append(ModGroup(name, None, name, [file]))
    rendezvous = Barrier(2)
    results, running = [], []

    def process(group, *args):
        rendezvous.wait(timeout=5)
        return preview.GroupRenderResult()

    monkeypatch.setattr(preview, "_process_group", process)
    monkeypatch.setattr(preview, "_render_cache", {})
    dialog = SimpleNamespace(
        groups=groups, _pipeline_running=True, should_stop=lambda: False,
        after=lambda delay, callback, *args: callback(*args),
        _apply_result=lambda index, result: results.append((index, result)),
        set_task_running=running.append,
        app=SimpleNamespace(spine_viewer_path_var=Variable(""), max_workers_var=Variable(2),
                            build_anim_check_options=AnimCheckOptions,
                            logger=SimpleNamespace(log=lambda message: None)))
    preview.ModInstallDialog._pipeline_worker(dialog)
    assert {index for index, _ in results} == {0, 1}
    assert all(result.error is None for _, result in results)
    assert dialog._pipeline_running is False and running == [False]
