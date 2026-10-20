"""Metadata upgrades for older mod libraries."""

from __future__ import annotations

import copy

from .judge import core_of, kind_of_file, seconds

LEGACY_REMAP = "legacy_remapped_v020"
# Frozen suffixes from 0.2.0's webui.remap.name, independent of the current UI language.
_REMAP_SUFFIXES = (" (remapped)", "\uff08\u5df2\u91cd\u6392\uff09",
                   "\uff08\u518d\u914d\u7f6e\u6e08\u307f\uff09", " (\uc7ac\ubc30\uce58 \uc644\ub8cc)")


def legacy_remapped(records: dict[str, dict]) -> dict[str, dict]:
    """Recognize 0.2.0's generated labels and link only an unambiguous source.

    That release stored no source ID. Its output uses current official bundle names,
    so dates, CRCs, part counts and bytes can all differ from the source. The stored
    label, target, kind and bundle core are the remaining provenance. An unknown
    source gets a distinct dangling repair reference, keeping its own count and tag.
    """
    records = copy.deepcopy(records)
    groups: dict[tuple, list[dict]] = {}
    keys = {}
    for mod_id, record in records.items():
        cores = {core_of(name) for name in record["files"]}
        if len(cores) != 1 or not all(kind_of_file(name) == record["kind"] for name in record["files"]):
            continue
        key = (record["target"], record["kind"], cores.pop())
        keys[mod_id] = key
        groups.setdefault((record["label"], *key), []).append(record)

    repairs = {}
    for mod_id, record in records.items():
        if mod_id not in keys or "user_added" in record or record.get("repaired_from"):
            continue
        name = next((record["label"][:-len(suffix)] for suffix in _REMAP_SUFFIXES
                     if record["label"].endswith(suffix)), "")
        if not name:
            continue
        added = seconds(record["added"])
        sources = [source for source in groups.get((name, *keys[mod_id]), [])
                   if source["id"] != mod_id and added is not None
                   and (at := seconds(source["added"])) is not None and at <= added]
        repairs[mod_id] = (name, sources[0]["id"] if len(sources) == 1 else f"legacy-remap:{mod_id}")

    for mod_id, (name, source_id) in repairs.items():
        # 0.2.0 also allowed remapping a remapped copy; all copies share the first source's count.
        seen = {mod_id}
        while source_id in repairs and source_id not in seen:
            seen.add(source_id)
            name, source_id = repairs[source_id]
        record = records[mod_id]
        record["label"], record["repaired_from"] = name, source_id
        if source_id in records:
            source = records[source_id]
            alias = source.get("alias")
            record["label"] = alias if isinstance(alias, str) and alias else source["label"]
            source.setdefault("repaired_id", mod_id)
    return records
