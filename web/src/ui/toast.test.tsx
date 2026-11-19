import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@ui-sdk/react/toast";
import { afterEach, expect, test, vi } from "vitest";
import { notify, notifyChange, Toaster } from "./toast";

afterEach(() => {
  act(() => void toast.dismiss());
});

test("notify shows a UI SDK toast in the Notifications region, hidden from agents", async () => {
  render(<Toaster />);
  act(() => void notify.success("3 keys disabled"));
  const item = await screen.findByText("3 keys disabled");
  const el = item.closest("[data-slot=toast]")!;
  expect(el.getAttribute("data-type")).toBe("success");
  const region = el.closest("[data-slot=toast-region]")!;
  expect(region.hasAttribute("data-agent-hidden")).toBe(true);
});

test("an action on a toast runs and closes it", async () => {
  const user = userEvent.setup();
  const undo = vi.fn();
  render(<Toaster />);
  act(() => void notify.success("Key deleted", { label: "Undo", onClick: undo }));
  await user.click(await screen.findByRole("button", { name: "Undo" }));
  expect(undo).toHaveBeenCalledOnce();
  // Not UI SDK's announcer region, which keeps the last message read out.
  await waitFor(() => expect(screen.queryByText("Key deleted", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeNull());
});

test("notifyChange offers Undo only for a revertible change", async () => {
  render(<Toaster />);
  act(() => void notifyChange("Endpoint added", { audit_entry: undefined }));
  await screen.findByText("Endpoint added");
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  act(() => void notifyChange("Endpoint removed", { audit_entry: "ae_1" }));
  await screen.findByText("Endpoint removed");
  expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
});

test("a failure is an error toast worded from the error", async () => {
  render(<Toaster />);
  act(() => void notify.failure("Couldn't test team-5", new Error("401 Invalid key")));
  const item = await screen.findByText("Couldn't test team-5: 401 Invalid key");
  expect(item.closest("[data-slot=toast]")!.getAttribute("data-type")).toBe("error");
});
