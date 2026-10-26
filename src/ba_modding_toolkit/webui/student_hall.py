"""Student Hall entries and memory-only portrait dialogue, independent of game selection."""
from __future__ import annotations

import base64
import copy
import json
import logging
import math
import re
import threading
import time
from collections import OrderedDict
from concurrent.futures import FIRST_COMPLETED, Future, TimeoutError as FutureTimeout, wait
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from ..errors import ServiceError
from .. import globallines
from ..gameassets.errors import AssetNotFound
from ..gameassets.layouts import export_layout, subtree
from ..gameassets.unity import open_bundle, object_record
from ..gameassets.spine import spine_stamps
from ..kivo import API, AUDIO_HOST, Kivo, _one_line, clip_id

logger = logging.getLogger(__name__)

# LobbyCommon/TweenController/CharPos in the game's 2960-unit NGUI stage.
PORTRAIT_ORIGIN = (960 - 112 * (1920 / 2960), 540 + 886 * (1920 / 2960))
PORTRAIT_SCALE = (.25, 1.5, 1)


def empty_hall() -> dict:
    return {"revision": 0, "mode": "portraits", "background": "", "portraitScale": PORTRAIT_SCALE[2], "portraits": [], "memorials": [], "active": None}


def normalize_hall(value: Any) -> dict:
    """Canonicalize duplicate resources on read without writing or advancing the stored revision."""
    result = copy.deepcopy(value) if isinstance(value, dict) else empty_hall()
    result.setdefault("portraitScale", PORTRAIT_SCALE[2])
    for group in ("portraits", "memorials"):
        entries = result.get(group, [])
        if not isinstance(entries, list):
            continue
        seen, kept = {}, []
        for entry in entries:
            key = (entry.get("variant"), entry.get("source")) if isinstance(entry, dict) else None
            if key and all(isinstance(part, str) and part for part in key):
                if key in seen:
                    if group == "memorials" and entry.get("id") == result.get("active"):
                        seen[key]["id"] = entry["id"]
                    continue
                seen[key] = entry
            kept.append(entry)
        result[group] = kept
    return result


def validate_hall(value: Any) -> dict:
    """Validate a complete snapshot without silently dropping entries or merging duplicate students."""
    if not isinstance(value, dict) or value.get("mode") not in ("portraits", "memorial"):
        raise ServiceError("bad_params", key="hall")
    out = empty_hall()
    out["mode"] = value["mode"]
    bg = value.get("background", "")
    if not isinstance(bg, str) or (bg and bg not in ("office-day", "office-night")
                                   and not re.fullmatch(r"BG_[a-zA-Z0-9_-]+(?:\.png)?", bg)):
        raise ServiceError("bad_params", key="background")
    out["background"] = bg
    scale = value.get("portraitScale", PORTRAIT_SCALE[2])
    if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(scale) or not PORTRAIT_SCALE[0] <= scale <= PORTRAIT_SCALE[1]:
        raise ServiceError("bad_params", key="portraitScale")
    out["portraitScale"] = scale
    ids = set()
    for group in ("portraits", "memorials"):
        sources = set()
        entries = value.get(group)
        if not isinstance(entries, list):
            raise ServiceError("bad_params", key=group)
        for entry in entries:
            if not isinstance(entry, dict):
                raise ServiceError("bad_params", key=group)
            uid, variant, source = (entry.get(k) for k in ("id", "variant", "source"))
            try:
                valid_id = isinstance(uid, str) and str(UUID(uid)) == uid
            except ValueError:
                valid_id = False
            if not valid_id or uid in ids or not isinstance(variant, str) or not variant or len(variant) > 200:
                raise ServiceError("bad_params", key="entry")
            if not isinstance(source, str) or not (source == "official" or re.fullmatch(r"mod:[a-zA-Z0-9_-]+", source)):
                raise ServiceError("bad_params", key="source")
            ids.add(uid)
            item = {"id": uid, "variant": variant, "source": source}
            key = (variant, source)
            if key in sources:
                raise ServiceError("hall_duplicate_portrait" if group == "portraits" else "hall_duplicate_memorial")
            sources.add(key)
            if group == "portraits":
                mirror = entry.get("mirror", False)
                if not isinstance(mirror, bool):
                    raise ServiceError("bad_params", key="mirror")
                item["mirror"] = mirror
                for key, default, lo, hi in (("x", PORTRAIT_ORIGIN[0], 0, 1920),
                                             ("y", PORTRAIT_ORIGIN[1], 200, 1800), ("scale", 1, .2, 2.5)):
                    n = entry.get(key, default)
                    if isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) or not lo <= n <= hi:
                        raise ServiceError("bad_params", key=key)
                    item[key] = n
            out[group].append(item)
    active = value.get("active")
    out["active"] = active if any(e["id"] == active for e in out["memorials"]) else next((e["id"] for e in out["memorials"]), None)
    return out


