import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { expect, test, vi } from "vitest";
import { Button, IconButton } from "./Button";
import { ConfirmAction, useConfirm } from "./Confirm";
import { Menu, MenuContent, MenuIconTrigger, MenuItem } from "./Menu";

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

test("ConfirmAction asks first: the trigger opens a question naming what goes; Escape cancels and focus returns to the trigger", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(
    <ConfirmAction title="Remove gpt-4o from fast?" body="Requests for fast stop going to it." confirmLabel="Remove model" onConfirm={onConfirm}>
      <Button danger>Remove</Button>
    </ConfirmAction>,
  );
  const trigger = screen.getByRole("button", { name: "Remove" });
  await user.click(trigger);
  const dialog = await screen.findByRole("alertdialog", { name: "Remove gpt-4o from fast?" });
  expect(dialog.textContent).toContain("Requests for fast stop going to it.");
  expect(screen.getByRole("button", { name: "Remove model" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onConfirm).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

test("confirming runs the action once; neither the trigger nor the dialog's buttons reach a clickable row around them", async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  const onRow = vi.fn();
  render(
    <table>
      <tbody>
        <tr onClick={onRow}>
          <td>
            <ConfirmAction title="Delete team-5?" body="Undo brings it back." confirmLabel="Delete key" onConfirm={onConfirm}>
              <IconButton icon={Trash2} label="Delete team-5" danger />
            </ConfirmAction>
          </td>
        </tr>
      </tbody>
    </table>,
  );
  await user.click(screen.getByRole("button", { name: "Delete team-5" }));
  await user.click(await screen.findByRole("button", { name: "Delete key" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onConfirm).toHaveBeenCalledOnce();

  await user.click(screen.getByRole("button", { name: "Delete team-5" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(onRow).not.toHaveBeenCalled();
});

function PoolMenu({ onRemove, onRevoke }: { onRemove: () => void; onRevoke?: () => void }) {
  const confirm = useConfirm();
  return (
    <>
      <Menu>
        <MenuIconTrigger icon={MoreHorizontal} label="More for gpt-4o" size="sm" />
        <MenuContent>
          <MenuItem
            icon={Trash2}
            danger
            onSelect={() => confirm.ask({ title: "Remove gpt-4o from fast?", body: "Undo puts it back.", confirmLabel: "Remove model", onConfirm: onRemove })}
          >
            Remove…
          </MenuItem>
          {onRevoke && (
            <MenuItem
              danger
              onSelect={() => confirm.ask({ title: "Revoke zeron?", body: "Can't be undone.", confirmLabel: "Revoke key", typeToConfirm: "zeron", onConfirm: onRevoke })}
            >
              Revoke…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {confirm.dialog}
    </>
  );
}

test("useConfirm asks from a danger menu item; Escape cancels and focus returns to the menu's trigger", async () => {
  const user = userEvent.setup();
  const onRemove = vi.fn();
  render(<PoolMenu onRemove={onRemove} />);
  const trigger = screen.getByRole("button", { name: "More for gpt-4o" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const item = await screen.findByRole("menuitem", { name: "Remove…" });
  expect(item.hasAttribute("data-destructive")).toBe(true);
  await user.keyboard("{Enter}");
  await screen.findByRole("alertdialog", { name: "Remove gpt-4o from fast?" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(onRemove).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});

test("typeToConfirm asks for the name before a revoke", async () => {
  const user = userEvent.setup();
  const onRevoke = vi.fn();
  render(<PoolMenu onRemove={() => {}} onRevoke={onRevoke} />);
  await user.click(screen.getByRole("button", { name: "More for gpt-4o" }));
  await user.click(await screen.findByRole("menuitem", { name: "Revoke…" }));
  const field = await screen.findByRole("textbox", { name: "Type zeron to confirm" });
  const confirm = screen.getByRole("button", { name: "Revoke key" });
  expect(confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true").toBe(true);
  await user.type(field, "zeron{Enter}");
  await waitFor(() => expect(onRevoke).toHaveBeenCalledOnce());
});

test("the danger tone: Button and IconButton are marked and use the danger tokens; the solid red stays for the confirm button", async () => {
  render(
    <>
      <Button danger>Delete</Button>
      <Button variant="ghost" danger>
        Remove
      </Button>
      <IconButton icon={Trash2} label="Delete row" danger />
      <Button>Save</Button>
    </>,
  );
  const del = screen.getByRole("button", { name: "Delete" });
  expect(del.getAttribute("data-danger")).toBe("true");
  expect(del.className).toContain("text-danger-text");
  expect(del.className).toContain("border-danger");
  expect(del.className).not.toContain("bg-danger ");
  expect(screen.getByRole("button", { name: "Remove" }).className).toContain("hover:bg-danger-tint");
  const icon = screen.getByRole("button", { name: "Delete row" });
  expect(icon.getAttribute("data-danger")).toBe("true");
  expect(icon.className).toContain("hover:text-danger-text");
  expect(icon.className).toContain("focus-visible:text-danger-text");
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("data-danger")).toBe(false);
});

test('danger="hover" keeps a repeated row action neutral at rest and red on hover and focus', () => {
  render(<Button danger="hover">Revert…</Button>);
  const b = screen.getByRole("button", { name: "Revert…" });
  expect(b.getAttribute("data-danger")).toBe("hover");
  expect(b.className).toContain("text-fg ");
  expect(b.className).toContain("hover:text-danger-text");
  expect(b.className).toContain("focus-visible:text-danger-text");
});

test("an agent finds the named danger trigger, and confirming the removal needs a person", async () => {
  const onConfirm = vi.fn();
  render(
    <ConfirmAction title="Remove gpt-4o from fast?" body="Undo puts it back." confirmLabel="Remove model" onConfirm={onConfirm}>
      <IconButton icon={Trash2} label="Remove gpt-4o" danger />
    </ConfirmAction>,
  );
  const names = agent.snapshot().filter((e) => !e.offPage).map((e) => e.label);
  expect(names).toContain("Remove gpt-4o");
  expect((await agent.act({ steps: [{ ref: "Remove gpt-4o", action: "press" }] })).ok).toBe(true);
  await screen.findByRole("alertdialog", { name: "Remove gpt-4o from fast?" });
  for (const entry of agent.snapshot().filter((e) => !e.offPage && e.component !== "more")) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const remove = { steps: [{ ref: "Remove gpt-4o from fast?", action: "press", args: ["Remove model"] }] };
  expect((await agent.act(remove)).ok).toBe(false);
  expect(onConfirm).not.toHaveBeenCalled();
  approve = true;
  const done = await agent.act(remove);
  expect(done.ok, done.error?.message).toBe(true);
  await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
});
