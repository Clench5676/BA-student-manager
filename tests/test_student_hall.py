"""Student Hall keeps independent entries and rejects lost updates without altering other settings."""
from copy import deepcopy
from uuid import uuid4

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui.state import UiState
from ba_modding_toolkit.webui.student_hall import empty_hall, normalize_hall, portrait_lines, save_hall, validate_hall


def entry(**extra):
    return {"id": str(uuid4()), "variant": "hoshino", "source": "mod:example", **extra}


def test_same_character_different_resources_keep_independent_positions(tmp_path):
    state = UiState(tmp_path / "ui.json")
    value = empty_hall()
    value["portraits"] = [entry(source="mod:first", x=400), entry(source="mod:second", x=1200)]
    value["memorials"] = [entry(source="mod:first"), entry(source="mod:second")]
    value["active"] = value["memorials"][1]["id"]
    saved = save_hall(state, value, 0)
    assert saved["portraits"][0]["x"] == 400
    assert saved["portraits"][1]["x"] == 1200
    assert len(saved["memorials"]) == 2
    assert saved["active"] == value["active"]
    assert UiState(state.path).get("student_hall") == saved


def test_more_than_game_slot_count_is_preserved():
    value = empty_hall()
    value["portraits"] = [entry(source=f"mod:source-{i}") for i in range(100)]
    value["memorials"] = [entry(source=f"mod:source-{i}") for i in range(100)]
    assert len(validate_hall(value)["portraits"]) == 100
    assert len(validate_hall(value)["memorials"]) == 100


def test_removing_active_uses_remaining_order():
    value = empty_hall()
    value["memorials"] = [entry(source="mod:first"), entry(source="mod:second")]
    value["active"] = str(uuid4())
    assert validate_hall(value)["active"] == value["memorials"][0]["id"]
    value["memorials"].clear()
    assert validate_hall(value)["active"] is None


@pytest.mark.parametrize("patch", [{"x": float("nan")}, {"scale": 0}, {"y": True}, {"source": "../outside"}, {"id": "bad"}])
def test_invalid_entry_is_rejected_without_silent_data_loss(patch):
    value = empty_hall()
    value["portraits"] = [entry(**patch)]
    with pytest.raises(ServiceError):
        validate_hall(value)


def test_duplicate_uuid_is_rejected_across_modes():
    value = empty_hall()
    value["portraits"] = [entry()]
    value["memorials"] = deepcopy(value["portraits"])
    with pytest.raises(ServiceError):
        validate_hall(value)


def test_cas_retains_other_settings_and_prevents_lost_updates(tmp_path):
    first = UiState(tmp_path / "ui.json")
    second = UiState(first.path)
    first.set("voice_volume", 35)
    save_hall(first, empty_hall(), 0)
    with pytest.raises(ServiceError, match="hall_conflict"):
        save_hall(second, empty_hall(), 0)
    assert second.get("voice_volume") == 35
    assert second.get("student_hall")["revision"] == 1


def test_failed_publication_preserves_complete_previous_snapshot(tmp_path, monkeypatch):
    state = UiState(tmp_path / "ui.json")
    previous = save_hall(state, empty_hall(), 0)
    value = deepcopy(previous)
    value["portraits"] = [entry()]
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr("ba_modding_toolkit.webui.state._replace", fail)
    with pytest.raises(OSError):
        save_hall(state, value, 1)
    assert UiState(state.path).get("student_hall") == previous


def test_portrait_dialogue_excludes_memorial_and_unsafe_voice_is_not_implicitly_trusted():
    rows = portrait_lines({"voice": [
        {"description": "Hoshino_Lobby_1.ogg", "text": "Lobby", "text_original": "Original", "file": "//static.kivo.wiki/test.ogg"},
        {"description": "Hoshino_MemorialLobby_1.ogg", "text": "Memorial"},
        {"description": "Hoshino_Lobby_2.ogg", "file": "https://evil.invalid/test.ogg"},
    ]})
    assert set(rows) == {"hoshino_lobby_1", "hoshino_lobby_2"}
    assert rows["hoshino_lobby_1"]["audio"] == "https://static.kivo.wiki/test.ogg"
    assert rows["hoshino_lobby_1"]["ja"] == "Original"


