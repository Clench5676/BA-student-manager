"""Tests for the memorial lobby lines read from Kivo (no network)."""

import pytest

from ba_modding_toolkit import kivo
from ba_modding_toolkit.errors import ServiceError

PAGE = {
    "voice": [
        {"description": "Hoshino_MemorialLobby_1.ogg", "text": "欸嘿嘿", "text_original": "へえ～ すごい。\nこんなところ初めて。",
         "file": "//static.kivo.wiki/voices/a.ogg"},
        {"description": "Hoshino_MemorialLobby_1_new.ogg", "text": "", "text_original": "", "file": "//static.kivo.wiki/voices/b.ogg"},
        {"description": "Hoshino_Lobby_1.ogg", "text": "x", "file": "//static.kivo.wiki/voices/c.ogg"},
        {"description": "Hoshino_MemorialLobby_2.ogg", "text": "翻译", "text_original": "原文", "file": "https://evil.example/x.ogg"},
    ],
    "voice_cn": [{"description": "hoshino_memoriallobby_2.ogg", "text": "国服文本", "file": "//static.kivo.wiki/voices/cn.ogg"}],
}


def test_clip_id_matches_spine_events_and_kivo_names():
    assert kivo.clip_id("Images/sound/Hoshino_MemorialLobby_3_1") == "hoshino_memoriallobby_3_1"
    assert kivo.clip_id("Hoshino_MemorialLobby_3_1_new.ogg") == "hoshino_memoriallobby_3_1"


def test_lobby_lines():
    lines = kivo.lobby_lines(PAGE)
    assert set(lines) == {"hoshino_memoriallobby_1", "hoshino_memoriallobby_2"}
    one = lines["hoshino_memoriallobby_1"]
    assert one == {"zh-CN": "欸嘿嘿", "ja": "へえ～すごい。こんなところ初めて。", "audio": "https://static.kivo.wiki/voices/a.ogg"}
    # the CN server's text wins over Kivo's translation
    assert lines["hoshino_memoriallobby_2"]["zh-CN"] == "国服文本"


def test_audio_only_from_kivo(monkeypatch):
    k = kivo.Kivo()
    monkeypatch.setattr(k, "_get", lambda url: __import__("json").dumps(PAGE).encode() if "api.kivo.wiki" in url else b"OggS")
    assert k.audio("76", "hoshino_memoriallobby_1") == b"OggS"
    with pytest.raises(KeyError):
        k.audio("76", "hoshino_memoriallobby_2")  # not on Kivo's voice host


def test_offline_is_a_service_error(monkeypatch):
    k = kivo.Kivo()

    def fail(url):
        raise OSError("offline")

    monkeypatch.setattr(k, "_get", fail)
    with pytest.raises(ServiceError) as e:
        k.lines("76")
    assert e.value.code == "lines_unavailable"
    with pytest.raises(ServiceError):
        k.lines("../etc")
