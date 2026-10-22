// Timed-out captures keep their subscribers and retry only after fresh queued work.
// Two retries, after 500 ms and 1000 ms; cancellation removes both the timer and waiting work.
export function captureRetries(wake) {
  const waiting = new Map();
  return {
    defer(item, error) {
      if (!/timed out/i.test(error?.message || "") || (item.retries || 0) >= 2) return false;
      const entry = { ready: false };
      entry.timer = setTimeout(() => { entry.ready = true; wake(); }, 500 * 2 ** (item.retries || 0));
      item.retries = (item.retries || 0) + 1;
      waiting.set(item, entry);
      return true;
    },
    take(match = () => true) {
      for (const [item, entry] of waiting) if (entry.ready && match(item)) { waiting.delete(item); return item; }
      return null;
    },
    delete(item) {
      clearTimeout(waiting.get(item)?.timer);
      waiting.delete(item);
    },
  };
}
