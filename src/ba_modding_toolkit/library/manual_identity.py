"""Validate self-contained uploads without making claims about their install targets."""

from pathlib import Path

from .. import mod_origin
from ..errors import ServiceError
from ..naming import parse_filename
from . import integrity
from .identity import content_cores
from .judge import kind_of


def validate(files: dict[str, Path], kind: str | None = None) -> str:
    """Require readable bundles and complete parts; unknown platforms remain storage-only.

    Known platform evidence must be supported and consistent. No choice made here authorizes installation.
    """
    if not files or any(Path(name).name != name or not name.endswith(".bundle") for name in files):
        raise ServiceError("mod_unsupported")
    inspection = integrity.Inspection()
    combined = integrity.Contents()
    kinds = set()
    for name, path in files.items():
        contents = inspection.inspect(path, allow_unknown=True)
        known = contents.platforms - mod_origin.UNKNOWN_PLATFORMS
        if any(platform not in mod_origin.UNITY_PLATFORMS for platform in known):
            raise ServiceError("platform_unsupported", file=name)
        previous = combined.platforms - mod_origin.UNKNOWN_PLATFORMS
        if previous and known and previous != known:
            raise ServiceError("mod_platform_mismatch", file=name,
                               platform=", ".join(sorted(known)), expected=", ".join(sorted(previous)))
        combined.merge(contents)
        parsed = parse_filename(name)
        declared = kind_of(parsed.core, parsed.category)
        if declared:
            kinds.add(declared)
        for core in content_cores(path):
            detected = "model" if core.startswith("model:") else kind_of(core)
            if detected:
                kinds.add(detected)
    if len(kinds) != 1 or (kind is not None and kind not in kinds):
        raise ServiceError("mod_target_ambiguous" if len(kinds) > 1 else "mod_unsupported")
    inferred = next(iter(kinds))
    if inferred in ("spr", "lobby") and not combined.skeletons:
        raise ServiceError("mod_parts_missing", files="skeleton.skel")
    missing = integrity.missing_parts(combined, integrity.Contents())
    if missing:
        raise ServiceError("mod_parts_missing", files=", ".join(sorted(missing)))
    inspection.validate()
    return inferred