def save_hall(state: Any, value: dict, revision: int) -> dict:
    """Compare and replace under the UI state's cross-process transaction lock."""
    clean = validate_hall(value)
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        raise ServiceError("bad_params", key="revision")
    def change(data: dict) -> None:
        prefs = data.setdefault("prefs", {})
        current = prefs.get("student_hall", empty_hall())
        if current.get("revision", 0) != revision:
            raise ServiceError("hall_conflict")
        if current.get("portraits") and not clean["portraits"]:
            raise ServiceError("hall_last_portrait")
        if current.get("memorials") and not clean["memorials"]:
            raise ServiceError("hall_last_memorial")
        clean["revision"] = revision + 1
        prefs["student_hall"] = clean
    state._update(change)
    return copy.deepcopy(clean)


def portrait_lines(page: dict) -> dict:
    """Use the game's ordinary Lobby voice clips; memorial dialogue belongs to the scene player."""
    tables = []
    for key in ("voice", "voice_cn"):
        table = {}
        for row in page.get(key, []) or []:
            cid = clip_id(str(row.get("description", "")))
            if not re.search(r"_lobby_\d+(?:_\d+)?$", cid):
                continue
            if cid not in table or row.get("text"):
                table[cid] = row
        tables.append(table)
    jp, cn = tables
    out = {}
    for cid in sorted(set(jp) | set(cn)):
        j, c = jp.get(cid, {}), cn.get(cid, {})
        audio = j.get("file") or ""
        if audio.startswith("//"):
            audio = "https:" + audio
        out[cid] = {"zh-CN": _one_line(c.get("text") or j.get("text")), "ja": _one_line(j.get("text_original")), "audio": audio}
    # Old test recordings can coexist with the current clip on the same page. Do not add an untranslated
    # alternate to the rotation when that exact numbered line already has a captioned current recording.
    def suffix(clip: str) -> str:
        return clip.rsplit("_lobby_", 1)[1]
    captioned = {suffix(clip) for clip, row in out.items() if row.get("zh-CN") or row.get("ja")}
    return {clip: row for clip, row in out.items()
            if row.get("zh-CN") or row.get("ja") or suffix(clip) not in captioned}


class PortraitVoices(Kivo):
    def __init__(self) -> None:
        super().__init__()
        self.memo = MemoryMemo(64 * 1024 * 1024, 160)

    def lines(self, page_id: str) -> dict:
        if not page_id or not str(page_id).isdigit():
            raise ServiceError("lines_unavailable")
        def read() -> dict:
            try:
                data = json.loads(self._get(API.format(page=page_id)))
                return portrait_lines(data.get("data", data))
            except Exception as exc:
                raise ServiceError("lines_unavailable") from exc
        return self.memo.get(("lines", page_id), read)

    def audio(self, page_id: str, clip: str) -> bytes:
        row = self.lines(page_id).get(clip_id(clip), {})
        url = row.get("audio", "")
        if not url.startswith(f"https://{AUDIO_HOST}/"):
            raise ServiceError("lines_unavailable")
        def read() -> bytes:
            try:
                return self._get(url)
            except Exception as exc:
                raise ServiceError("lines_unavailable") from exc
        return self.memo.get(("audio", url), read)


