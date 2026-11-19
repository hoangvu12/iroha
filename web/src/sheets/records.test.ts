import { expect, test } from "vitest";
import { readStack, recordKey, writeStack } from "./records";

test("each record kind round-trips through the URL, other params kept", () => {
  const stack = [
    { kind: "request", id: "req_01", tab: "attempts" },
    { kind: "provider", handle: "acme" },
    { kind: "key", provider: "acme", key: "team/5" },
    { kind: "endpoint", provider: "acme", endpoint: "main" },
    { kind: "gateway-key", key: "gk_9" },
    { kind: "pool", name: "fast pool" },
  ] as const;
  const search = writeStack("?caller=linh&range=24h", [...stack]);
  const p = new URLSearchParams(search);
  expect(p.get("caller")).toBe("linh");
  expect(p.getAll("sheet")).toEqual(["request:req_01/attempts", "provider:acme", "key:acme/team/5", "endpoint:acme/main", "gateway-key:gk_9", "pool:fast pool"]);
  expect(readStack(search)).toEqual(stack);
});

test("an empty stack leaves no sheet param; the old ?request= link opens the Request sheet", () => {
  expect(writeStack("?sheet=provider:acme&request=req_1&q=x", [])).toBe("?q=x");
  expect(readStack("?request=req_7")).toEqual([{ kind: "request", id: "req_7" }]);
  expect(readStack("?sheet=nonsense&sheet=provider:&sheet=pool:p")).toEqual([{ kind: "pool", name: "p" }]);
});

test("a record's identity ignores the Request sheet's tab", () => {
  expect(recordKey({ kind: "request", id: "req_1", tab: "captured" })).toBe(recordKey({ kind: "request", id: "req_1" }));
  expect(recordKey({ kind: "key", provider: "a", key: "k" })).not.toBe(recordKey({ kind: "endpoint", provider: "a", endpoint: "k" }));
});
