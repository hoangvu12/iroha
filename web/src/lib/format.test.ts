import { expect, test } from "vitest";
import { plural } from "./format";

test("plural says a count with its noun, one or many, the count formatted", () => {
  expect(plural(1, "key")).toBe("1 key");
  expect(plural(0, "key")).toBe("0 keys");
  expect(plural(1200, "key")).toBe("1,200 keys");
  expect(plural(2, "entry", "entries")).toBe("2 entries");
});
