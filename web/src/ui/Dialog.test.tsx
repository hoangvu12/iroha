import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { Button } from "./Button";
import { ConfirmDialog, Dialog, TypeToConfirmDialog } from "./Dialog";

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

function Opener({ children }: { children: (open: boolean, set: (o: boolean) => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open it</Button>
      {children(open, setOpen)}
    </>
  );
}

test("Dialog is UI SDK's dialog, named by its title; Close and Escape close it and focus returns to the opener", async () => {
  const user = userEvent.setup();
  render(
    <Opener>
      {(open, set) => (
        <Dialog open={open} onOpenChange={set} title="Edit endpoint" description="Where requests go" footer={<Button>Save endpoint</Button>}>
          <p>Body</p>
        </Dialog>
      )}
    </Opener>,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  const opener = screen.getByRole("button", { name: "Open it" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Edit endpoint" });
  expect(dialog.getAttribute("data-slot")).toBe("dialog-content");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.textContent).toContain("Where requests go");
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);

  await user.click(opener);
  await screen.findByRole("dialog", { name: "Edit endpoint" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);
});

test("ConfirmDialog is an alert dialog: focus starts on Cancel, Cancel closes without confirming", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(
    <Opener>
      {(open, set) => (
        <ConfirmDialog open={open} onOpenChange={set} title="Delete team-5?" body="The key goes." confirmLabel="Delete forever" onConfirm={onConfirm} />
      )}
    </Opener>,
  );
  await user.click(screen.getByRole("button", { name: "Open it" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Delete team-5?" });
  expect(dialog.textContent).toContain("The key goes.");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onConfirm).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open it" }));
});

test("ConfirmDialog stays open while onConfirm runs, shows its error, and closes once it succeeds", async () => {
  const user = userEvent.setup();
  let fail = true;
  let finish!: () => void;
  const onConfirm = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = () => (fail ? reject(new Error("Iroha said no")) : resolve());
      }),
  );
  render(
    <Opener>
      {(open, set) => <ConfirmDialog open={open} onOpenChange={set} title="Delete rule?" body="Gone." confirmLabel="Delete rule" onConfirm={onConfirm} />}
    </Opener>,
  );
  await user.click(screen.getByRole("button", { name: "Open it" }));
  const confirm = await screen.findByRole("button", { name: "Delete rule" });
  expect(confirm.getAttribute("data-agent-confirm")).toBe("Delete rule?");
  await user.click(confirm);
  expect(confirm.hasAttribute("data-pending")).toBe(true);
  await act(async () => finish());
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Iroha said no");
  expect(screen.getByRole("alertdialog")).toBeTruthy();

  fail = false;
  await user.click(confirm);
  await act(async () => finish());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onConfirm).toHaveBeenCalledTimes(2);
});

test("TypeToConfirmDialog enables its button only when the name is typed; Enter confirms", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(
    <Opener>
      {(open, set) => (
        <TypeToConfirmDialog open={open} onOpenChange={set} title="Revoke zeron?" body="Callers stop." name="zeron" confirmLabel="Revoke for good" onConfirm={onConfirm} />
      )}
    </Opener>,
  );
  await user.click(screen.getByRole("button", { name: "Open it" }));
  const field = await screen.findByRole("textbox", { name: "Type zeron to confirm" });
  expect(document.activeElement).toBe(field);
  const confirm = screen.getByRole("button", { name: "Revoke for good" });
  expect(confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true").toBe(true);
  await user.type(field, "zero{Enter}");
  expect(onConfirm).not.toHaveBeenCalled();
  await user.type(field, "n{Enter}");
  await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("an agent opens a dialog, finds it by name, and needs a person to confirm a delete", async () => {
  const onConfirm = vi.fn();
  render(
    <Opener>
      {(open, set) => <ConfirmDialog open={open} onOpenChange={set} title="Delete pool?" body="Gone." confirmLabel="Delete forever" onConfirm={onConfirm} />}
    </Opener>,
  );
  const opened = await agent.act({ steps: [{ ref: "Open it", action: "press" }] });
  expect(opened.ok, opened.error?.message).toBe(true);
  await screen.findByRole("alertdialog", { name: "Delete pool?" });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  expect(components.map((e) => e.label)).toContain("Delete pool?");

  const remove = { steps: [{ ref: "Delete pool?", action: "press", args: ["Delete forever"] }] };
  expect((await agent.act(remove)).ok).toBe(false);
  expect(onConfirm).not.toHaveBeenCalled();
  approve = true;
  await agent.act({ steps: [{ ref: "Open it", action: "press" }] });
  const done = await agent.act(remove);
  expect(done.ok, done.error?.message).toBe(true);
  await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
});
