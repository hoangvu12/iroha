import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import StatesPage from "./index";

function renderPage() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ready", version: "test", ui: true }), { status: 200 })));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <StatesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const panel = (title: string) => screen.getByRole("region", { name: title });

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test("each DataTable state has its panel: loading, empty, no results, error, and the table itself", async () => {
  const user = userEvent.setup();
  renderPage();
  expect(within(panel("Loading")).getByText("Loading Upstream Keys")).toBeTruthy();
  expect(within(panel("Empty")).getByText("No Upstream Keys yet")).toBeTruthy();
  expect(within(panel("No results")).getByText("No keys match")).toBeTruthy();
  expect(within(panel("No results")).getByRole("button", { name: "Clear filters" })).toBeTruthy();
  expect(within(panel("Error")).getByText("Couldn't load Requests")).toBeTruthy();
  expect(within(panel("Error")).getByRole("button", { name: "Try again" })).toBeTruthy();

  const table = within(panel("Table")).getByRole("table", { name: "Demo keys" });
  expect(within(table).getAllByRole("row")).toHaveLength(6);
  expect(within(panel("Table")).getByRole("navigation", { name: "Pages of Demo keys" })).toBeTruthy();
  await user.click(within(table).getByRole("checkbox", { name: "Select team-1" }));
  expect(within(panel("Table")).getByRole("group", { name: "1 selected" })).toBeTruthy();
  await user.click(within(table).getByRole("button", { name: "Show details of team-1" }));
  expect(within(panel("Table")).getByText(/team-1 was added/)).toBeTruthy();
});
