// Hall owns its immersive UI independently of the detail screen and its shared exit button.
export function createFullscreen({ root, stage, chrome, prepareExit, popupOpen = () => false,
  document: doc = globalThis.document, onChange = () => {}, returnFocus = () => null }) {
  let active = false, pending = false, disposed = false, generation = 0, exit = null, held = [], previousFocus = null;
  const restore = (refocus) => {
    const wasActive = active;
    active = false; pending = false; generation++;
    stage.classList.remove("hall-fullscreen"); root.classList.remove("hall-immersive");
    exit?.host.remove(); exit = null;
    for (const [element, inert] of held) if (element.isConnected) element.inert = inert;
    held = [];
    if (wasActive) onChange(false);
    const target = previousFocus?.isConnected ? previousFocus : returnFocus(); previousFocus = null;
    if (refocus && target?.isConnected && !target.closest?.("[inert]")) target.focus({ preventScroll: true });
  };
  const leave = ({ refocus = true } = {}) => restore(refocus);
  async function enter() {
    if (disposed || active || pending) return false;
    pending = true; const version = ++generation;
    let prepared;
    try { prepared = await prepareExit(() => leave()); }
    catch (error) { if (version === generation) pending = false; throw error; }
    if (disposed || version !== generation || !root.isConnected) { prepared?.host.remove(); return false; }
    pending = false; previousFocus = doc.activeElement;
    held = [stage.querySelector(".topbar"), stage.querySelector(".nav"), chrome].filter(Boolean).map((element) => [element, element.inert]);
    if (held.some(([element]) => element.contains(previousFocus))) previousFocus?.blur?.();
    for (const [element] of held) element.inert = true;
    exit = prepared; root.append(exit.host); active = true;
    stage.classList.add("hall-fullscreen"); root.classList.add("hall-immersive");
    onChange(true); exit.button.focus({ preventScroll: true }); return true;
  }
  const key = (event) => {
    if ((!active && !pending) || event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 || popupOpen()) return;
    event.preventDefault(); event.stopPropagation(); leave();
  };
  doc.addEventListener("keydown", key, true);
  return { enter, leave, active: () => active, pending: () => pending,
    relabel(label) { exit?.button.setAttribute("aria-label", label); },
    dispose() { if (disposed) return; disposed = true; restore(false); doc.removeEventListener("keydown", key, true); },
  };
}