def test_portrait_composition_and_cancellation_in_node():
    import shutil
    import subprocess
    from pathlib import Path
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is not installed")
    result = subprocess.run([node, "--test", str(Path(__file__).parent / "js" / "student_hall.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_scene.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_icons.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_memorial.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_fullscreen.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_sources.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_navigation.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_backgrounds.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_model.test.mjs"),
                             str(Path(__file__).parent / "js" / "student_hall_ui.test.mjs")],
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr


def test_library_only_cross_server_entries_are_available_without_local_core(tmp_path):
    from types import SimpleNamespace
    from ba_modding_toolkit.webui.rpc import RpcRegistry
    from ba_modding_toolkit.webui.student_hall import register_api
    variant = SimpleNamespace(key="unreleased", names={"en": {"full": "Unreleased"}}, spr=None, lobby=None, portrait=None)
    mod = SimpleNamespace(id="future-mod", target="unreleased", kind="lobby", alias="", label="Future lobby")
    service = SimpleNamespace(game_found=lambda: True, state=UiState(tmp_path / "ui.json"),
                              catalog=SimpleNamespace(families=lambda: []),
                              library=SimpleNamespace(mods=lambda: [mod], variant_metadata=lambda key: variant),
                              game=SimpleNamespace(collection_names=lambda: {"bg": ["BG_School_Collection"]}))
    registry = RpcRegistry()
    register_api(registry, service)
    result = registry.call("hall.options", {})["result"]
    choice, = result["choices"]
    assert {key: choice[key] for key in ("variant", "source", "kind", "core", "names", "label", "portrait")} == {
        "variant": "unreleased", "source": "mod:future-mod", "kind": "lobby", "core": None,
        "names": variant.names, "label": "Future lobby", "portrait": None}
    assert choice["localKinds"] == [] and choice["released"] is False
    assert choice["modCounts"] == {"lobby": 1} and choice["mods"] == 1


def test_global_portrait_scale_defaults_read_and_persistence_leave_entries_unchanged(tmp_path):
    from ba_modding_toolkit.webui.student_hall import normalize_hall
    state = UiState(tmp_path / "ui.json")
    legacy = empty_hall()
    legacy.pop("portraitScale")
    legacy["portraits"] = [entry(x=500, y=950, scale=.6)]
    assert normalize_hall(legacy)["portraitScale"] == 1
    assert "portraitScale" not in legacy
    previous = save_hall(state, legacy, 0)
    changed = deepcopy(previous)
    changed["portraitScale"] = .73
    saved = save_hall(state, changed, previous["revision"])
    assert saved["portraitScale"] == .73
    assert saved["portraits"] == previous["portraits"]
    assert saved["background"] == previous["background"]
    assert UiState(state.path).get("student_hall")["portraitScale"] == .73
    for size in (.25, 1, 1.5):
        changed["portraitScale"] = size
        assert validate_hall(changed)["portraitScale"] == size


@pytest.mark.parametrize("scale", [0, .249, 1.501, float("nan"), float("inf"), True, "75", None])
def test_invalid_global_portrait_scale_cannot_replace_saved_layout(tmp_path, scale):
    state = UiState(tmp_path / "ui.json")
    previous = save_hall(state, empty_hall(), 0)
    bad = deepcopy(previous)
    bad["portraitScale"] = scale
    with pytest.raises(ServiceError):
        save_hall(state, bad, previous["revision"])
    assert UiState(state.path).get("student_hall") == previous


@pytest.mark.parametrize("mirror", [0, 1, "true", None, []])
def test_portrait_mirror_requires_a_boolean(mirror):
    value = empty_hall()
    value["portraits"] = [entry(mirror=mirror)]
    with pytest.raises(ServiceError):
        validate_hall(value)


def test_portrait_mirror_and_layer_order_round_trip(tmp_path):
    state = UiState(tmp_path / "ui.json")
    value = empty_hall()
    value["portraits"] = [entry(source="mod:front", mirror=True), entry(source="mod:back")]
    saved = save_hall(state, value, 0)
    assert [row["source"] for row in saved["portraits"]] == ["mod:front", "mod:back"]
    assert [row["mirror"] for row in saved["portraits"]] == [True, False]
    assert UiState(state.path).get("student_hall")["portraits"] == saved["portraits"]


def test_duplicate_memorial_resource_is_rejected_without_replacing_saved_state(tmp_path):
    state = UiState(tmp_path / "ui.json")
    value = empty_hall()
    value["memorials"] = [entry(source="official"), entry(source="mod:alternate")]
    saved = save_hall(state, value, 0)
    duplicated = deepcopy(saved)
    duplicated["memorials"].append(entry(source="official"))
    with pytest.raises(ServiceError, match="hall_duplicate_memorial"):
        save_hall(state, duplicated, saved["revision"])
    assert UiState(state.path).get("student_hall") == saved


def test_legacy_memorial_normalization_retains_first_order_and_active_uuid_without_writing(tmp_path):
    state = UiState(tmp_path / "ui.json")
    value = empty_hall()
    value["revision"] = 12
    value["portraits"] = [entry(source="official")]
    first, other, active = entry(source="official"), entry(source="mod:other"), entry(source="official")
    value["memorials"] = [first, other, active]
    value["active"] = active["id"]
    state.set("student_hall", value)
    before = state.path.read_bytes()
    normalized = normalize_hall(state.get("student_hall"))
    assert [item["source"] for item in normalized["memorials"]] == ["official", "mod:other"]
    assert normalized["memorials"][0]["id"] == normalized["active"] == active["id"]
    assert normalized["revision"] == 12
    ids = [item["id"] for group in ("portraits", "memorials") for item in normalized[group]]
    assert len(ids) == len(set(ids))
    validate_hall(normalized)
    assert state.path.read_bytes() == before
    assert value["memorials"][0]["id"] == first["id"]
    collision = deepcopy(normalized)
    collision["portraits"][0]["id"] = active["id"]
    with pytest.raises(ServiceError):
        validate_hall(collision)
