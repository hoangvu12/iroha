import { expect, test } from "vitest";
import { cachedShare, cacheReadText } from "./cache-share";

test("the cached share is cache read over input, none without input", () => {
  expect(cachedShare({ input: 4000, cache_read: 1000 })).toBe(0.25);
  expect(cachedShare({ input: 0, cache_read: 0 })).toBeUndefined();
  expect(cachedShare(undefined)).toBeUndefined();
});

test("what the share is made of, in words, or short for a row labelled Cache read", () => {
  expect(cacheReadText({ input: 4000, cache_read: 1000 })).toBe("1,000 of 4,000 input tokens read from the cache");
  expect(cacheReadText({ input: 4000, cache_read: 1000 }, "short")).toBe("1,000 of 4,000 input");
});