class MemoryMemo:
    """Bounded memory-only results with one in-flight producer and short failure backoff per key."""

    def __init__(self, byte_limit: int, count_limit: int):
        self.byte_limit, self.count_limit = byte_limit, count_limit
        self._lock = threading.RLock()
        self._values: OrderedDict[Any, tuple[Any, int]] = OrderedDict()
        self._flights: dict[Any, Future] = {}
        self._failed: OrderedDict[Any, tuple[float, dict]] = OrderedDict()
        self.bytes = 0

    def peek(self, key: Any) -> Any:
        with self._lock:
            cached = self._values.get(key)
            if cached is None:
                return None
            self._values.move_to_end(key)
            return cached[0]

    def get(self, key: Any, read: Any) -> Any:
        with self._lock:
            if key in self._values:
                self._values.move_to_end(key)
                return self._values[key][0]
            failed = self._failed.get(key)
            if failed and time.monotonic() - failed[0] < 30:
                raise ServiceError(failed[1]["code"], **failed[1].get("params", {}))
            owner = key not in self._flights
            pending = self._flights.setdefault(key, Future())
        if not owner:
            return pending.result()
        try:
            value = read()
            size = len(value) if isinstance(value, bytes) else len(json.dumps(value).encode())
            with self._lock:
                self._failed.pop(key, None)
                if size <= self.byte_limit:
                    self._values[key] = (value, size)
                    self.bytes += size
                    while self.bytes > self.byte_limit or len(self._values) > self.count_limit:
                        _, (_, removed) = self._values.popitem(last=False)
                        self.bytes -= removed
                pending.set_result(value)
            return value
        except Exception as error:
            with self._lock:
                detail = error.to_json() if isinstance(error, ServiceError) else {"code": "lines_unavailable", "params": {}}
                self._failed[key] = (time.monotonic(), detail)
                while len(self._failed) > self.count_limit:
                    self._failed.popitem(last=False)
                pending.set_exception(error)
            raise
        finally:
            with self._lock:
                self._flights.pop(key, None)


class LocalPortraitVoices:
    """Ordinary Lobby AudioClips from installed audio bundles, decoded losslessly in memory."""

    def __init__(self, services: Any):
        self.services = services
        self.memo = MemoryMemo(64 * 1024 * 1024, 128)
        self._index_key = None

    def cached_index(self) -> dict | None:
        key = self._index_key
        return self.memo.peek(key) if key and key[1] == id(self.services.game) else None

    def index(self) -> dict:
        game = self.services.game
        paths = getattr(game, "_paths", lambda: [])()
        paths = [path for path in paths if any(word in path.name.lower() for word in ("audio", "voice", "sound"))]
        stamps = tuple(spine_stamps(paths)) if paths else ()
        def read() -> dict:
            result = {}
            for path in paths:
                try:
                    with open_bundle(path) as env:
                        for obj in env.objects:
                            if obj.type.name != "AudioClip":
                                continue
                            name = clip_id(obj.peek_name() or "")
                            if re.search(r"_lobby_\d+(?:_\d+)?$", name):
                                result.setdefault(name, object_record(path, obj, name))
                except (OSError, ServiceError, ValueError):
                    continue
            return result
        key = ("index", id(game), stamps)
        value = self.memo.get(key, read)
        self._index_key = key
        return value

    def audio(self, clip: str) -> bytes:
        record = self.index().get(clip)
        if record is None:
            raise AssetNotFound(clip)
        path = self.services.game._bundle_path(record["bundle"])
        def read() -> bytes:
            with open_bundle(path) as env:
                obj = next((obj for obj in env.objects if obj.path_id == record["pid"]
                            and obj.assets_file.name == record["cab"] and obj.type.name == "AudioClip"), None)
                if obj is None:
                    raise AssetNotFound(clip)
                try:
                    samples = obj.read().samples
                except Exception as error:
                    raise AssetNotFound(clip) from error
                data = next(iter(samples.values()), None)
                if not data:
                    raise AssetNotFound(clip)
                return data
        return self.memo.get(("audio", clip, tuple(spine_stamps([path]))), read)


def dialogue_layout(game: Any) -> dict:
    """The ordinary LobbyCommon ChatDialog balloon, retaining its native sliced sprite and text styling."""
    hint = "ui-uilobbyelement-_mxload-prefabs-2025-07-02_assets_all_1158600183.bundle"
    path = next((path for path in game._paths() if path.name == hint), None)
    if path is None:
        name = game._lobby_prefabs().get("lobbycommon")
        if not name:
            raise AssetNotFound("LobbyCommon")
        path = game._bundle_path(name)
    def read() -> bytes:
        with open_bundle(path) as env:
            tree = export_layout(env, "LobbyCommon", game._atlas_index()["names"])
        talk = subtree(tree, "DialogPanel/ChatDialog/Talk")
        talk["pos"] = [0, 0]
        return json.dumps(talk).encode()
    return json.loads(game._cached("hall/dialogue-v1/" + json.dumps(spine_stamps([path])), read))


