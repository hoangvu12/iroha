import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useStoredChoice } from "./stored-choice";

const VIEWS = ["table", "flow"] as const;

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

test("a stored choice starts from what this browser kept, and keeps a change", () => {
  localStorage.setItem("iroha:test:view", "flow");
  const { result } = renderHook(() => useStoredChoice("iroha:test:view", VIEWS, "table"));
  expect(result.current[0]).toBe("flow");
  act(() => result.current[1]("table"));
  expect(result.current[0]).toBe("table");
  expect(localStorage.getItem("iroha:test:view")).toBe("table");
});

test("a value it doesn't offer, or none, gives the fallback", () => {
  localStorage.setItem("iroha:test:view", "grid");
  expect(renderHook(() => useStoredChoice("iroha:test:view", VIEWS, "table")).result.current[0]).toBe("table");
  localStorage.clear();
  expect(renderHook(() => useStoredChoice("iroha:test:view", VIEWS, "flow")).result.current[0]).toBe("flow");
});

test("where storage is refused, the choice still changes for this visit", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const { result } = renderHook(() => useStoredChoice("iroha:test:view", VIEWS, "table"));
  expect(result.current[0]).toBe("table");
  act(() => result.current[1]("flow"));
  expect(result.current[0]).toBe("flow");
});
