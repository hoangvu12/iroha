import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ResultsDialog } from "./Keys";

test("per-key results flow in the dialog, which scrolls as a page", async () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ name: `key-${i}`, ok: i % 2 === 0, text: i % 2 ? "401 invalid key" : "Passed" }));
  render(<ResultsDialog results={{ title: "Tested 120 keys", summary: "60 passed, 60 failed.", rows }} onClose={vi.fn()} />);
  const dialog = await screen.findByRole("dialog", { name: "Tested 120 keys" });
  expect(dialog.className).toContain("overflow-y-auto");
  expect(dialog.querySelector("[data-slot^=scroll-area]"), "no inner Scroll Area").toBeNull();
  expect(dialog.textContent).toContain("key-119");
  expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
});
