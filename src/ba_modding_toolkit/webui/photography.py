"""Student photography RPCs and assets backed by the shared Mod library."""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

from ..errors import ServiceError
from .. import devmode
from ..library.photographs import decode_capture
from ..library.storage import sync_directory
from .system import reveal
from ..library.judge import core_of
from ..library.models import ApplyResult
from .server import AssetResponse

if TYPE_CHECKING:
    from .services import Services


class Photography:
    def __init__(self, services: Services):
        self.services = services

    def _variant(self, key: str):
        if not isinstance(key, str) or len(key) > 200:
            raise ServiceError("bad_params", key="variant")
        try:
            return self.services.catalog.variant(key)
        except (KeyError, ServiceError) as error:
            if isinstance(error, ServiceError) and error.code != "catalog_variant_not_found":
                raise
            resolve = getattr(self.services.library, "variant_metadata", None)
            if callable(resolve):
                return resolve(key)
            raise

    def _target(self, key: str) -> dict:
        variant = self._variant(key)
        if not getattr(variant, "portrait", None):
            raise ServiceError("photo_target_unavailable")
        return self.services.game.collection_target(variant.portrait)

    def default_url(self, variant: str, pin) -> str:
        revision = self.services.game.resource_version
        return f"/asset/photography/default/{pin.id}/{quote(variant, safe='')}.png?revision={revision}"

    def describe(self, result: dict) -> dict:
        for entry in result["photos"]:
            try:
                entry["names"] = self._variant(entry["variant"]).names
            except (KeyError, ServiceError):
                entry["names"] = {}
        return result

    def list(self, variant: str) -> dict:
        self._variant(variant)
        s = self.services
        result = self.describe(s.photographs.list(variant))
        try:
            pin = s.library.current_pin()
            if pin is None:
                raise ServiceError("game_not_found")
            descriptor = self._target(variant)
            game = s.library.photograph_choice(descriptor, pin)
            default = self.default_url(variant, pin)
            game = dict(game)
            key = game.get("id")
            if key:
                entry = s.photographs._entry(variant, key)
                if entry.get("builtin"):
                    game["id"] = "generated"
            elif game.get("known"):
                game["id"] = "official"
        except ServiceError as error:
            if error.code not in ("photo_target_unavailable", "game_not_found"):
                raise
            game, default = {"id": None, "known": False}, None
        return {**result, "game": game, "default": default, "applicable": default is not None}

    def save(self, variant: str, png: str, mode: str, expression: str, action: str, source: str) -> dict:
        self._variant(variant)
        # Persistence must not wait for an unrelated game writer's status scan.
        with self.services._lock:
            return self.describe(self.services.photographs.save(variant, png, mode, expression, action, source))

    def select(self, variant: str, key: str | None) -> dict:
        self._variant(variant)
        with self.services._lock:
            result = self.services.photographs.select(variant, key)
        self.services.events.publish("photography.changed", {"variant": variant})
        return self.describe(result)

    def delete(self, variant: str, key: str) -> dict:
        self._variant(variant)
        self.services.library.delete_photograph(variant, key)
        return self.list(variant)

    def apply(self, variant: str, key: str | None, *, png: str | None = None, restore_app: bool = False) -> str:
        self._variant(variant)
        s, library = self.services, self.services.library
        pin = s._current_pin(library)
        descriptor = self._target(variant)
        if key == "generated":
            decode_capture(png)
        elif key == "official":
            key = None

        def run(log, progress):
            s._check_pin(library, pin)
            chosen = key
            if chosen == "generated":
                chosen = library.photographs.save(variant, png, "portrait", source="generated", builtin=True)["saved"]
            result = library.apply_photograph(variant, chosen, descriptor, pin=pin, log=log, progress=progress)
            if restore_app:
                library.photographs.select(variant, None)
                s.events.publish("photography.changed", {"variant": variant})
            return replace(result, variant=variant)

        with s.classic.starting():
            if s.classic_open() and library.intent()["enabled"]:
                raise ServiceError("classic_open")
            return s.submit("restore" if key is None else "apply", run, writes="game", library=library)

    def restore(self, variant: str, png: str | None = None) -> str:
        try:
            self._target(variant)
        except ServiceError as error:
            if error.code != "photo_target_unavailable":
                raise
            return self.services.jobs.submit("photography.restore", lambda log, progress: self.select(variant, None))
        return self.apply(variant, "generated" if png else None, png=png, restore_app=True)

    def export(self, variant: str, key: str | None, png: str | None = None) -> dict:
        self._variant(variant)
        if key == "generated":
            raw, _, _ = decode_capture(png)
        elif key in (None, "official"):
            pin = self.services.library.current_pin()
            if pin is None:
                raise ServiceError("game_not_found")
            raw = self.asset(["default", pin.id, variant + ".png"]).body
        else:
            raw = self.services.photographs.image(variant, key)
        folder = Path(self.services.settings.get("output_dir")).expanduser().resolve()
        devmode.check_write(folder)
        folder.mkdir(parents=True, exist_ok=True)
        stem = re.sub(r"[^a-zA-Z0-9_-]", "_", variant)[:100] + "-" + (key or "official")
        fd, name = tempfile.mkstemp(prefix=".photo-export-", dir=folder)
        staged = Path(name)
        try:
            with os.fdopen(fd, "wb") as out:
                out.write(raw)
                out.flush()
                os.fsync(out.fileno())
            counter = 0
            while True:
                target = folder / (stem + (f"-{counter}" if counter else "") + ".png")
                try:
                    os.link(staged, target)
                    break
                except FileExistsError:
                    counter += 1
            sync_directory(folder)
        finally:
            staged.unlink(missing_ok=True)
        reveal(folder)
        return {"path": str(target), "folder": str(folder)}

    def asset(self, parts: list[str]) -> AssetResponse:
        s = self.services
        if len(parts) == 3 and parts[0] == "default" and parts[2].endswith(".png"):
            pin = s.library.current_pin()
            if pin is None or pin.id != parts[1]:
                raise ServiceError("folder_changed")
            variant = parts[2][:-4]
            descriptor = self._target(variant)
            paths = s.library.official_bundles(core_of(descriptor["bundle"]), pin)
            paths = [path for path in paths if path.name.removesuffix(".backup") == descriptor["bundle"]]
            return AssetResponse(s.game.collection_portrait_from(descriptor["name"], paths), "image/png", False)
        if len(parts) == 2 and parts[1].endswith(".png"):
            variant, key = parts[0], parts[1][:-4]
            self._variant(variant)
            return AssetResponse(s.photographs.image(variant, key), "image/png", False)
        raise KeyError("photography")


def register(rpc, services: Services) -> None:
    @rpc.method("photography.list")
    def listing(variant: str):
        return services.photography.list(variant)

    @rpc.method("photography.save")
    def save(variant: str, png: str, mode: str, expression: str = "", action: str = "", source: str = ""):
        return services.photography.save(variant, png, mode, expression, action, source)

    @rpc.method("photography.select")
    def select(variant: str, id: str | None):
        return services.photography.select(variant, id)

    @rpc.method("photography.delete")
    def delete(variant: str, id: str):
        return services.photography.delete(variant, id)

    @rpc.method("photography.apply")
    def apply(variant: str, id: str | None, png: str | None = None):
        return services.photography.apply(variant, id, png=png)

    @rpc.method("photography.restore")
    def restore(variant: str, png: str | None = None):
        return services.photography.restore(variant, png)

    @rpc.method("photography.export")
    def export(variant: str, id: str | None, png: str | None = None):
        return services.photography.export(variant, id, png)
