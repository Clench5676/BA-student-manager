"""Regression coverage for library prerequisites in the shared core."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import core
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.models import ModUpdateResult, SaveOptions


@pytest.mark.parametrize("loaded", [False, True])
def test_mod_update_without_extracted_assets_returns_result(monkeypatch, tmp_path, loaded):
    bundle = SimpleNamespace(extract_patch=lambda *args: ({}, [])) if loaded else None
    monkeypatch.setattr(Bundle, "load", lambda *args, **kwargs: bundle)
    result = core.process_mod_update([tmp_path / "empty.bundle"], [], tmp_path,
                                     {"Texture2D"}, SaveOptions())
    assert isinstance(result, ModUpdateResult)
    assert result.success is False
    assert result.file_pairs == []
