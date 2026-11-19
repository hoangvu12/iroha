import { act } from "@testing-library/react";
import { toast } from "@ui-sdk/react/toast";
import { afterEach, expect, test, vi } from "vitest";
import { notify } from "@/ui/toast";

afterEach(() => {
  act(() => void toast.dismiss());
  vi.useRealTimers();
});

// UI SDK checks once, 1 s after a file's first toast, that a host renders
// toasts, and strict mode turns its warning into an error. Whether a test's
// <Toaster /> happens to be mounted at that instant depends on how fast the
// file runs, so a loaded run failed now and then (the toast flake noted in UI
// tickets 13 and 21). App mounts the Toaster once; setup.ts counts a host for
// the whole run, so a page test whose action toasts never trips the check.
test("a toast with no Toaster mounted doesn't fail the run a second later", () => {
  vi.useFakeTimers();
  act(() => void notify.success("Key deleted"));
  expect(() => vi.advanceTimersByTime(1100)).not.toThrow();
});
