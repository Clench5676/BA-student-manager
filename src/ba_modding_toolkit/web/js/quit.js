// Quitting from the student list, as the PC client's back key does in the lobby: the top bar's back button, or Escape
// on the list, opens the game's quit prompt (title Notice, line Quit?, Cancel and Confirm). Without the DOM (tested in
// Node from tests/test_quit.py); main.js wires it.

// the hosts of the popups and screens that take Escape themselves: the asset consent, scan consent and update popups,
// the display settings, the settings, the shared message and list popups, the detail screen's own
export const HOSTS = Object.freeze(["consent", "display", "settings", "dialog", "prompt", "popup", "picker"]);

// whether a key press opens the quit prompt: Escape alone, on the student list, when nothing else takes it. Never
// when another handler took the key (the search box, the display settings), while an input method composes (keyCode
// 229 is WebKit's key that ends a conversion), for a held key's repeat, with a modifier, while a popup is open, or
// behind the loading screen.
//   byId(id)  the page's element of that id (document.getElementById)
//   covering  the loading screen covers the stage (Loading.covering())
export function quitKey(ev, { byId, covering = false }) {
  if (!ev || ev.key !== "Escape") return false;
  if (ev.defaultPrevented || ev.isComposing || ev.keyCode === 229 || ev.repeat) return false;
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return false;
  if (covering) return false;
  const roster = byId("screen-roster");
  if (!roster || roster.hidden) return false;
  return !HOSTS.some((id) => { const host = byId(id); return !!host && !host.hidden; });
}

// The PC client's key mapping (PCKeyMappingSO) binds the confirm of its popups (UIPopup_System and UIPopup_Sort,
// Btn_Ok: UI_KeyMapping_Common_BtnOK01) to Return, with Space as its second key; their cancel's Escape binding is
// unused, and Escape closes the popup in front as for any popup.
export const CONFIRM_KEYS = Object.freeze(["Enter", " "]);

// the quit prompt, then the quit:
//   message(opts)  the shared message popup (popup.js), resolving with {button}
//   rpc, T, notify  the page's
//   native         the app runs in its own window (app.quit closes it)
//   closed()       shows that the app has quit (browser mode: the server stops after answering)
// Resolves with "cancel", "quit" or the refusal's error code (busy while a writer job runs, native_unavailable with
// --serve).
let asking = false;
export async function confirmQuit({ message, rpc, T, notify, native = false, closed }) {
  if (asking) return "cancel";
  asking = true;
  try {
    const { button } = await message({
      title: T("quit.title"), lines: [T("quit.ask")], ok: T("picker.ok"), cancel: T("popup.cancel"), confirmKeys: CONFIRM_KEYS,
    });
    if (button !== "ok") return "cancel";
    try {
      await rpc("app.quit");
    } catch (err) {
      notify(T(`error.${err.code || "internal"}`, err.params || {}), { kind: "error", error: err });
      return err.code || "internal";
    }
    if (!native) closed?.();
    return "quit";
  } finally {
    asking = false;
  }
}
