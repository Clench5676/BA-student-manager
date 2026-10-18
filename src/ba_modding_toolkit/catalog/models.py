"""JSON-ready roster records."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class Variant:
    """A file-id variant and the assets available in the current install."""

    key: str
    file_id: str
    family: str
    names: dict[str, dict[str, str]]
    playable: bool
    order: int
    spr: str | None
    lobby: str | None
    bg: str | None
    portrait: str | None
    date: str | None
    page_id: str | None = None  # the student page on Kivo (kivo.wiki), for lobby lines
    recruitable: bool = False  # playable on the selected server, not only on some server
    model: str | None = None  # the 3D chibi's dev name (character-<dev>-_mxload-* bundles)
    schale_id: int | None = None  # the game's character id (SchaleDB's student id), for the Global server's lines

    def to_json(self) -> dict:
        """Return an independent JSON-ready record for RPC responses."""
        return asdict(self)


@dataclass
class Family:
    """A student, named by their base variant, with installed portrait variants."""

    key: str
    names: dict[str, str]
    school: str | None
    variants: list[Variant]

    def to_json(self) -> dict:
        """Return an independent JSON-ready record for RPC responses."""
        return asdict(self)
