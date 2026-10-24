// Two bounded lobby module instances: one retained current scene and one hidden replacement.
const modules = [null, null];
const moduleAt = (index) => modules[index] ||= index === 0 ? import("./lobby.js?student-hall-a") : import("./lobby.js?student-hall-b");
export function createMemorialPool({ load, moduleFor = moduleAt }) {
  const slots = [null, null]; let current = null, pending = null, disposed = false;
  function release(session) {
    if (!session || session.dead) return;
    session.dead = true; session.controller.abort(); session.signal?.removeEventListener("abort", session.cancel);
    session.player?.hide(session.host); session.host.remove();
    if (slots[session.index] === session) slots[session.index] = null;
    if (pending === session) pending = null;
    if (current === session) current = null;
  }
  return {
    current: () => current,
    suspend() { current?.player.suspend(); },
    resume() { if (current && !disposed) current.player.resume(); },
    async prepare(choice, makeHost, signal) {
      if (disposed || signal?.aborted) return null;
      const key = `${choice.variant}:${choice.source}`;
      if (pending) release(pending);
      if (current?.key === key) return current;
      const index = current?.index === 0 ? 1 : 0;
      release(slots[index]);
      const controller = new AbortController(), session = { index, key, choice, host: makeHost(), controller, signal, dead: false, player: null };
      slots[index] = pending = session;
      session.cancel = () => release(session); signal?.addEventListener("abort", session.cancel, { once: true });
      try {
        const player = await moduleFor(index);
        if (session.dead || disposed) return null;
        session.player = player;
        const ready = await load(choice, session.host, controller.signal, player);
        if (session.dead || disposed) return null;
        if (ready !== true) throw new Error("Memorial scene is not ready");
        session.ready = true; return session;
      } catch (error) { release(session); throw error; }
    },
    commit(session) {
      if (!session || session.dead || !session.ready || disposed) return false;
      if (current !== session) { release(current); current = session; }
      if (pending === session) pending = null;
      return true;
    },
    discard(session) { if (session !== current) release(session); },
    invalidate: release,
    cancelPending() { release(pending); },
    dispose() { if (disposed) return; disposed = true; for (const session of slots) release(session); },
  };
}
