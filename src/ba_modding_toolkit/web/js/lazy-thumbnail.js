// A switch card starts capture on entering the viewport, or when its details are shown.
// Both consumers share the same still and the popup's cancellation scope.
export function lazyThumbnail(capture, signal) {
  let picture, started = false, finish, fail;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const cancel = () => { signal?.removeEventListener("abort", cancel); finish(null); };
  const start = () => {
    if (!started && !signal?.aborted) {
      started = true;
      try { picture = capture(); } catch (error) { picture = Promise.reject(error); }
      Promise.resolve(picture).then((url) => {
        signal?.removeEventListener("abort", cancel); finish(signal?.aborted ? null : url);
      }, (error) => { signal?.removeEventListener("abort", cancel); fail(error); });
    }
    return result;
  };
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  return Object.assign(result, { thumbnail: true, signal, start,
    bump: () => { start(); picture?.bump?.(); }, failure: () => picture?.failure?.() });
}
