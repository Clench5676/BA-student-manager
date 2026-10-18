"""Tests for the Global server's memorial lobby lines and their merge with Kivo's (no network)."""

import gzip
import json
from pathlib import Path

import pytest

from ba_modding_toolkit import globallines
from ba_modding_toolkit.config import Settings
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState


def row(cid, group, order, en, tw="", anim="", category="UILobbySpecial", teen=False, jp=""):
    return {"CharacterId": cid, "CostumeUniqueId": cid * 100 + 1, "DisplayOrder": order, "DialogCategory": category,
            "DialogCondition": "Idle", "GroupId": group, "DialogType": "Talk", "AnimationName": anim,
            "LocalizeEN": en, "LocalizeTW": tw, "LocalizeKR": "", "LocalizeTH": "", "LocalizeJP": jp, "TeenMode": teen}


# the shape of ba-data's CharacterDialogExcelTable.json (Hoshino's third dialogue has two rows for three clips)
TABLE = {"DataList": [
    row(10005, 1, 270, "Wow... Amazing.\nI've never been here.", "\u6b38\u563f\uff5e\n\u597d\u53b2\u5bb3\u3002", "Talk_01_M"),
    row(10005, 3, 300, "I shouldn't worry about that? All right, then.", anim=""),
    row(10005, 3, 290, "Is it okay?", "\u53ef\u4ee5\u7684\u55ce\u2026", "Talk_03_M", jp="\u3044\u3044\u306e\u304b\u306a\u2026\u3002"),
    row(10005, 2, 280, "Look! It's a fish!", anim="Talk_02_M"),
    row(10005, 2, 281, "Hahaha.", anim=""),
    row(10005, 2, 282, "It's so cute!", anim=""),
    row(10005, 1, 100, "Welcome, Sensei.", category="UILobby"),  # the lobby's normal lines
    row(20001, 1, 10, "Teen text", anim="Talk_01_M", teen=True),
    row(20001, 1, 11, "Full text", anim="Talk_01_M"),
]}


def test_dialogues_group_rows_by_talk_animation():
    table = globallines.dialogues(TABLE["DataList"])
    assert set(table) == {10005, 20001}
    hoshino = table[10005]
    assert list(hoshino) == ["Talk_01_M", "Talk_02_M", "Talk_03_M"]
    # rows in display order, joined to one line: a space between English parts, none between CJK ones
    assert hoshino["Talk_01_M"] == [{"en": "Wow... Amazing. I've never been here.", "zh-TW": "\u6b38\u563f\uff5e\u597d\u53b2\u5bb3\u3002"}]
    assert [r["en"] for r in hoshino["Talk_03_M"]] == ["Is it okay?", "I shouldn't worry about that? All right, then."]
    assert hoshino["Talk_03_M"][0]["ja"] == "\u3044\u3044\u306e\u304b\u306a\u2026\u3002"
    assert table[20001]["Talk_01_M"] == [{"en": "Full text"}]  # teen mode rows are left out


def test_talks_of_clip_names():
    clips = ["hoshino_memoriallobby_3_2", "hoshino_memoriallobby_0", "hoshino_memoriallobby_3_1", "hoshino_memoriallobby_1",
             "hoshino_lobby_1"]
    assert globallines.talks_of(clips) == {"Talk_00_M": ["hoshino_memoriallobby_0"], "Talk_01_M": ["hoshino_memoriallobby_1"],
                                           "Talk_03_M": ["hoshino_memoriallobby_3_1", "hoshino_memoriallobby_3_2"]}


def test_rows_go_on_the_clips_in_order():
    hoshino = globallines.dialogues(TABLE["DataList"])[10005]
    lines = globallines.by_clip(hoshino, {
        "Talk_01_M": ["h_1"],
        "Talk_02_M": ["h_2_1", "h_2_2"],          # three rows on two clips: the rest join the last one
        "Talk_03_M": ["h_3_1", "h_3_2", "h_3_3"],  # two rows on three clips: the last clip has none of its own
        "Talk_09_M": ["h_9"],                      # no rows on the Global server
    })
    assert lines["h_1"]["en"] == "Wow... Amazing. I've never been here."
    assert lines["h_2_1"] == {"en": "Look! It's a fish!"}
    assert lines["h_2_2"] == {"en": "Hahaha. It's so cute!"}
    assert lines["h_3_1"]["en"] == "Is it okay?" and lines["h_3_2"]["en"].startswith("I shouldn't")
    assert "h_3_3" not in lines and "h_9" not in lines


def test_merge_keeps_each_language_its_own_source():
    kivo = {"c1": {"zh-CN": "\u4f60\u597d", "ja": "", "audio": "https://static.kivo.wiki/v.ogg"},
            "c2": {"zh-CN": "", "ja": "\u3042", "audio": ""}}
    official = {"c1": {"en": "Hello", "zh-TW": "\u4f60\u597d", "ja": "\u516c\u5f0f"}, "c3": {"en": "Only global"}}
    merged = globallines.merge(kivo, official)
    assert merged["c1"] == {"en": "Hello", "zh-TW": "\u4f60\u597d", "zh-CN": "\u4f60\u597d", "ja": "\u516c\u5f0f", "voice": True}
    assert merged["c2"] == {"ja": "\u3042", "voice": False}  # Kivo's Japanese wins when it has one
    assert merged["c3"] == {"en": "Only global", "voice": False}


