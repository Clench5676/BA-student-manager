"""Memorial lobby lines of the Global server, read on demand and kept in memory only.

The Global client carries the official English, Traditional Chinese, Korean and Thai text of every memorial lobby
dialogue, with the Japanese original, in its CharacterDialog table, which is encrypted in the install. ba-data
(github.com/electricgoat/ba-data) publishes the Global client's tables as JSON; the table is read once per session,
only for a UI language Kivo has no text for, and nothing read here is written to disk. (SchaleDB's voice data has no
memorial lobby lines.)

A dialogue is a group of rows (``GroupId``) played by the talk animation its first row names (``Talk_01_M``). Its
rows go on the dialogue's voice clips in order: with fewer rows than clips the last clips get no line of their own
(the row before stays on screen), with more rows the rest join the last clip's line.
"""

from __future__ import annotations

import gzip
import json
import logging
import re
import threading
import time
import urllib.request
from collections.abc import Iterable
from typing import Any

from .errors import ServiceError

logger = logging.getLogger(__name__)

URLS = (
    "https://raw.githubusercontent.com/electricgoat/ba-data/global/DB/CharacterDialogExcelTable.json",
    "https://cdn.jsdelivr.net/gh/electricgoat/ba-data@global/DB/CharacterDialogExcelTable.json",  # mirror
)
USER_AGENT = "Blue-Archive-Modding-and-Patching-Tool"
TIMEOUT = 20.0  # seconds for each network operation
DEADLINE = 60.0  # seconds for the whole table from both sources (a slow or trickling link gives up then)
RETRY_AFTER = 300.0  # seconds before the table is asked for again after it could not be read
MAX_BYTES = 64 << 20  # the table is about 15 MB (2.4 MB compressed)
CHUNK = 256 << 10
CATEGORY = "UILobbySpecial"  # the memorial lobby's dialogues
COLUMNS = {"LocalizeEN": "en", "LocalizeTW": "zh-TW", "LocalizeKR": "ko", "LocalizeTH": "th", "LocalizeJP": "ja"}
TALK = re.compile(r"Talk_\d+_M")
CLIP = re.compile(r"_memoriallobby_(\d+)(?:_(\d+))?$")
_CJK = re.compile(r"[\u2e80-\u9fff\u3000-\u30ff\uff00-\uffef]")

Dialogues = dict[str, list[dict[str, str]]]  # {talk animation: [{lang: text}, ...]}


def _join(a: str, b: str) -> str:
    """Two parts of one line: nothing between CJK text, a space elsewhere."""
    if not a or not b:
        return a or b
    return a + b if _CJK.match(a[-1]) or _CJK.match(b[0]) else f"{a} {b}"


def one_line(text: Any) -> str:
    """A row's text on one line (the game breaks lines by hand)."""
    out = ""
    for part in str(text or "").split("\n"):
        out = _join(out, part.strip())
    return out


def dialogues(rows: Iterable[dict[str, Any]]) -> dict[int, Dialogues]:
    """``{character id: {talk animation: [{lang: text}, ...]}}`` from the rows of the CharacterDialog table."""
    groups: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("DialogCategory") != CATEGORY or row.get("TeenMode"):
            continue
        try:
            key = (int(row["CharacterId"]), int(row["GroupId"]))
        except (KeyError, TypeError, ValueError):
            continue
        groups.setdefault(key, []).append(row)
    out: dict[int, Dialogues] = {}
    for (character, group_id), group in sorted(groups.items()):
        group.sort(key=lambda row: row.get("DisplayOrder") or 0)
        anim = next((str(row["AnimationName"]) for row in group if TALK.fullmatch(str(row.get("AnimationName") or ""))),
                    f"Talk_{group_id:02d}_M")
        out.setdefault(character, {})[anim] = [
            {lang: text for column, lang in COLUMNS.items() if (text := one_line(row.get(column)))} for row in group]
    return out


def talks_of(clips: Iterable[str]) -> dict[str, list[str]]:
    """Voice clips by talk animation, from their names (``hoshino_memoriallobby_3_2`` plays in Talk_03_M)."""
    found: dict[str, list[tuple[int, str]]] = {}
    for clip in clips:
        m = CLIP.search(clip)
        if m:
            found.setdefault(f"Talk_{int(m[1]):02d}_M", []).append((int(m[2] or 0), clip))
    return {anim: [clip for _, clip in sorted(items)] for anim, items in found.items()}


