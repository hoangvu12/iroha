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

// Ticket 28: the "scrollable overlay". The dialog part is a layer over the
// whole window that scrolls; the visible dialog sits in it at its natural
// height, so its body never scrolls in a box of its own.
test("a dialog scrolls as a page: the dialog layer scrolls and its body has no scroll box of its own", async () => {
  const user = userEvent.setup();
  render(
    <Opener>
      {(open, set) => (
        <Dialog open={open} onOpenChange={set} title="Upstream key" footer={<Button>Save key</Button>}>
          {Array.from({ length: 60 }, (_, i) => (
            <p key={i}>Line {i}</p>
          ))}
        </Dialog>
      )}
    </Opener>,
  );
  await user.click(screen.getByRole("button", { name: "Open it" }));
  const dialog = await screen.findByRole("dialog", { name: "Upstream key" });
  expect(dialog.className).toContain("overflow-y-auto");
  expect(dialog.className).toContain("inset-0");
  expect(dialog.querySelector("[data-slot^=scroll-area]"), "no inner Scroll Area").toBeNull();
  expect(dialog.className, "no height limit on the dialog").not.toMatch(/max-h-\[/);
  // The visible dialog holds the title, the body, the footer and the Close button.
  const panel = dialog.querySelector("[data-dialog-panel]")!;
  expect(panel.textContent).toContain("Line 59");
  expect(panel.contains(screen.getByRole("button", { name: "Save key" }))).toBe(true);
  expect(panel.contains(screen.getByRole("button", { name: "Close" }))).toBe(true);
});

test("a press on the space around the dialog closes it and focus returns to the opener; a press inside keeps it", async () => {
  const user = userEvent.setup();
  render(
    <Opener>
      {(open, set) => (
        <Dialog open={open} onOpenChange={set} title="Add endpoint">
          <p>Body text</p>
        </Dialog>
      )}
    </Opener>,
  );
  const opener = screen.getByRole("button", { name: "Open it" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Add endpoint" });
  await user.click(screen.getByText("Body text"));
  await user.click(dialog.querySelector("[data-dialog-panel]")!);
  expect(screen.getByRole("dialog", { name: "Add endpoint" })).toBeTruthy();

  // The layer around the dialog (above, below and beside it) reads as outside.
  await user.click(dialog.firstElementChild!);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(opener);

  await user.click(opener);
  await user.click(await screen.findByRole("dialog", { name: "Add endpoint" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a press that starts in a field and ends around the dialog keeps it open (a text selection)", async () => {
  const user = userEvent.setup();
  render(
    <Opener>
      {(open, set) => (
        <Dialog open={open} onOpenChange={set} title="Rename">
          <input aria-label="Name" defaultValue="team-5" />
        </Dialog>
      )}
    </Opener>,
  );
  await user.click(screen.getByRole("button", { name: "Open it" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename" });
  await user.pointer([{ keys: "[MouseLeft>]", target: screen.getByRole("textbox", { name: "Name" }) }, { target: dialog.firstElementChild! }, { keys: "[/MouseLeft]" }]);
  expect(screen.getByRole("dialog", { name: "Rename" })).toBeTruthy();
});

test("a press around a nested dialog closes only the nested one", async () => {
  const user = userEvent.setup();
  function Nested() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(false);
    return (
      <Dialog open={outer} onOpenChange={setOuter} title="New Gateway Key">
        <Button onClick={() => setInner(true)}>Pick models</Button>
        <Dialog open={inner} onOpenChange={setInner} title="Models of acme">
          <p>Models</p>
        </Dialog>
      </Dialog>
    );
  }
  render(<Nested />);
  await user.click(await screen.findByRole("button", { name: "Pick models" }));
  const inner = await screen.findByRole("dialog", { name: "Models of acme" });
  await user.click(inner.firstElementChild!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Models of acme" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "New Gateway Key" })).toBeTruthy();
});

test("an alert dialog wants an answer: a press around it keeps it open", async () => {
  const user = userEvent.setup();
  render(
    <Opener>
      {(open, set) => <ConfirmDialog open={open} onOpenChange={set} title="Delete key?" body="Gone." confirmLabel="Delete key" onConfirm={vi.fn()} />}
    </Opener>,
  );
  await user.click(screen.getByRole("button", { name: "Open it" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Delete key?" });
  expect(dialog.className).toContain("overflow-y-auto");
  await user.click(dialog.firstElementChild!);
  expect(screen.getByRole("alertdialog", { name: "Delete key?" })).toBeTruthy();
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
