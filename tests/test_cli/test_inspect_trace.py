"""CLI inspection preserves local-only behavior and cache options."""

from typing import TYPE_CHECKING
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.cli import handlers
from ba_modding_toolkit.core import introspect

from ba_modding_toolkit.cli.handlers import handle_inspect, handle_trace
from ba_modding_toolkit.cli.taps import InspectTap, TraceTap

if TYPE_CHECKING:
    from conftest import SampleCase


class LogCapture:
    """Capture handler output without configuring logging."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def log(self, message: str) -> None:
        self.lines.append(message)


def test_inspect_runs(sample_case: "SampleCase") -> None:
    """Inspect an available official fixture."""
    logger = LogCapture()
    handle_inspect(InspectTap().parse_args([str(sample_case.bundle_paths[0]), "--local-only"]), logger)
    assert logger.lines


def test_trace_runs(sample_case: "SampleCase") -> None:
    """Trace an available official fixture."""
    logger = LogCapture()
    handle_trace(TraceTap().parse_args([str(sample_case.bundle_paths[0]), "--local-only"]), logger)
    assert logger.lines


def test_missing_input_terminates_gracefully() -> None:
    """Report missing inputs without raising."""
    logger = LogCapture()
    handle_inspect(InspectTap().parse_args(["nonexistent.bundle"]), logger)
    handle_trace(TraceTap().parse_args(["nonexistent.bundle"]), logger)
    assert logger.lines


@pytest.fixture
def synthetic_bundle(tmp_path, monkeypatch):
    path = tmp_path / "dependency.bundle"
    path.write_bytes(b"synthetic bundle")
    sf = SimpleNamespace(name="CAB-local", externals=[SimpleNamespace(path="archive:/CAB-first"),
                                                     SimpleNamespace(path="archive:/CAB-second")])
    obj = SimpleNamespace(assets_file=sf, path_id=1, type=SimpleNamespace(name="AssetBundle"),
                          peek_name=lambda: "Synthetic", read_typetree=lambda: {
                              "local": {"m_FileID": 0, "m_PathID": 1},
                              "external": {"m_FileID": 2, "m_PathID": 2},
                              "null": {"m_FileID": 0, "m_PathID": 0}})
    bundle = SimpleNamespace(path=path, env=SimpleNamespace(assets=[sf], objects=[obj], container={}),
                             platform_info=("StandaloneWindows64", "2022.3.55f1"))
    monkeypatch.setattr(Bundle, "load", lambda *args: bundle)
    return bundle


@pytest.mark.parametrize("parser, handler", [(InspectTap, handle_inspect), (TraceTap, handle_trace)])
def test_local_only_never_detects_scans_or_opens_cache(synthetic_bundle, tmp_path, monkeypatch, parser, handler):
    def forbidden(*args, **kwargs):
        pytest.fail("Local-only mode must not detect resources, search directories or access a cache")

    monkeypatch.setattr(handlers, "get_BA_path", forbidden)
    monkeypatch.setattr(introspect, "_resolve_game_dirs", forbidden)
    monkeypatch.setattr(introspect, "managed_cab_index", forbidden)
    logger = LogCapture()
    handler(parser().parse_args([str(synthetic_bundle.path), "--local-only", "--resource-dir", str(tmp_path),
                                 "--cab-cache", str(tmp_path / "unused.json")]), logger)
    assert "Self CAB: CAB-local" in logger.lines
    assert "Local-only mode: cross-bundle resolution disabled." in logger.lines
    if parser is TraceTap:
        assert "  -> CAB-local:1 = AssetBundle 'Synthetic' (same file)" in logger.lines
        assert "  -> CAB-second:2 (unresolved (local-only))" in logger.lines
        assert "\nDone: 1 resolved, 1 unresolved." in logger.lines
    else:
        assert "  - CAB-second [unresolved (local-only)]" in logger.lines
    assert not (tmp_path / "unused.json").exists()


@pytest.mark.parametrize("parser, handler, operation", [
    (InspectTap, handle_inspect, "inspect_bundles"), (TraceTap, handle_trace, "trace_bundle")])
def test_cache_flags_reach_introspection(synthetic_bundle, tmp_path, monkeypatch, parser, handler, operation):
    calls = []
    monkeypatch.setattr(handlers, operation, lambda *args, **kwargs: calls.append(kwargs))
    selected = tmp_path / "namespace.json"
    handler(parser().parse_args([str(synthetic_bundle.path), "--resource-dir", str(tmp_path),
                                 "--cab-cache", str(selected), "--no-cache"]), LogCapture())
    assert calls[0]["cache_path"] == selected
    assert calls[0]["use_cache"] is False
    assert calls[0]["local_only"] is False
