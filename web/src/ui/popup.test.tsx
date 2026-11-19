import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { expect, test } from "vitest";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Menu, MenuContent, MenuIconTrigger, MenuItem } from "./Menu";
import { popupOpen } from "./popup";
import { Tip } from "./Tooltip";

test("popupOpen is true only while a menu or dialog is open, not for a tooltip kept in the page", async () => {
  const user = userEvent.setup();
  function Page() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Tip label="Shown on hover">
          <Button>Hover me</Button>
        </Tip>
        <Menu>
          <MenuIconTrigger icon={MoreHorizontal} label="More for x" />
          <MenuContent>
            <MenuItem onSelect={() => setOpen(true)}>Edit</MenuItem>
          </MenuContent>
        </Menu>
        <Dialog open={open} onOpenChange={setOpen} title="Edit x" />
      </>
    );
  }
  render(<Page />);
  expect(popupOpen()).toBe(false);
  await user.click(screen.getByRole("button", { name: "More for x" }));
  expect(popupOpen()).toBe(true);
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await screen.findByRole("dialog", { name: "Edit x" });
  expect(popupOpen()).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(popupOpen()).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "More for x" }));
});