def by_clip(talks: Dialogues, clips: dict[str, list[str]]) -> dict[str, dict[str, str]]:
    """Each dialogue's rows on its voice clips (``clips``: {talk animation: [clip ids in order]})."""
    out: dict[str, dict[str, str]] = {}
    for anim, ids in clips.items():
        rows = talks.get(anim) or []
        if not ids or not rows:
            continue
        last: dict[str, str] = {}
        for row in rows[len(ids) - 1:]:
            for lang, text in row.items():
                last[lang] = _join(last.get(lang, ""), text)
        for clip, row in zip(ids, [*rows[:len(ids) - 1], last]):
            if row:
                out[clip] = dict(row)
    return out


def merge(kivo: dict[str, dict[str, str]], official: dict[str, dict[str, str]]) -> dict[str, dict[str, Any]]:
    """``{clip: {lang: text, "voice": bool}}``: zh-CN from Kivo (the CN server's text or Kivo's translation), en, zh-TW,
    ko and th from the Global server, ja from Kivo else the Global server; voices are Kivo's."""
    out: dict[str, dict[str, Any]] = {}
    for clip in sorted(set(kivo) | set(official)):
        k, g = kivo.get(clip, {}), official.get(clip, {})
        line: dict[str, Any] = {lang: text for lang, text in g.items() if lang != "ja" and text}
        if k.get("zh-CN"):
            line["zh-CN"] = k["zh-CN"]
        if k.get("ja") or g.get("ja"):
            line["ja"] = k.get("ja") or g["ja"]
        line["voice"] = bool(k.get("audio"))
        out[clip] = line
    return out


class GlobalLines:
    """The Global server's memorial lobby lines, fetched once per session and kept in memory."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._table: dict[int, Dialogues] | None = None
        self._failed_at = float("-inf")

    def _get(self, url: str, deadline: float | None = None) -> bytes:
        """The body of url, unpacked, at most MAX_BYTES; TimeoutError once time.monotonic() passes deadline."""
        deadline = time.monotonic() + DEADLINE if deadline is None else deadline

        def left() -> float:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("table download too slow")
            return remaining

        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
        chunks, size = [], 0
        with urllib.request.urlopen(req, timeout=min(TIMEOUT, left())) as res:
            gzipped = (res.headers.get("Content-Encoding") or "").lower() == "gzip"
            while True:
                left()
                chunk = res.read1(CHUNK)  # what has come in: the deadline is checked between network reads
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("table too large")
                chunks.append(chunk)
        data = b"".join(chunks)
        return gzip.decompress(data) if gzipped else data

    def dialogues(self, character_id: int | str) -> Dialogues:
        """The memorial lobby dialogues of a character (its SchaleDB id is the game's character id); ``{}`` when the
        Global server has none. ``lines_unavailable`` when the table cannot be read (asked again after a while)."""
        # one reader at a time: callers that come in during the download wait for its result
        with self._lock:
            if self._table is None:
                if time.monotonic() - self._failed_at < RETRY_AFTER:
                    raise ServiceError("lines_unavailable")
                self._table = self._read()
                if self._table is None:
                    self._failed_at = time.monotonic()
                    raise ServiceError("lines_unavailable")
            table = self._table
        try:
            return table.get(int(character_id), {})
        except (TypeError, ValueError):
            return {}

    def _read(self) -> dict[int, Dialogues] | None:
        deadline = time.monotonic() + DEADLINE
        for url in URLS:
            if time.monotonic() >= deadline:
                logger.info("Global lobby lines unavailable: no time left for %s", url)
                break
            try:
                data = json.loads(self._get(url, deadline))
                rows = data.get("DataList") if isinstance(data, dict) else data
                if not isinstance(rows, list):
                    raise ValueError("no rows")
                return dialogues(rows)
            except Exception as e:  # offline, HTTP errors, bad JSON
                logger.info("Global lobby lines unavailable from %s: %s", url, e)
        return None
