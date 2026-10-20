// The repair lines of the Overwritten message: what the user runs to get an official file back, per install
// (docs/web-ui.md, "Enable Mods switch"). The app never starts a repair and never replaces a game file for one, so
// these are lines only, never a button. Pure, tested in Node (tests/js/repairs.test.mjs).
//
//   install                                       lines
//   a Steam install (in <library>/steamapps/common)  Steam: Properties - Installed Files - Verify integrity of game
//                                                     files; Then start this app again
//   any other (no verified route yet)                none: the message says "No official copy left" and "Mods stay
//                                                     in the mod library"
//
// The game's own Restore Resources and the JP launcher's check get a line once the user's checks say they replace a
// modded file.

// a folder inside a Steam library: Steam's manifest sits in the steamapps folder above common, which the Steam check
// before a write also looks for (game_paths.steam_app_manifest)
export const isSteam = (folder) => /(^|[\\/])steamapps[\\/]common([\\/]|$)/i.test(String(folder ?? ""));

// the repair lines for these installs ({folder} or a path): the Steam line when one of them is a Steam install
export function repairLines(installs, T) {
  const steam = (installs || []).some((item) => isSteam(typeof item === "string" ? item : item?.folder));
  return steam ? [T("mods.repairSteam"), T("mods.repairThen")] : [];
}

// the Overwritten message's lines: the entries named, "No official copy left", then the repair lines, or the mod
// library's line where no repair is known
export function overwrittenLines({ names = [], installs = [] } = {}, T) {
  const repair = repairLines(installs, T);
  return [...names, T("mods.overwrittenNone"), ...(repair.length ? repair : [T("mods.helpKept")])];
}