class Fetcher(globallines.GlobalLines):
    def __init__(self, payload=None, error=None):
        super().__init__()
        self.payload, self.error, self.urls = payload, error, []

    def _get(self, url):
        self.urls.append(url)
        if self.error:
            raise self.error
        return self.payload


def test_table_read_once_and_kept():
    g = Fetcher(json.dumps(TABLE).encode())
    assert list(g.dialogues(10005)) == ["Talk_01_M", "Talk_02_M", "Talk_03_M"]
    assert g.dialogues("20001") and g.dialogues(99999) == {} and g.dialogues(None) == {}
    assert len(g.urls) == 1


def test_offline_is_a_service_error_and_not_asked_again_at_once():
    g = Fetcher(error=OSError("offline"))
    with pytest.raises(ServiceError) as e:
        g.dialogues(10005)
    assert e.value.code == "lines_unavailable"
    assert g.urls == list(globallines.URLS)  # the mirror is tried too
    with pytest.raises(ServiceError):
        g.dialogues(10005)
    assert len(g.urls) == len(globallines.URLS)


def test_gzip_responses_are_unpacked(monkeypatch):
    body = gzip.compress(json.dumps(TABLE).encode())

    class Response:
        headers = {"Content-Encoding": "gzip"}

        def read(self, n):
            return body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(globallines.urllib.request, "urlopen", lambda req, timeout: Response())
    assert json.loads(globallines.GlobalLines()._get(globallines.URLS[0])) == TABLE


# --- the lobby.lines RPC ---

class Variant:
    key, page_id, schale_id = "hoshino", "76", 10005


class Catalog:
    def variant(self, key):
        return Variant()


class Kivo:
    def __init__(self, fail=False):
        self.fail = fail

    def lines(self, page_id):
        if self.fail:
            raise ServiceError("lines_unavailable")
        return {"hoshino_memoriallobby_1": {"zh-CN": "\u6b38\u563f", "ja": "\u3078\u3048", "audio": "https://static.kivo.wiki/a.ogg"},
                "hoshino_memoriallobby_3_1": {"zh-CN": "\u5c31\u6211", "ja": "\u79c1", "audio": "https://static.kivo.wiki/b.ogg"}}


@pytest.fixture
def api(tmp_path: Path):
    s = Services(Settings(tmp_path / "config.toml"), tmp_path, state=UiState(tmp_path / "webui.json"), cache=object(),
                 game=object(), catalog=Catalog(), library=object())
    s.kivo, s.global_lines = Kivo(), Fetcher(json.dumps(TABLE).encode())
    yield s, build_api(s)
    s.close()


def test_lobby_lines_in_english(api):
    s, rpc = api
    talks = {"Talk_01_M": ["Hoshino_MemorialLobby_1"], "Talk_03_M": ["hoshino_memoriallobby_3_1", "hoshino_memoriallobby_3_2"]}
    lines = rpc.call("lobby.lines", {"variant": "hoshino", "talks": talks, "lang": "en"})["result"]
    assert lines["hoshino_memoriallobby_1"]["en"].startswith("Wow") and lines["hoshino_memoriallobby_1"]["voice"] is True
    assert lines["hoshino_memoriallobby_1"]["zh-CN"] == "\u6b38\u563f"
    assert lines["hoshino_memoriallobby_3_2"] == {"en": "I shouldn't worry about that? All right, then.", "voice": False}
    # without the skeleton's clips, Kivo's clip names place the rows (here one clip for both rows of Talk_03_M)
    lines = rpc.call("lobby.lines", {"variant": "hoshino", "lang": "en"})["result"]
    assert lines["hoshino_memoriallobby_3_1"]["en"] == "Is it okay? I shouldn't worry about that? All right, then."


def test_lobby_lines_in_chinese_never_read_the_global_table(api):
    s, rpc = api
    lines = rpc.call("lobby.lines", {"variant": "hoshino", "lang": "zh-CN"})["result"]
    assert lines["hoshino_memoriallobby_1"] == {"zh-CN": "\u6b38\u563f", "ja": "\u3078\u3048", "voice": True}
    assert s.global_lines.urls == []


def test_lobby_lines_without_kivo_or_global(api):
    s, rpc = api
    s.kivo = Kivo(fail=True)
    lines = rpc.call("lobby.lines", {"variant": "hoshino", "talks": {"Talk_02_M": ["h_2"]}, "lang": "en"})["result"]
    assert lines == {"h_2": {"en": "Look! It's a fish! Hahaha. It's so cute!", "voice": False}}
    s.global_lines = Fetcher(error=OSError("offline"))
    assert rpc.call("lobby.lines", {"variant": "hoshino", "lang": "en"})["error"]["code"] == "lines_unavailable"
    # malformed clips from the page are ignored
    s.kivo = Kivo()
    assert "hoshino_memoriallobby_1" in rpc.call("lobby.lines", {"variant": "hoshino", "talks": [1, 2], "lang": "en"})["result"]
