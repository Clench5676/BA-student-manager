"""Regression coverage for library prerequisites in the shared core."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import core
from ba_modding_toolkit.bundle import Bundle, analyze_bundles
from ba_modding_toolkit.models import BundleFileInfo, ModUpdateResult, SaveOptions


@pytest.mark.parametrize("loaded", [False, True])
def test_mod_update_without_extracted_assets_returns_result(monkeypatch, tmp_path, loaded):
    bundle = SimpleNamespace(extract_patch=lambda *args: ({}, [])) if loaded else None
    monkeypatch.setattr(Bundle, "load", lambda *args, **kwargs: bundle)
    result = core.process_mod_update([tmp_path / "empty.bundle"], [], tmp_path,
                                     {"Texture2D"}, SaveOptions())
    assert isinstance(result, ModUpdateResult)
    assert result.success is False
    assert result.file_pairs == []


def test_analyze_bundles_without_progress_callback():
    item = BundleFileInfo(Path("assets-_mx-spinecharacters-test_spr-2026-01-01_123.bundle"), 10)
    analyze_bundles([item], ["naming"])
    assert item.parsed_name.core == "test_spr"


def test_analyze_bundles_reports_progress():
    item = BundleFileInfo(Path("sample.bundle"), 10)
    events = []
    analyze_bundles([item], ["naming"], lambda *args: events.append(args))
    assert events == [(1, 1, "sample.bundle")]
