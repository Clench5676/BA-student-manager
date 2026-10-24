"""Ordinary lobby speech uses bounded, single-flight memory data and actual game dialogue metadata."""

import base64
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import globallines
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui import student_hall
from ba_modding_toolkit.webui.student_hall import MemoryMemo, PortraitVoices, LocalPortraitVoices

from test_webui import app, services, rpc
from test_globallines import row


def test_voice_and_line_singleflight_and_memory_limits(monkeypatch):
    voices = PortraitVoices()
    entered, release = threading.Event(), threading.Event()
    calls = []
    def read(url):
        calls.append(url)
        entered.set()
        assert release.wait(5)
        if url.endswith("/123"):
            return json.dumps({"voice": [{"description": "Hoshino_Lobby_1.ogg", "text_original": "Text",
                "file": "https://static.kivo.wiki/voice.ogg"}]}).encode()
        return b"OggS untouched audio"
    monkeypatch.setattr(voices, "_get", read)
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(voices.lines, "123") for _ in range(8)]
        assert entered.wait(5); release.set()
        assert all(future.result()["hoshino_lobby_1"]["ja"] == "Text" for future in futures)
        futures = [pool.submit(voices.audio, "123", "hoshino_lobby_1") for _ in range(8)]
        assert all(future.result() == b"OggS untouched audio" for future in futures)
    assert len(calls) == 2
    cache = MemoryMemo(10, 2)
    for key in range(4):
        cache.get(key, lambda: b"1234")
    assert cache.bytes == 8 and len(cache._values) == 2
    cache.get("oversize", lambda: b"x" * 11)
    assert cache.bytes == 8 and "oversize" not in cache._values


def test_failed_voice_is_not_requested_again_during_backoff(monkeypatch):
    cache = MemoryMemo(1024, 4)
    count = 0
    def fail():
        nonlocal count
        count += 1
        raise ServiceError("lines_unavailable")
    for _ in range(3):
        with pytest.raises(ServiceError, match="lines_unavailable"):
            cache.get("voice", fail)
    assert count == 1 and cache.bytes == 0
    assert isinstance(cache._failed["voice"][1], dict), "Failure cache retains no decoder traceback or asset buffers"


def test_global_ordinary_translation_reuses_memorial_table_download(monkeypatch):
    table = {"DataList": [
        row(10005, 1, 1, "Memorial", anim="Talk_01_M"),
        row(10005, 1, 2, "Ordinary", "Traditional Chinese", category="UILobby", jp="Original", anim="02"),
        {**row(10005, 2, 3, "Birthday", category="UILobby"), "DialogCondition": "Birthday"},
    ]}
    source = globallines.GlobalLines()
    calls = []
    monkeypatch.setattr(source, "_get", lambda *args: (calls.append(args), json.dumps(table).encode())[1])
    assert source.dialogues(10005)["Talk_01_M"][0]["en"] == "Memorial"
    assert source.portrait_dialogues(10005) == {1: [{"en": "Ordinary", "zh-TW": "Traditional Chinese", "ja": "Original", "expression": "02"}]}
    assert len(calls) == 1
    authored = globallines.portrait_dialogues([row(10005, 1, 2, "First\nSecond", category="UILobby")])
    assert authored[10005][1][0]["en"] == "First\nSecond"


def test_local_audio_lookup_is_scoped_and_decodes_original_samples_in_memory(tmp_path, monkeypatch):
    source = tmp_path / "audio-voice.bundle"
    ignored = tmp_path / "unrelated-textures.bundle"
    source.write_bytes(b"bundle fixture"); ignored.write_bytes(b"unrelated fixture")
    reads = []
    class Audio:
        type = SimpleNamespace(name="AudioClip")
        path_id = 10
        assets_file = SimpleNamespace(name="cab-voice")
        def peek_name(self):
            return "Hoshino_Lobby_1"
        def read(self):
            return SimpleNamespace(samples={"clip.wav": b"RIFF original PCM"})
    @contextmanager
    def bundle(path):
        reads.append(path)
        assert path == source
        yield SimpleNamespace(objects=[Audio()])
    monkeypatch.setattr(student_hall, "open_bundle", bundle)
    local = LocalPortraitVoices(SimpleNamespace(game=SimpleNamespace(_paths=lambda: [source, ignored],
        _bundle_path=lambda name: tmp_path / name)))
    assert list(local.index()) == ["hoshino_lobby_1"]
    assert local.audio("hoshino_lobby_1") == b"RIFF original PCM"
    assert local.audio("hoshino_lobby_1") == b"RIFF original PCM"
    assert reads == [source, source]


