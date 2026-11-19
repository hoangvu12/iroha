import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./api";
import { SnippetDialog } from "./SnippetDialog";

const curl = Array.from({ length: 80 }, (_, i) => `  -H "X-Line-${i}: ${i}" \\`).join("\n");

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ curl, python: "print()", typescript: "console.log()" }), { status: 200, headers: { "Content-Type": "application/json" } })),
  );
});
afterEach(() => vi.unstubAllGlobals());

// UI ticket 28: a long snippet makes the dialog taller than the window, and the
// dialog scrolls as a page; the code only scrolls sideways (long lines).
test("a long snippet flows in the dialog: no height limit, only a sideways scroll", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SnippetDialog open onOpenChange={vi.fn()} settings={{ ...DEFAULT_SETTINGS, model: "acme/gpt-4o" }} prompt="Hi" />
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole("dialog", { name: "Use this from code" });
  await screen.findByText(/X-Line-79/);
  const viewport = dialog.querySelector("[data-slot=scroll-area-viewport]")!;
  expect(viewport.className, "no height limit").not.toMatch(/max-h-/);
});
