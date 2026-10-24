"""Saved character ownership reaches API views without creating local game targets."""

from types import SimpleNamespace

import pytest

from ba_modding_toolkit.errors import ServiceError

from test_webui import app, services, rpc, FakeFamily, FakeMod, FakeVariant


@pytest.fixture
def assigned(services, monkeypatch):
    future = FakeVariant("hoshino_future", "hoshino", "hoshino_future",
        names={"en": {"full": "Hoshino (Future)", "short": "Future"}}, recruitable=False, bg=None)
    future.page_id, future.schale_id = "12345", None
    unused = FakeVariant("unassigned", "unassigned", "unassigned", recruitable=False, bg=None)
    local = services.catalog.v
    families = [FakeFamily("hoshino", services.catalog.f.names, "Abydos", [local, future]),
                FakeFamily("unassigned", {"en": "Unassigned"}, None, [unused])]
    variants = {variant.key: variant for family in families for variant in family.variants}
    def assignment_variant(key):
        if key not in variants:
            raise ServiceError("catalog_variant_not_found", key=key)
        return variants[key]
    monkeypatch.setattr(services.catalog, "assignment_families", lambda: families, raising=False)
    monkeypatch.setattr(services.catalog, "assignment_variant", assignment_variant, raising=False)
    targets = {future.key}
    mods = [FakeMod("own-spr", future.key), FakeMod("own-lobby", future.key, kind="lobby"),
            FakeMod("own-model", future.key, kind="model"), FakeMod("sibling", local.key)]
    monkeypatch.setattr(services.library, "assigned_targets", lambda: set(targets))
    monkeypatch.setattr(services.library, "mods", lambda: list(mods))
    services.library.pins = [SimpleNamespace(key="current")]
    calls = []
    def snapshot(keys):
        calls.append(list(keys))
        return {"install": "current", "mods": list(mods), "favorites": set(), "modified": {},
                "assigned": sorted(targets), "configured": {key: {"spr": None, "lobby": None, "model": None}
                                                            for key in [*keys, *targets]}}
    monkeypatch.setattr(services.library, "roster_snapshot", snapshot)
    return SimpleNamespace(future=future, unused=unused, local=local, targets=targets, mods=mods, calls=calls)


def test_roster_and_family_include_saved_assignment_with_no_local_handles(app, services, assigned):
    roster = rpc(app, "roster.list")
    assert "error" not in roster, roster
    variants = [variant for family in roster["result"]["families"] for variant in family["variants"]]
    assert {variant["key"] for variant in variants} == {assigned.local.key, assigned.future.key}
    family = rpc(app, "family.get", key=assigned.future.family)
    assert "error" not in family, family
    for source in (variants, family["result"]["variants"]):
        future = next(variant for variant in source if variant["key"] == assigned.future.key)
        assert all(future[kind] is None for kind in ("spr", "lobby", "model"))
        assert future["localKinds"] == []
        assert future["storedKinds"] == ["lobby", "model", "spr"]
        assert future["mods"] == 3 and not future["recruitable"]
        assert not any(future["configured"].values())
    assigned.targets.clear()
    assigned.mods[:] = [mod for mod in assigned.mods if mod.target != assigned.future.key]
    remaining = rpc(app, "roster.list")["result"]
    assert [variant["key"] for family in remaining["families"] for variant in family["variants"]] == [assigned.local.key]
    assert rpc(app, "family.get", key=assigned.unused.family)["error"]["code"] == "family_not_found"


def test_assigned_roster_keeps_one_snapshot_and_filters_saved_preview_choices(app, services, assigned, monkeypatch):
    services.state.set_preview_source("current", assigned.future.key, "spr", "mod:own-spr")
    services.state.set_preview_source("current", assigned.future.key, "lobby", "official")
    services.state.set_preview_source("current", assigned.future.key, "model", "mod:own-spr")
    def forbidden(*args, **kwargs):
        pytest.fail("Assigned roster must reuse its single library snapshot")
    for name in ("mods", "assigned_targets", "current_pin", "configured", "selection", "modified", "favorites"):
        monkeypatch.setattr(services.library, name, forbidden)
    monkeypatch.setattr(services.state, "preview_sources", forbidden)
    result = rpc(app, "roster.list")
    assert "error" not in result, result
    future = next(variant for family in result["result"]["families"] for variant in family["variants"]
                  if variant["key"] == assigned.future.key)
    assert assigned.calls == [[assigned.local.key]]
    assert future["previewSources"] == {"spr": "mod:own-spr"}


@pytest.mark.parametrize("kind", ["spr", "lobby", "model"])
def test_own_mod_preview_is_saved_without_an_install_target(app, services, assigned, kind):
    result = rpc(app, "ui.preview", variant=assigned.future.key, kind=kind, source=f"mod:own-{kind}")
    assert result == {"result": {kind: f"mod:own-{kind}"}}
    assert services.state.preview_sources("current", assigned.future.key) == {kind: f"mod:own-{kind}"}
    assert services.library.applied == []


@pytest.mark.parametrize("kind,source", [("spr", "official"), ("lobby", "official"), ("model", "official"),
    ("spr", "variant:hoshino"), ("spr", "mod:sibling"), ("spr", "mod:own-lobby"), ("spr", "mod:missing")])
def test_absent_target_rejects_official_cross_variant_and_wrong_kind_previews(app, services, assigned, kind, source):
    result = rpc(app, "ui.preview", variant=assigned.future.key, kind=kind, source=source)
    assert result["error"]["code"] == "bad_params"
    assert services.state.preview_sources("current", assigned.future.key) == {}
    assert services.library.applied == []


def test_assignment_metadata_supports_aliases_and_memorial_dialogue(app, services, assigned, monkeypatch):
    assert rpc(app, "aliases.set", variant=assigned.future.key, aliases=["Future nickname"])["result"] == ["Future nickname"]
    future = next(variant for variant in rpc(app, "family.get", key="hoshino")["result"]["variants"]
                  if variant["key"] == assigned.future.key)
    assert future["custom"] == ["Future nickname"]
    pages = []
    def lines(page):
        pages.append(page)
        return {"future_memoriallobby_1": {"ja": "Future dialogue", "zh-CN": "Dialogue", "audio": ""}}
    monkeypatch.setattr(services.kivo, "lines", lines)
    result = rpc(app, "lobby.lines", variant=assigned.future.key, lang="zh-CN")
    assert "error" not in result, result
    assert result["result"]["future_memoriallobby_1"]["ja"] == "Future dialogue"
    assert pages == [assigned.future.page_id]
    assert rpc(app, "aliases.set", variant=assigned.unused.key, aliases=["Unowned"])["error"]["code"] == "catalog_variant_not_found"
    assert rpc(app, "lobby.lines", variant=assigned.unused.key, lang="zh-CN")["error"]["code"] == "catalog_variant_not_found"
