"""Ownership assignment does not grant permission to install incompatible uploads."""

from types import SimpleNamespace

import pytest

from ba_modding_toolkit.catalog import Catalog
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import integrity, manual_identity

from test_batch_import import env, analyze, finish, rpc, run
from test_library import game_bundle, make_mod, setup_library, reload_library


def complete_contents(platform="Android"):
    return integrity.Contents(platforms={platform}, versions={"2021.3"},
        skeletons={"future_home.skel": b"skeleton"}, atlases={"future_home.atlas": b"future.png\nsize: 8,8\n"},
        textures={"future": (8, 8)})


def test_assignment_catalog_has_unreleased_students_without_local_assets():
    catalog = Catalog(None, None)
    families = catalog.assignment_families()
    assert families and not catalog.families()
    variants = [variant for family in families for variant in family.variants]
    assert len(variants) > 100
    assert all(variant.spr is None and variant.lobby is None and variant.model is None for variant in variants)
    assert catalog.assignment_variant(variants[-1].key.upper()).key == variants[-1].key
    with pytest.raises(ServiceError, match="catalog_variant_not_found"):
        catalog.variant(variants[-1].key)
    families[0].variants.clear()
    assert catalog.assignment_families()[0].variants


@pytest.mark.parametrize("problem,code", [("missing", "mod_parts_missing"),
    ("platform", "platform_unsupported"), ("mixed", "mod_platform_mismatch"), ("kind", "mod_target_ambiguous")])
def test_assignment_validation_keeps_integrity_and_platform_checks(tmp_path, monkeypatch, problem, code):
    paths = [tmp_path / "one.bundle", tmp_path / "two.bundle"]
    for path in paths:
        path.write_bytes(b"input")
    contents = {path: complete_contents() for path in paths}
    if problem == "missing":
        for value in contents.values():
            value.textures.clear()
    elif problem == "platform":
        contents[paths[0]].platforms = {"PS5"}
    elif problem == "mixed":
        contents[paths[1]].platforms = {"StandaloneWindows64"}
    monkeypatch.setattr(integrity.Inspection, "inspect", lambda self, path, **kwargs: contents[path])
    monkeypatch.setattr(manual_identity, "content_cores", lambda path: {"future_home", "other_spr"}
                        if problem == "kind" else {"future_home"})
    with pytest.raises(ServiceError, match=code):
        manual_identity.validate({path.name: path for path in paths})


def test_preview_and_apply_options_are_independent_and_migrate_saved_optout(env):
    env.services.state.set("batch_import", {"enableAfterImport": False})
    options = rpc(env, "import.options")
    assert options["enableAfterImport"] is False and options["previewAfterImport"] is False
    source = make_mod(env.original, env.tmp / "incoming")
    entry, = analyze(env, [source])["entries"]
    result, = run(env, [entry], enableAfterImport=False, previewAfterImport=True)
    assert result["outcome"] == "imported" and result["previewSelected"]
    pin = env.library.current_pin()
    assert env.services.state.preview_sources(pin.key, "test")["spr"] == f"mod:{result['libraryId']}"
    assert not result["configured"] and not result["applied"]
    assert env.original.read_bytes() != source.read_bytes()


def test_unreleased_assignment_stores_self_contained_mod_and_never_applies(env, monkeypatch):
    source = game_bundle(env.tmp / "incoming", "future_home", payload=b"future lobby")
    catalog = Catalog(None, None)
    chosen = catalog.assignment_families()[0].variants[0]
    monkeypatch.setattr(env.catalog, "assignment_variant", catalog.assignment_variant, raising=False)
    monkeypatch.setattr(integrity.Inspection, "inspect", lambda self, path, **kwargs: complete_contents())
    monkeypatch.setattr(manual_identity, "content_cores", lambda path: {"future_home"})
    original = env.original.read_bytes()
    entry, = analyze(env, [source])["entries"]
    assert entry["state"] == "blocked"
    assigned = finish(env, rpc(env, "import.assignCharacter", id=entry["id"], variant=chosen.key))
    assert assigned["variant"] == chosen.key and assigned["libraryOnly"] and assigned["state"] == "ready"
    assert env.services.batch_import.preview(assigned["preview"]["key"])[1] == [source]
    result, = run(env, [assigned], enableAfterImport=True, previewAfterImport=True)
    assert result["outcome"] == "imported", result
    assert result["applyUnavailable"] == "no_target" and not result["configured"] and not result["applied"]
    assert env.original.read_bytes() == original
    mod, = reload_library(env).mods()
    assert mod.target == chosen.key and mod.kind == "lobby"
    assert env.library.preview_bundles(mod.id) == [env.root / "mods" / mod.id / source.name]
    env.services._game = SimpleNamespace(spine_files_from=lambda paths: {"future_home.skel": b"skeleton"})
    assert env.services._spine_file("mod", mod.id, "skeleton.skel").body == b"skeleton"
    from ba_modding_toolkit.webui.batch_import import BatchImport
    restarted = BatchImport(env.services)
    entry, = finish(env, restarted.analyze([str(source)]))["entries"]
    assert entry["state"] == "library" and entry["variant"] == chosen.key


def test_failed_import_never_selects_preview(env, monkeypatch):
    source = make_mod(env.original, env.tmp / "incoming")
    entry, = analyze(env, [source])["entries"]
    def fail(*args, **kwargs):
        raise ServiceError("library_io_error")
    monkeypatch.setattr(env.library, "add_files", fail)
    result, = run(env, [entry], enableAfterImport=False, previewAfterImport=True)
    assert result["outcome"] == "failed"
    assert env.services.state.preview_sources(env.library.current_pin().key, "test") == {}


def test_unknown_platform_can_be_stored_without_claiming_compatibility(tmp_path, monkeypatch):
    source = tmp_path / "future.bundle"
    source.write_bytes(b"input")
    monkeypatch.setattr(integrity.Inspection, "inspect", lambda self, path, **kwargs: complete_contents("UnknownPlatform"))
    monkeypatch.setattr(manual_identity, "content_cores", lambda path: {"future_home"})
    assert manual_identity.validate({source.name: source}) == "lobby"


def test_saved_assignments_add_only_their_students_without_inventing_game_handles():
    from ba_modding_toolkit.webui.assigned_catalog import families_with_assignments, stored_asset_fields
    catalog = Catalog(None, None)
    chosen = catalog.assignment_families()[0].variants[0]
    families = families_with_assignments(catalog, [chosen.key])
    assert [variant.key for family in families for variant in family.variants] == [chosen.key]
    fields = stored_asset_fields(chosen, [SimpleNamespace(target=chosen.key, kind="lobby")])
    assert fields == {"storedKinds": ["lobby"], "localKinds": []}
    assert chosen.lobby is None and chosen.spr is None
