"""Introspection distinguishes local PPtrs from external SerializedFile references."""

from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest

from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.core.introspect import _collect_externals, _make_graph, _self_cabs
from ba_modding_toolkit.references import iter_pptrs, reference
from ba_modding_toolkit.utils import no_log

if TYPE_CHECKING:
    from conftest import RessRegressCase, SampleCase


def _load(path: Path) -> Bundle:
    bundle = Bundle.load(path)
    if bundle is None:
        pytest.skip("Bundle cannot load")
    return bundle


def _first_obj(bundle: Bundle, type_name: str):
    return next((o for o in bundle.env.objects if o.type.name == type_name), None)


class TestSelfCabs:
    def test_matches_env_assets(self, sample_case: "SampleCase") -> None:
        """Include every named SerializedFile in source order."""
        bundle = _load(sample_case.bundle_paths[0])
        expected = [n for n in (getattr(sf, "name", "") for sf in bundle.env.assets) if n]
        if not expected:
            pytest.skip("Bundle has no named SerializedFiles")
        assert _self_cabs(bundle) == expected


class TestCollectExternals:
    def test_lists_all_externals(self, ress_regress_case: "RessRegressCase") -> None:
        """Normalize external paths to file names across all SerializedFiles."""
        bundle = _load(ress_regress_case.original_path)
        expected = [
            ext.path.replace("\\", "/").rsplit("/", 1)[-1]
            for sf in bundle.env.assets
            for ext in sf.externals
        ]
        if not expected:
            pytest.skip("Bundle has no external references")
        result = _collect_externals(bundle)
        assert result == set(expected)
        assert all(cab and "/" not in cab for cab in result)


class TestGraphResolution:
    def test_same_file_refs_resolve_in_bundle(self, sample_case: "SampleCase") -> None:
        """Only non-null m_FileID == 0 references must resolve inside their own file."""
        bundle = _load(sample_case.bundle_paths[0])
        target = _first_obj(bundle, "AssetBundle")
        if target is None:
            pytest.skip("Bundle has no AssetBundle object")

        graph = _make_graph([bundle], [], no_log, None)
        refs = [p for p in iter_pptrs(graph.tree(target)) if p.get("m_PathID") and p["m_FileID"] == 0]
        if not refs:
            pytest.skip("AssetBundle object has no non-null local references")

        for ptr in refs:
            resolved = graph.deref(target, ptr)
            assert resolved is not None, f"Unresolved local pointer: {ptr}"
            assert resolved.assets_file is target.assets_file

    def test_external_refs_remain_unresolved_without_their_bundle(self, sample_case: "SampleCase") -> None:
        """External references need not resolve in local-only mode."""
        bundle = _load(sample_case.bundle_paths[0])
        graph = _make_graph([bundle], [], no_log, None)
        self_cabs = {cab.lower() for cab in _self_cabs(bundle)}
        refs = []
        for obj in bundle.env.objects:
            try:
                tree = graph.tree(obj)
            except Exception:
                continue
            refs.extend((obj, ptr) for ptr in iter_pptrs(tree)
                        if ptr.get("m_PathID") and ptr["m_FileID"] != 0)
        absent = [(obj, ptr) for obj, ptr in refs if reference(obj, ptr)[0].lower() not in self_cabs]
        if not absent:
            pytest.skip("Bundle has no non-null references to absent SerializedFiles")
        for obj, ptr in absent:
            expected = obj.assets_file.externals[ptr["m_FileID"] - 1].path.replace("\\", "/").rsplit("/", 1)[-1]
            assert reference(obj, ptr) == (expected, ptr["m_PathID"])
            assert graph.deref(obj, ptr) is None

    def test_local_and_file_id_two_references_are_distinct(self, tmp_path, monkeypatch):
        """A deterministic fixture reproduces a dependency bundle with m_FileID=2."""
        local = SimpleNamespace(name="CAB-local", externals=[
            SimpleNamespace(path="archive:/CAB-first"), SimpleNamespace(path="archive:/CAB-second")])
        local_ptr = {"m_FileID": 0, "m_PathID": 2}
        external_ptr = {"m_FileID": 2, "m_PathID": 2}
        source = SimpleNamespace(assets_file=local, path_id=1,
                                 read_typetree=lambda: {"local": local_ptr, "external": external_ptr})
        target = SimpleNamespace(assets_file=local, path_id=2)
        bundle = SimpleNamespace(path=tmp_path / "dependency.bundle",
                                 env=SimpleNamespace(assets=[local], objects=[source, target]))
        monkeypatch.setattr(Bundle, "load", lambda path, log: bundle)
        graph = _make_graph([bundle], [], no_log, None)
        assert list(iter_pptrs(graph.tree(source))) == [local_ptr, external_ptr]
        assert graph.deref(source, local_ptr) is target
        assert reference(source, external_ptr) == ("CAB-second", 2)
        assert graph.deref(source, external_ptr) is None
        assert graph.index == {} and graph.fallback is None

    def test_external_file_id_can_resolve_to_another_file_in_the_same_bundle(self, tmp_path, monkeypatch):
        """m_FileID describes the SerializedFile table, not necessarily another bundle."""
        local = SimpleNamespace(name="CAB-local", externals=[SimpleNamespace(path="CAB-second")])
        second = SimpleNamespace(name="CAB-second", externals=[])
        source = SimpleNamespace(assets_file=local, path_id=1)
        target = SimpleNamespace(assets_file=second, path_id=2)
        bundle = SimpleNamespace(path=tmp_path / "multi.bundle",
                                 env=SimpleNamespace(assets=[local, second], objects=[source, target]))
        monkeypatch.setattr(Bundle, "load", lambda path, log: bundle)
        graph = _make_graph([bundle], [], no_log, None)
        assert graph.deref(source, {"m_FileID": 1, "m_PathID": 2}) is target