@pytest.fixture
def dialogue_services(services, monkeypatch):
    variant = services.catalog.v
    variant.page_id, variant.schale_id = "123", 10005
    monkeypatch.setattr(services.library, "variant_metadata", lambda key: variant, raising=False)
    requests = []
    def fetch(self, url):
        requests.append(url)
        if url.endswith("/123"):
            return json.dumps({"voice": [{"description": "Hoshino_Lobby_1.ogg", "text_original": "Original text",
                "text": "Chinese text", "file": "https://static.kivo.wiki/ordinary.ogg"},
                {"description": "Hoshino_MemorialLobby_1.ogg", "text_original": "Wrong scene"}]}).encode()
        return b"OggS remote voice"
    monkeypatch.setattr(PortraitVoices, "_get", fetch)
    monkeypatch.setattr(services.global_lines, "portrait_dialogues", lambda character: {1: [{"en": "English text", "zh-TW": "TW text", "expression": "02"}]})
    return requests


def test_hall_lines_localize_the_same_ordinary_clip_and_do_not_download_voice(app, services, dialogue_services):
    result = rpc(app, "hall.lines", variant="hoshino", lang="zh-TW")
    assert "error" not in result, result
    lines = result["result"]["lines"]
    assert list(lines) == ["hoshino_lobby_1"]
    assert lines["hoshino_lobby_1"]["zh-TW"] == "TW text"
    assert lines["hoshino_lobby_1"]["ja"] == "Original text"
    assert lines["hoshino_lobby_1"]["voiceSource"] == "kivo"
    assert lines["hoshino_lobby_1"]["expression"] == "02"
    assert len(dialogue_services) == 1
    voice = rpc(app, "hall.voice", variant="hoshino", clip="hoshino_lobby_1")["result"]
    assert base64.b64decode(voice["audio"]) == b"OggS remote voice" and voice["mime"] == "audio/ogg"
    rpc(app, "hall.voice", variant="hoshino", clip="hoshino_lobby_1")
    assert len(dialogue_services) == 2


def test_warm_line_metadata_uses_published_caches_without_false_pending_jobs(app, services, dialogue_services, monkeypatch):
    services.global_lines._table = {}
    services.global_lines._portraits = {10005: {1: [{"en": "Cached official text"}]}}
    first = rpc(app, "hall.lines", variant="hoshino", lang="en")["result"]
    assert first["lines"]["hoshino_lobby_1"]["en"] == "Cached official text"
    # Complete the same selected source's transport cache; no other student is prefetched.
    rpc(app, "hall.voice", variant="hoshino", clip="hoshino_lobby_1")
    def forbidden(*args, **kwargs):
        pytest.fail("Published line metadata should not schedule another background job")
    monkeypatch.setattr("ba_modding_toolkit.webui.api._background", forbidden)
    result = rpc(app, "hall.lines", variant="hoshino", lang="en")["result"]
    assert result["pending"] is False and result["lines"]["hoshino_lobby_1"]["voice"]


def test_hall_prefers_available_local_voice_over_remote_audio(app, services, dialogue_services, monkeypatch):
    monkeypatch.setattr(LocalPortraitVoices, "index", lambda self: {"hoshino_lobby_1": {}})
    monkeypatch.setattr(LocalPortraitVoices, "audio", lambda self, clip: b"RIFF local original")
    lines = rpc(app, "hall.lines", variant="hoshino", lang="en")["result"]["lines"]
    assert lines["hoshino_lobby_1"]["voiceSource"] == "local"
    voice = rpc(app, "hall.voice", variant="hoshino", clip="hoshino_lobby_1")["result"]
    assert voice["mime"] == "audio/wav" and base64.b64decode(voice["audio"]) == b"RIFF local original"
    assert all(not url.endswith(".ogg") for url in dialogue_services)


