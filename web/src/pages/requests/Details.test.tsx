import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { RequestRecord } from "./api";
import { RequestDetails } from "./Details";
import { SAMPLE_REQUEST } from "./samples";

const fact = (label: string) => screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;

const withUsage = (usage: RequestRecord["usage"]): RequestRecord => ({ ...SAMPLE_REQUEST, attempts: [], usage });

test("Tokens shows what was read from and written to the Provider's cache", () => {
  render(
    <MemoryRouter>
      <RequestDetails r={withUsage({ input: 5512, output: 5, cache_read: 4000, cache_write: 1500, cache_write_long: 1000, reasoning: 0 })} />
    </MemoryRouter>,
  );
  expect(fact("Input")).toBe("5,512");
  expect(fact("Cache read")).toBe("4,000");
  expect(fact("Cache write")).toBe("1,500");
  expect(fact("Long-lived cache write")).toBe("1,000");
});

test("no long-lived line when the Provider reported no split, dashes without usage", () => {
  const { rerender } = render(
    <MemoryRouter>
      <RequestDetails r={withUsage({ input: 300, output: 4, cache_read: 0, cache_write: 120, cache_write_long: 0, reasoning: 0 })} />
    </MemoryRouter>,
  );
  expect(fact("Cache write")).toBe("120");
  expect(screen.queryByText("Long-lived cache write")).toBeNull();
  rerender(
    <MemoryRouter>
      <RequestDetails r={withUsage(undefined)} />
    </MemoryRouter>,
  );
  expect(fact("Cache read")).toBe("–");
  expect(fact("Cache write")).toBe("–");
});
