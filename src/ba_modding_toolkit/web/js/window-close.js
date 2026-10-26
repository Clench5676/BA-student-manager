// Freeze input only after the existing Hall permission has saved/discarded the draft.
// A cancelled or timed out native request cannot consume a later page approval.
export function installCloseGuard({ prepare, root, revision = () => null, focus = () => globalThis.document.activeElement, target = globalThis }) {
  const cancelled = new Set();
  let current = null, held = null, previous = null, generation = 0, approvedRevision = null;
  target.bamtPrepareClose = async (token) => {
    if (cancelled.has(token) || current !== null) return false;
    current = token; const version = ++generation;
    previous = focus();
    try {
      const allowed = await prepare();
      if (version !== generation || current !== token) return false;
      if (allowed === false) { target.bamtCancelClose(token); return false; }
      held = root().map((element) => [element, element.inert]);
      for (const [element] of held) element.inert = true;
      approvedRevision = revision();
      return true;
    } catch { target.bamtCancelClose(token); return false; }
  };
  target.bamtValidateClose = (token) => current === token && held !== null && revision() === approvedRevision;
  target.bamtCancelClose = (token) => {
    cancelled.add(token);
    if (current !== token) return;
    ++generation; current = null;
    for (const [element, inert] of held || []) element.inert = inert;
    held = null;
    if (previous?.isConnected && !previous.closest?.('[inert]')) previous.focus({ preventScroll: true });
    previous = null;
  };
}