def portrait_motion_layout(game: Any, core: str | None) -> dict:
    """Only authored animation tracks and mixes from the official portrait's SpineClip assets."""
    if not core or not hasattr(game, "spine_cores"):
        return {}
    paths = game.spine_cores("spr").get(core.lower(), [])
    if not paths:
        return {}
    def read() -> bytes:
        from ..gameassets.lobby import Clips
        behaviours = []
        for path in paths:
            with open_bundle(path) as env:
                behaviours.extend((obj.path_id, obj.read_typetree()) for obj in env.objects if obj.type.name == "MonoBehaviour")
        clips = Clips(behaviours, (core,)).clips
        return json.dumps(next((value for name, value in clips.items() if name.lower() == core.lower()), {})).encode()
    return json.loads(game._cached("hall/portrait-motion-v1/" + core + json.dumps(spine_stamps(paths)), read))


def expression_motion(name: str, clips: dict, seen: frozenset = frozenset()) -> dict | None:
    """Random idle clips retain their own scheduler; only explicit synchronized clips join the speech pose."""
    clip = clips.get(name)
    if not clip or name in seen or clip.get("mode") in (2, 3):
        return None
    return {"animation": name, "track": clip["track"], "loop": clip["loop"], "mix": clip["intro"], "outro": clip["outro"],
            "sync": [motion for child in clip.get("sync", []) if (motion := expression_motion(child, clips, seen | {name}))]}


