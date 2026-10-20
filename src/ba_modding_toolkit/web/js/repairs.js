// The repair lines of the Overwritten message: what the user runs to get an official file back, per install
// (docs/web-ui.md, "Enable Mods switch"). The app never starts a repair and never replaces a game file for one, so
// these are lines only, never a button. Pure, tested in Node (tests/js/repairs.test.mjs).
//
//   install                                          lines
//   a Steam install (in <library>/steamapps/common)  Steam: Properties - Installed Files - Verify integrity of game
//                                                    files; In the game: Restore Resources, may not replace mods;
//                                                    Then start this app again
//   any other                                        In the game: Restore Resources, may not replace mods; Then start
//                                                    this app again
//
// Steam's verify is the settled repair: it replaces every file whose SHA-1 differs from its depot manifest. The
// game's own Restore Resources is only another option, never promised: whether it replaces a CRC-fixed mod is not
// verified, so its line says it may not.

// a folder inside a Steam library: Steam's manifest sits in the steamapps folder above common, which the Steam check
// before a write also looks for (game_paths.steam_app_manifest)
export const isSteam = (folder) => /(^|[\\/])steamapps[\\/]common([\\/]|$)/i.test(String(folder ?? ""));

// the repair lines for these installs ({folder} or a path): Steam's verify first when one of them is a Steam install,
// then the game's own Restore Resources as another option, then "Then start this app again"
export function repairLines(installs, T) {
  const steam = (installs || []).some((item) => isSteam(typeof item === "string" ? item : item?.folder));
  return [...(steam ? [T("mods.repairSteam")] : []), T("mods.repairGame"), T("mods.repairThen")];
}

// the Overwritten message's lines: the entries named, "No official copy left", then the repair lines
export function overwrittenLines({ names = [], installs = [] } = {}, T) {
  return [...names, T("mods.overwrittenNone"), ...repairLines(installs, T)];
}

// the Add First message's lines (an overwritten entry not in the library yet): a repair would replace the only copy
// of the mod, so no repair line shows until it is added (its button adds it)
export function addFirstLines({ names = [] } = {}, T) {
  return [...names, T("mods.overwrittenNone"), T("mods.addFirst")];
}
