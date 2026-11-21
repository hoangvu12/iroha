const KEY = "iroha:stale-chunk-reload-at";
const RELOAD_LOOP_GUARD_MS = 10_000;

export function reloadOnStaleChunks({
  reload = () => window.location.reload(),
  now = () => Date.now(),
}: { reload?: () => void; now?: () => number } = {}): () => void {
  const onError = () => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
    } catch {}
    if (last && now() - last < RELOAD_LOOP_GUARD_MS) return;
    try {
      sessionStorage.setItem(KEY, String(now()));
    } catch {}
    reload();
  };
  window.addEventListener("vite:preloadError", onError);
  return () => window.removeEventListener("vite:preloadError", onError);
}