def test_missing_audio_keeps_official_text_and_refuses_unrelated_clip(app, services, dialogue_services, monkeypatch):
    monkeypatch.setattr(PortraitVoices, "lines", lambda self, page: {})
    lines = rpc(app, "hall.lines", variant="hoshino", lang="en")["result"]["lines"]
    assert lines["hoshino_lobby_1"]["en"] == "English text"
    assert lines["hoshino_lobby_1"]["voice"] is False
    assert rpc(app, "hall.voice", variant="hoshino", clip="other_lobby_1")["error"]["code"] == "lines_unavailable"
    assert rpc(app, "hall.voice", variant="hoshino", clip="../../voice")["error"]["code"] == "bad_params"


def test_viewed_order_is_per_source_and_does_not_mutate_hall_or_game(app, services, dialogue_services, monkeypatch):
    services.catalog.v.lobby = "hoshino_home"
    mods = [SimpleNamespace(id="one", target="hoshino", kind="lobby"), SimpleNamespace(id="two", target="hoshino", kind="lobby")]
    monkeypatch.setattr(services.library, "mods", lambda: mods)
    initial = services.state.get("student_hall")
    rpc(app, "hall.viewed", variant="hoshino", source="mod:one")
    rpc(app, "hall.viewed", variant="hoshino", source="mod:two")
    result = rpc(app, "hall.viewed", variant="hoshino", source="mod:one")["result"]
    assert result == ["hoshino:mod:one", "hoshino:mod:two"]
    assert services.state.get("student_hall") == initial and services.library.applied == []
    assert rpc(app, "hall.viewed", variant="hoshino", source="mod:missing")["error"]["code"] == "bad_params"


def test_last_memorial_cannot_be_removed_after_first_saved_entry(tmp_path):
    from uuid import uuid4
    from ba_modding_toolkit.webui.state import UiState
    from ba_modding_toolkit.webui.student_hall import empty_hall, save_hall
    state = UiState(tmp_path / "ui.json")
    initial = save_hall(state, empty_hall(), 0)
    initial["memorials"] = [{"id": str(uuid4()), "variant": "hoshino", "source": "official"}]
    kept = save_hall(state, initial, 1)
    previous = state.path.read_bytes()
    empty = {**kept, "memorials": [], "active": None}
    with pytest.raises(ServiceError, match="hall_last_memorial"):
        save_hall(state, empty, 2)
    assert state.path.read_bytes() == previous
    assert state.get("student_hall") == kept


def test_exact_portrait_source_duplicates_are_rejected_but_other_resources_and_memorials_remain_valid(tmp_path):
    from uuid import uuid4
    from ba_modding_toolkit.webui.student_hall import empty_hall, validate_hall
    first = {"id": str(uuid4()), "variant": "hoshino", "source": "mod:one"}
    second = {**first, "id": str(uuid4())}
    value = {**empty_hall(), "portraits": [first, second]}
    with pytest.raises(ServiceError, match="hall_duplicate_portrait"):
        validate_hall(value)
    second["source"] = "mod:two"
    value["memorials"] = [{**first, "id": str(uuid4())}, {**first, "id": str(uuid4())}]
    with pytest.raises(ServiceError, match="hall_duplicate_memorial"):
        validate_hall(value)
    value["memorials"][1]["source"] = "mod:two"
    clean = validate_hall(value)
    assert len(clean["portraits"]) == 2 and len(clean["memorials"]) == 2


def test_native_portrait_anchor_only_fills_missing_coordinates():
    from uuid import uuid4
    from ba_modding_toolkit.webui.student_hall import empty_hall, validate_hall, PORTRAIT_ORIGIN
    fresh = {"id": str(uuid4()), "variant": "hoshino", "source": "mod:one"}
    placed = {"id": str(uuid4()), "variant": "hoshino", "source": "mod:two", "x": 960, "y": 1120, "scale": 1.7}
    result = validate_hall({**empty_hall(), "portraits": [fresh, placed]})["portraits"]
    assert (result[0]["x"], result[0]["y"]) == PORTRAIT_ORIGIN
    assert result[1] == {**placed, "mirror": False}


