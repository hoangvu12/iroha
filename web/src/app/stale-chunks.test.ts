import { afterEach, expect, it, vi } from "vitest";
import { reloadOnStaleChunks } from "./stale-chunks";

// A tab opened before a deploy asks for a chunk the new build no longer has
// (a page opened for the first time, a sheet). Vite reports it on window as
// vite:preloadError; the tab reloads once to get the new build.

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  sessionStorage.clear();
});

const preloadError = () => window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

it("reloads the page when a chunk can't be loaded", () => {
  const reload = vi.fn();
  stop = reloadOnStaleChunks({ reload, now: () => 1_000_000 });
  preloadError();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("doesn't reload again right after a reload for the same reason, so a missing chunk never loops", () => {
  const reload = vi.fn();
  let now = 1_000_000;
  stop = reloadOnStaleChunks({ reload, now: () => now });
  preloadError();
  // The reloaded page (same tab, same sessionStorage) fails too, 3 s later.
  stop();
  stop = reloadOnStaleChunks({ reload, now: () => now });
  now += 3_000;
  preloadError();
  expect(reload).toHaveBeenCalledTimes(1);
  // A later deploy, minutes on, reloads again.
  now += 10 * 60_000;
  preloadError();
  expect(reload).toHaveBeenCalledTimes(2);
});

it("still reloads when sessionStorage can't be used", () => {
  const reload = vi.fn();
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  stop = reloadOnStaleChunks({ reload, now: () => 1 });
  preloadError();
  expect(reload).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
