// Backoff starts only when fresh work has drained. New work pauses and resets the
// idle interval, without consuming another attempt; cancellation retires its timer.
const DELAYS = [2000, 5000, 15000];
export function captureRetries(wake) {
  const waiting = new Map();
  return {
    defer(item, error) {
      const attempt = item.retries || 0;
      if (!/timed out/i.test(error?.message || "") || attempt >= DELAYS.length) return false;
      waiting.set(item, { ready: false, delay: DELAYS[attempt], timer: null });
      item.retries = attempt + 1;
      return true;
    },
    idle(match = () => true) {
      for (const [item, entry] of waiting) {
        if (!match(item) || entry.ready || entry.timer !== null) continue;
        entry.timer = setTimeout(() => { entry.timer = null; entry.ready = true; wake(); }, entry.delay);
      }
    },
    busy() {
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer); entry.timer = null; entry.ready = false;
      }
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
