"""Target-validated Mod ZIP exports, published only after every member is complete."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import unicodedata
import uuid
import zipfile
from pathlib import Path
from typing import Any

from .. import devmode, mod_origin
from ..errors import ServiceError
from ..library import integrity
from ..library.judge import core_of
from ..library.storage import sync_directory
from .batch_import import BatchImport, Candidate, ImportSettings


class _ExportLibrary:
    """Use import validation without treating an existing library entry as completed work."""

    def __init__(self, library: Any):
        self.library = library

    def __getattr__(self, name: str) -> Any:
        return getattr(self.library, name)

    def inspect_import(self, *args: Any, **kwargs: Any) -> dict:
        report = dict(self.library.inspect_import(*args, **kwargs))
        if report.get("recognized"):
            raise ServiceError("original_unavailable")
        report.update(libraryId=None, installed=False)
        return report

    def find_import_source(self, provenance: dict) -> None:
        return None


class _Preparation(BatchImport):
    def options(self) -> dict:
        # Export all transferable Mod content; import filters and output preferences do not apply.
        return {**self.defaults(), "types": ["ALL"], "output": None, "skipUnchanged": False,
                "crc": "auto", "strategy": "name_type"}


def _safe_name(value: str) -> str:
    """A portable component with stable identity even for colliding labels or reserved names."""
    label = re.sub(r"[^a-zA-Z0-9_-]+", "-", value).strip("-_")[:48] or "mod"
    return f"mod-{label}-{hashlib.sha256(value.encode()).hexdigest()[:16]}"


def _member_name(path: Path) -> str:
    name = path.name
    if (not name or name in (".", "..") or any(c in name for c in '\\/:<>"|?*')
            or any(ord(c) < 32 for c in name) or name.endswith((".", " "))):
        raise ServiceError("mod_unsupported", file=name)
    if name.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                                      *(f"LPT{i}" for i in range(1, 10))}:
        raise ServiceError("mod_unsupported", file=name)
    return name


def _pins(library: Any) -> list:
    pins = [library.current_pin(), *library._named_pins()]
    return list({pin.key: pin for pin in reversed(pins) if pin}.values())


def _pin_target(library: Any, settings: Any, pin: Any) -> dict:
    """Read serialized platform metadata when directory names do not identify the install."""
    if pin:
        inspection = integrity.Inspection()
        paths = (path for group in library._index(pin).values() for path in group)
        for _, path in zip(range(8), paths):
            try:
                official = inspection.metadata(library._official_for(path, pin))
                inspection.validate()
            except (OSError, ServiceError):
                continue
            target = mod_origin.target_of(settings, pin, official)
            if target["platform"]:
                return target
    return mod_origin.target_of(settings, pin)


def _target_pin(library: Any, settings: Any, server: str, platform: str) -> Any:
    for pin in _pins(library):
        if _pin_target(library, settings, pin) == {"server": server, "platform": platform}:
            return pin
    raise ServiceError("export_target_unavailable")


def _sources(library: Any, scope: str, target: str | None) -> tuple[list[str], list[dict]]:
    assignments = []
    if scope == "single":
        if not isinstance(target, str) or not target.startswith(("mod:", "variant:")):
            raise ServiceError("bad_params", key="target")
        return [target], assignments
    if scope == "library":
        return [f"mod:{key}" for key in sorted(library._records)], assignments
    if scope != "applied":
        raise ServiceError("bad_params", key="scope")
    profiles = library.profiles.read() or {}
    for folder in profiles.get("folders", {}).values():
        for core, entry in sorted(folder.get("configured", {}).items()):
            source = entry.get("source", "")
            if source.startswith("mod:"):
                assignments.append({"server": folder.get("server", "global"), "core": core,
                                    "variant": entry.get("variant"), "kind": entry.get("kind"), "source": source})
    return sorted({entry["source"] for entry in assignments}), assignments


def _prepare(services: Any, library: Any, source: str, pin: Any, target: dict,
             work: Path, log: Any, progress: Any, kind: str | None = None) -> tuple[list[Path], dict]:
    if source.startswith("variant:"):
        variant = source[8:]
        targets = library._game_files(variant, kind, pin)
        paths = [library._official_for(path, pin) for path in targets]
        if not paths:
            raise ServiceError("game_file_not_found", target=variant)
        contents = integrity.Contents()
        for path in paths:
            contents.merge(integrity.inspect(path))
        if mod_origin.target_of(services.settings, pin, contents) != target:
            raise ServiceError("export_target_unavailable")
        directory = work / _safe_name(source) / "official"
        directory.mkdir(parents=True)
        prepared = []
        for live, original in zip(targets, paths):
            output = directory / _member_name(live)
            shutil.copy2(original, output)
            prepared.append(output)
        return prepared, {"source": source, "variant": variant, "kind": kind}
    record = library._record(source[4:])
    paths = library._paths(record)
    entry = {"id": _safe_name(source), "core": core_of(paths[0].name), "kind": record["kind"],
             "variant": library._target_of(record), "files": [{"path": str(path)} for path in paths]}
    candidate = Candidate({path.name: path for path in paths}, entry)
    preparation = _Preparation(services)
    preparation._judge(candidate, _ExportLibrary(library), pin, log, asset_types={"ALL"}, strategy="name_type")
    preparation._require_importable(candidate)
    if candidate.entry["target"] != target:
        raise ServiceError("export_target_unavailable")
    prepared, _, _ = preparation._prepare(candidate, ImportSettings(services.settings, preparation.options()),
                                          work, log, lambda _c, _phase, step: progress({"step": f"import.step.{step}"}))
    if not prepared:
        raise ServiceError("mod_update_failed")
    # Recheck complete prepared bundles against the requested install, including dependencies.
    library._check_group({path.name: path for path in prepared}, pin, compatibility=False,
                         variant_key=library._target_of(record))
    return prepared, {"source": source, "variant": library._target_of(record), "kind": record["kind"],
                      "name": library._label(record)}


def export_zip(services: Any, library: Any, pin: Any, *, scope: str, target: str | None,
               folder: Path, server: str, platform: str, kind: str | None,
               log: Any, progress: Any) -> dict:
    """Keep a snapshot locked until ZIP verification and atomic publication finish."""
    devmode.check_write(folder)
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / f"mods-{scope}-{server}-{platform}-{uuid.uuid4().hex}.zip"
    temporary_zip = None
    with library._lock:
        library._refresh_state()
        sources, assignments = _sources(library, scope, target)
        if not sources:
            raise ServiceError("export_empty")
        manifest = {"version": 1, "scope": scope, "target": {"server": server, "platform": platform},
                    "mods": [], "assignments": assignments}
        try:
            with tempfile.NamedTemporaryFile(prefix=".mod-export-", suffix=".tmp", dir=folder, delete=False) as stream:
                temporary_zip = Path(stream.name)
            with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX + "export-") as staging:
                with zipfile.ZipFile(temporary_zip, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                    for i, source in enumerate(sources, 1):
                        progress({"current": i, "total": len(sources), "step": "import.step.export"})
                        paths, metadata = _prepare(services, library, source, pin, manifest["target"],
                                                   Path(staging), log, progress, kind)
                        directory = _safe_name(source)
                        names = [_member_name(path) for path in paths]
                        if len({unicodedata.normalize("NFC", name).casefold() for name in names}) != len(names):
                            raise ServiceError("game_file_conflict")
                        members = []
                        for path, name in zip(paths, names):
                            before = path.stat()
                            archive.write(path, f"{directory}/{name}")
                            members.append({"name": name, "size": path.stat().st_size,
                                            "sha256": _sha256(path)})
                            after = path.stat()
                            if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                                    after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                                raise ServiceError("entry_changed")
                        manifest["mods"].append({**metadata, "directory": directory, "files": members})
                    archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            with zipfile.ZipFile(temporary_zip) as archive:
                if archive.testzip() is not None:
                    raise ServiceError("library_io_error", file=str(destination))
                for mod in manifest["mods"]:
                    for member in mod["files"]:
                        with archive.open(f'{mod["directory"]}/{member["name"]}') as stream:
                            if hashlib.file_digest(stream, "sha256").hexdigest() != member["sha256"]:
                                raise ServiceError("entry_changed")
            with temporary_zip.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary_zip, destination)
            sync_directory(folder)
        finally:
            if temporary_zip is not None:
                temporary_zip.unlink(missing_ok=True)
    return {"folder": str(folder), "archive": str(destination), "count": len(sources)}


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def register_api(rpc: Any, services: Any) -> None:
    @rpc.method("export.options")
    def options() -> dict:
        library = services.library
        with library._lock:
            current = _pin_target(library, services.settings, library.current_pin())
            targets = [_pin_target(library, services.settings, pin) for pin in _pins(library)]
        return {"folder": str(Path(services.settings.get("output_dir")).expanduser().resolve()),
                **current, "targets": targets}

    @rpc.method("export.start")
    def start(scope: str, folder: str, server: str, platform: str, target: str | None = None,
              kind: str | None = None) -> str:
        if scope not in ("single", "library", "applied") or server not in mod_origin.SERVERS or platform not in mod_origin.PLATFORMS:
            raise ServiceError("bad_params", key="export")
        if not isinstance(folder, str) or not folder.strip() or kind not in (None, "spr", "lobby", "model", "other"):
            raise ServiceError("bad_params", key="folder")
        destination = Path(folder).expanduser().resolve()
        devmode.check_write(destination)
        library = services.library
        with library._lock:
            pin = _target_pin(library, services.settings, server, platform)
        return services.submit("export", lambda log, progress: export_zip(
            services, library, pin, scope=scope, target=target, folder=destination, server=server,
            platform=platform, kind=kind, log=log, progress=progress))
