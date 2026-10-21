// Student variants share a row only when requested; generic and unidentified assets retain their own rows.
export function importGroups(entries, merged, identify) {
  const groups = new Map();
  for (const entry of entries) {
    const variant = identify(entry).variant;
    const key = merged && variant && entry.kind !== "other" ? `variant:${variant.key}` : `entry:${entry.id}`;
    if (!groups.has(key)) groups.set(key, { key, entries: [], counts: { spr: 0, lobby: 0, model: 0, other: 0 } });
    const group = groups.get(key); group.entries.push(entry);
    group.counts[entry.kind in group.counts ? entry.kind : "other"]++;
  }
  return [...groups.values()];
}
