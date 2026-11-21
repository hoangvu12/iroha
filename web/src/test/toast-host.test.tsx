import { act } from "@testing-library/react";
import { toast } from "@ui-sdk/react/toast";
import { afterEach, expect, test, vi } from "vitest";
import { notify } from "@/ui/toast";

afterEach(() => {
  act(() => void toast.dismiss());
  vi.useRealTimers();
});

test("a toast with no Toaster mounted doesn't fail the run a second later", () => {
  vi.useFakeTimers();
  act(() => void notify.success("Key deleted"));
  expect(() => vi.advanceTimersByTime(1100)).not.toThrow();
});