def register_api(rpc: Any, s: Any) -> None:
    voices = PortraitVoices()
    local = LocalPortraitVoices(s)

    def rows_for(v: Any, lang: str) -> tuple[dict, bool, bool]:
        from .api import _background
        started = time.monotonic()
        local_cached = local.cached_index()
        pending_local = _background(local.index) if local_cached is None else None
        character = getattr(v, "schale_id", None)
        page_id = getattr(v, "page_id", None) or ""
        incoming_cached = voices.memo.peek(("lines", page_id))
        pending_incoming = _background(voices.lines, page_id) if page_id and incoming_cached is None else None
        global_cached = s.global_lines.cached_portrait_dialogues(character) if character else None
        pending_global = (_background(s.global_lines.portrait_dialogues, character)
                          if character and global_cached is None else None)
        waiting = False
        def ready(future: Future | None, *, timeout: float = 0) -> dict:
            nonlocal waiting
            if future is None:
                return {}
            try:
                return future.result(timeout=timeout)
            except FutureTimeout:
                waiting = True
                return {}
            except (ServiceError, OSError, KeyError, ValueError) as error:
                logger.debug("Portrait dialogue source unavailable: %s", error)
                return {}
        text_jobs = [future for future in (pending_incoming, pending_global) if future is not None]
        # Return the first available text source. A slow Kivo request must not block ready official captions.
        if text_jobs and incoming_cached is None and global_cached is None:
            wait(text_jobs, timeout=max(0, 3 - (time.monotonic() - started)), return_when=FIRST_COMPLETED)
        # An already available Global row is not proof that Kivo's Chinese caption is absent. Give the
        # requested source the same bounded preparation budget before publishing a fallback response.
        incoming = incoming_cached if incoming_cached is not None else ready(pending_incoming,
            timeout=max(0, 3 - (time.monotonic() - started)) if lang == "zh-CN" else 0)
        animation_pending = global_cached is None and pending_global is not None and not pending_global.done()
        official = global_cached if global_cached is not None else ready(pending_global)
        installed = local_cached if local_cached is not None else ready(pending_local)
        stems = {v.key.lower(), str(getattr(v, "file_id", "")).lower(),
                 str(getattr(v, "spr", "") or "").lower().removesuffix("_spr")}
        clips = set(incoming) | {clip for clip in installed if clip.rsplit("_lobby_", 1)[0] in stems}
        groups: dict[str, list[tuple[int, str]]] = {}
        for clip in clips:
            match = re.search(r"_lobby_(\d+)(?:_(\d+))?$", clip)
            if match:
                groups.setdefault(str(int(match[1])), []).append((int(match[2] or 0), clip))
        # Official text remains useful without a voice source; no generated key claims playable audio.
        for group in official:
            groups.setdefault(str(group), [(0, f"{v.key.lower()}_lobby_{group}")])
        translated = globallines.portrait_voice_lines({str(key): value for key, value in official.items()},
            [clip for items in groups.values() for _, clip in sorted(items)])
        result = globallines.merge(incoming, translated)
        for clip in clips - result.keys():
            result[clip] = {"voice": False}
        for clip, value in result.items():
            remote = incoming.get(clip, {}).get("audio", "").startswith(f"https://{AUDIO_HOST}/")
            value["voice"] = clip in installed or remote
            value["voiceSource"] = "local" if clip in installed else "kivo" if remote else None
        motion = portrait_motion_layout(s.game, getattr(v, "spr", None)) if any(row.get("expression") for row in result.values()) else {}
        for row in result.values():
            for cue in row.get("expressionCues", []):
                if authored := expression_motion(cue["expression"], motion):
                    cue["motion"] = authored
        return result, waiting, animation_pending

    @rpc.method("hall.get")
    def get() -> dict:
        value = s.state.get("student_hall")
        if value is None:
            family = next((item for item in s.catalog.families() if item.key == "shiroko"), None)
            variant = next((v for v in (family.variants if family else [])
                            if v.key in ("shiroko", "shiroko_original") or v.file_id.lower() == "shiroko_original"), None)
            if variant is not None and variant.spr and variant.lobby:
                initial = empty_hall()
                initial["portraits"] = [{"id": str(uuid4()), "variant": variant.key, "source": "official",
                                         "x": PORTRAIT_ORIGIN[0], "y": PORTRAIT_ORIGIN[1], "scale": 1, "mirror": False}]
                initial["memorials"] = [{"id": str(uuid4()), "variant": variant.key, "source": "official"}]
                initial["active"] = initial["memorials"][0]["id"]
                def initialize(data):
                    data.setdefault("prefs", {}).setdefault("student_hall", initial)
                s.state._update(initialize)
                value = s.state.get("student_hall")
        return normalize_hall(value)

    @rpc.method("hall.options")
    def options() -> dict:
        if not s.game_found():
            raise ServiceError("game_directory_missing")
        families = s.catalog.families()
        variants = {v.key: v for f in families for v in f.variants}
        family_names = {family.key: family.names for family in families}
        family_aliases = {family.key: list(getattr(family, "aliases", [])) for family in families}
        schools = {family.key: family.school for family in families}
        mods = s.library.mods()
        if any(mod.target not in variants for mod in mods) and hasattr(s.catalog, "assignment_families"):
            for family in s.catalog.assignment_families():
                family_names.setdefault(family.key, family.names)
                family_aliases.setdefault(family.key, list(getattr(family, "aliases", [])))
                schools.setdefault(family.key, family.school)
        favorites = getattr(s.library, "favorites", lambda: set())()
        recent = s.state.recent()
        custom = s.state.aliases()
        mod_counts: dict[str, int] = {}
        kind_counts: dict[str, dict[str, int]] = {}
        for mod in mods:
            mod_counts[mod.target] = mod_counts.get(mod.target, 0) + 1
            counts = kind_counts.setdefault(mod.target, {})
            counts[mod.kind] = counts.get(mod.kind, 0) + 1
        viewed = s.state.get("hall_viewed", [])
        def metadata(v: Any, source: str, mod: Any = None) -> dict:
            key = f"{v.key}:{source}"
            family = getattr(v, "family", v.key)
            return {"family": family, "familyNames": family_names.get(family, {}), "school": schools.get(family),
                    "familyAliases": family_aliases.get(family, []), "model": getattr(v, "model", None),
                    "fileId": getattr(v, "file_id", v.key), "aliases": list(getattr(v, "aliases", [])),
                    "custom": custom.get(v.key, []), "playable": getattr(v, "playable", False), "recruitable": getattr(v, "recruitable", False),
                    "released": getattr(v, "recruitable", False), "localKinds": [kind for kind in ("spr", "lobby", "model") if getattr(v, kind, None)],
                    "order": getattr(v, "order", 0), "date": getattr(v, "date", None), "favorite": v.key in favorites,
                    "recent": recent.index(v.key) if v.key in recent else None,
                    "viewed": viewed.index(key) if key in viewed else None,
                    "added": getattr(mod, "added", None), "mods": mod_counts.get(v.key, 0), "modCounts": kind_counts.get(v.key, {}),
                    "modId": mod.id if mod else None}
        choices = []
        for v in variants.values():
            for kind in ("spr", "lobby"):
                core = getattr(v, kind, None)
                if core:
                    choices.append({"variant": v.key, "source": "official", "kind": kind, "core": core,
                                    "names": v.names, "label": "", "portrait": f"/asset/art/portrait/{v.portrait}.png" if v.portrait else None,
                                    **metadata(v, "official")})
        for mod in mods:
            if mod.kind not in ("spr", "lobby"):
                continue
            v = variants.get(mod.target)
            if v is None:
                try:
                    v = s.library.variant_metadata(mod.target)
                except ServiceError:
                    continue
            choices.append({"variant": v.key, "source": "mod:" + mod.id, "kind": mod.kind,
                            "core": getattr(v, mod.kind, None), "names": v.names,
                            "label": mod.alias or mod.label, "portrait": f"/asset/art/portrait/{v.portrait}.png" if v.portrait else None,
                            **metadata(v, "mod:" + mod.id, mod)})
        backgrounds = s.game.collection_names()["bg"]
        office = getattr(s.game, "office_backgrounds", lambda: [])()
        return {"choices": choices, "backgrounds": [*office,
                *({"name": n, "url": "/asset/art/bg/" + n} for n in backgrounds)]}

    @rpc.method("hall.update")
    def update(value: dict, revision: int) -> dict:
        return save_hall(s.state, value, revision)

    @rpc.method("hall.viewed")
    def viewed(variant: str, source: str) -> list[str]:
        v = s.library.variant_metadata(variant)
        if source == "official":
            valid = bool(v.lobby)
        else:
            valid = isinstance(source, str) and any("mod:" + mod.id == source and mod.target == variant and mod.kind == "lobby"
                                                  for mod in s.library.mods())
        if not valid:
            raise ServiceError("bad_params", key="source")
        key = f"{variant}:{source}"
        def change(data: dict) -> None:
            prefs = data.setdefault("prefs", {})
            prefs["hall_viewed"] = [key, *(item for item in prefs.get("hall_viewed", []) if item != key)][:500]
        s.state._update(change)
        return s.state.get("hall_viewed", [])

    @rpc.method("hall.dialogueLayout")
    def balloon() -> dict:
        return dialogue_layout(s.game)

    @rpc.method("hall.lines")
    def lines(variant: str, lang: str = "ja") -> dict:
        if lang not in ("en", "zh-CN", "zh-TW", "ja", "ko", "th"):
            raise ServiceError("bad_params", key="lang")
        try:
            v = s.library.variant_metadata(variant)
        except ServiceError as error:
            if error.code not in ("catalog_variant_not_found", "variant_not_found"):
                raise
            logger.debug("Portrait dialogue has no catalog mapping: %s", variant)
            return {"lines": {}, "pending": False, "unavailable": True, "animationPending": False}
        rows, waiting, animation_pending = rows_for(v, lang)
        return {"lines": rows, "pending": waiting, "unavailable": not rows and not waiting, "animationPending": animation_pending}

    @rpc.method("hall.voice")
    def voice(variant: str, clip: str) -> dict:
        v = s.library.variant_metadata(variant)
        if not isinstance(clip, str) or not re.fullmatch(r"[a-z0-9_]+_lobby_\d+(?:_\d+)?", clip):
            raise ServiceError("bad_params", key="clip")
        rows, _, _ = rows_for(v, "zh-CN")
        if not rows.get(clip, {}).get("voice"):
            raise ServiceError("lines_unavailable")
        try:
            data, mime = local.audio(clip), "audio/wav"
        except (OSError, KeyError, ValueError, ServiceError):
            data, mime = voices.audio(getattr(v, "page_id", None) or "", clip), "audio/ogg"
        return {"audio": base64.b64encode(data).decode("ascii"), "mime": mime}