def test_legacy_duplicate_read_keeps_first_uuid_and_cas_revision_without_disk_migration(app, services):
    from uuid import uuid4
    from ba_modding_toolkit.webui.student_hall import empty_hall
    first = {"id": str(uuid4()), "variant": "hoshino", "source": "mod:one", "x": 400, "y": 1120, "scale": 1}
    duplicate = {**first, "id": str(uuid4()), "x": 1200}
    other = {**first, "id": str(uuid4()), "source": "mod:two", "x": 800}
    legacy = {**empty_hall(), "revision": 7, "portraits": [first, duplicate, other]}
    services.state.set("student_hall", legacy)
    before = services.state.path.read_bytes()
    snapshot = rpc(app, "hall.get")["result"]
    assert snapshot["revision"] == 7 and snapshot["portraits"] == [first, other]
    assert services.state.path.read_bytes() == before
    saved = rpc(app, "hall.update", value={**snapshot, "mode": "memorial"}, revision=7)["result"]
    assert saved["revision"] == 8 and saved["portraits"] == [{**entry, "mirror": False} for entry in (first, other)]
    assert services.state.get("student_hall") == saved


def test_slow_kivo_does_not_gate_ready_official_text_and_finishes_in_the_existing_flight(app, services, dialogue_services, monkeypatch):
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    original = PortraitVoices.lines
    def delayed(self, page):
        entered.set()
        assert release.wait(5)
        value = original(self, page)
        finished.set()
        return value
    monkeypatch.setattr(PortraitVoices, "lines", delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(rpc, app, "hall.lines", variant="hoshino", lang="en")
        assert entered.wait(2)
        try:
            result = pending.result(timeout=1)["result"]
            assert result["pending"] is True
            assert result["lines"]["hoshino_lobby_1"]["en"] == "English text"
            assert result["lines"]["hoshino_lobby_1"]["voice"] is False
        finally:
            release.set()
    assert finished.wait(2)
    next_result = rpc(app, "hall.lines", variant="hoshino", lang="en")["result"]
    assert next_result["lines"]["hoshino_lobby_1"]["voice"] is True
    assert len(dialogue_services) == 1


def test_portrait_rows_preserve_timed_expression_changes_on_their_original_voice():
    # Eimi UILobby Idle2: source table's 4750 ms 04 row continues with 05 and no second VoiceId.
    source = [
        {**row(10001, 2, 110, "First", anim="04", category="UILobby"), "VoiceId": [3463771783], "Duration": 4750},
        {**row(10001, 2, 120, "Second", anim="05", category="UILobby"), "VoiceId": [], "Duration": 8500},
        {**row(10001, 200, 200, "Birthday", anim="02", category="UILobby"), "Anniversary": "StudentBDay"},
    ]
    groups = globallines.portrait_dialogues(source)[10001]
    assert 200 not in groups
    lines = globallines.portrait_by_clip({str(key): value for key, value in groups.items()}, {"2": ["eimi_lobby_2"]})
    assert lines["eimi_lobby_2"]["en"] == "First Second"
    assert lines["eimi_lobby_2"]["expressionCues"] == [{"time": 0, "expression": "04"}, {"time": 4.75, "expression": "05"}]
    separate = {"3": [{"en": "One", "expression": "02", "voiceIds": [2788647851], "duration": 0},
                       {"en": "Two", "expression": "10", "voiceIds": [3452918145], "duration": 0}]}
    result = globallines.portrait_by_clip(separate, {"3": ["hoshino_lobby_3_1", "hoshino_lobby_3_2"]})
    assert result["hoshino_lobby_3_1"]["expression"] == "02"
    assert result["hoshino_lobby_3_2"]["expression"] == "10"


def test_portrait_rows_do_not_invent_cue_times_without_authored_duration():
    values = {"1": [{"en": "One", "expression": "02", "voiceIds": [1], "duration": 0},
                    {"en": "Two", "expression": "10", "voiceIds": [], "duration": 2}]}
    line = globallines.portrait_by_clip(values, {"1": ["student_lobby_1"]})["student_lobby_1"]
    assert line["en"] == "One Two"
    assert line["expressionCues"] == [{"time": 0, "expression": "02"}]


def test_chinese_dialogue_retains_kivo_caption_and_receives_official_expression_metadata(app, services, dialogue_services):
    result = rpc(app, "hall.lines", variant="hoshino", lang="zh-CN")["result"]
    line = result["lines"]["hoshino_lobby_1"]
    assert line["zh-CN"] == "Chinese text"
    assert line["expressionCues"] == [{"time": 0, "expression": "02"}]
    assert result["animationPending"] is False


def test_chinese_dialogue_marks_late_animation_metadata_without_blocking_ready_voice(app, services, dialogue_services, monkeypatch):
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()
    def delayed(character):
        entered.set()
        assert release.wait(5)
        services.global_lines._portraits = {10005: {1: [{"expression": "02"}]}}
        services.global_lines._table = {}
        completed.set()
        return services.global_lines._portraits[10005]
    monkeypatch.setattr(services.global_lines, "portrait_dialogues", delayed)
    first = rpc(app, "hall.lines", variant="hoshino", lang="zh-CN")["result"]
    assert entered.wait(1) and first["animationPending"] is True
    assert first["lines"]["hoshino_lobby_1"]["voice"] is True
    assert first["lines"]["hoshino_lobby_1"]["zh-CN"] == "Chinese text"
    release.set(); assert completed.wait(1)
    second = rpc(app, "hall.lines", variant="hoshino", lang="zh-CN")["result"]
    assert second["animationPending"] is False
    assert second["lines"]["hoshino_lobby_1"]["expression"] == "02"
    assert second["lines"]["hoshino_lobby_1"]["zh-CN"] == "Chinese text"


def test_missing_dialogue_catalog_mapping_is_normal_absence_but_unexpected_catalog_errors_remain_errors(app, services, monkeypatch):
    def missing(_):
        raise ServiceError("catalog_variant_not_found")
    monkeypatch.setattr(services.library, "variant_metadata", missing, raising=False)
    response = rpc(app, "hall.lines", variant="unmapped", lang="zh-CN")
    assert "error" not in response and response["result"]["unavailable"] is True
    def broken(_):
        raise ServiceError("catalog_data_invalid")
    monkeypatch.setattr(services.library, "variant_metadata", broken)
    assert rpc(app, "hall.lines", variant="unmapped")["error"]["code"] == "catalog_data_invalid"


def test_native_expression_motion_retains_authored_tracks_and_omits_random_idle_sync():
    clips = {"04": {"track": 1, "loop": True, "intro": 0, "outro": 0, "mode": 1, "sync": ["Eye_Close_01", "Speak"]},
             "Eye_Close_01": {"mode": 2},
             "Speak": {"track": 3, "loop": True, "intro": .1, "outro": .2, "mode": 1, "sync": ["04"]}}
    motion = student_hall.expression_motion("04", clips)
    assert motion["track"] == 1 and motion["animation"] == "04"
    assert motion["sync"] == [{"animation": "Speak", "track": 3, "loop": True, "mix": .1, "outro": .2, "sync": []}]
    assert student_hall.expression_motion("missing", clips) is None


def test_verified_portrait_clips_supply_real_expression_tracks(tmp_path):
    import os
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs
    game_dir = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")
    if not game_dir.is_dir():
        pytest.skip("No verified game view")
    game = GameAssets(get_search_dirs(game_dir), AssetCache(root=tmp_path / "cache", allowed=False))
    for core, names in (("eimi_spr", ("04", "05")), ("hoshino_spr", ("02", "14")), ("cherino_spr", ("01", "03"))):
        clips = student_hall.portrait_motion_layout(game, core)
        for name in names:
            motion = student_hall.expression_motion(name, clips)
            assert motion["track"] == 1 and motion["loop"] is True
            assert motion["animation"] == name and motion["mix"] == 0
        assert clips["Eye_Close_01"]["track"] == 2
        assert not any(name.startswith("Talk") for name in clips)
