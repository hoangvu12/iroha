// After a deploy, a tab still running the old build asks for chunks the new
// build no longer has (each file name carries a content hash, and Iroha
// serves only the embedded build). Vite reports such a failed dynamic import
// as `vite:preloadError` on window; the tab then reloads once, which fetches
// the new index.html (served no-cache) and so the new chunks. A second
// failure soon after a reload is left to show: the chunk is really missing,
// and reloading again would loop. (UI ticket 32; Vite "Load Error Handling".)

const KEY = "iroha:stale-chunk-reload-at";
const AGAIN_AFTER_MS = 10_000;

export function reloadOnStaleChunks({
  reload = () => window.location.reload(),
  now = () => Date.now(),
}: { reload?: () => void; now?: () => number } = {}): () => void {
  const onError = () => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
    } catch {
      // Storage blocked: reload anyway (worst case one reload per failure).
    }
    if (last && now() - last < AGAIN_AFTER_MS) return;
    try {
      sessionStorage.setItem(KEY, String(now()));
    } catch {
      // As above.
    }
    reload();
  };
  window.addEventListener("vite:preloadError", onError);
  return () => window.removeEventListener("vite:preloadError", onError);
}
