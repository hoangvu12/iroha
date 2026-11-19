import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@ui-sdk/react/toast";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { Autocomplete } from "./Autocomplete";
import { Button } from "./Button";
import { ConfirmDialog, Dialog } from "./Dialog";
import { Field } from "./Input";
import { Menu, MenuContent, MenuIconTrigger, MenuItem, SubMenu } from "./Menu";
import { Select } from "./Select";
import { notify, Toaster } from "./toast";
import { Tip } from "./Tooltip";

// Motion of the popups (UI ticket 14): every one takes its durations, curve,
// scale and distance from the motion tokens (architecture.md "UI motion
// system"), exits faster than it enters, and plays as a plain fade under
// reduced motion because the tokens zero its scale and distance. jsdom has no
// Tailwind, so this reads the classes on the real markup.

afterEach(() => {
  act(() => void toast.dismiss());
});

const classesOf = (el: Element) => el.getAttribute("class")!.split(/\s+/);

// No typed numbers: `duration-150`, `scale-96`, `ease-[cubic-bezier(...)]` (`duration-0`, no motion, is fine).
function expectOnlyTokens(el: Element) {
  const typed = classesOf(el).filter((c) => /(^|:)(duration-[1-9]|scale-\d|ease-\[cubic)/.test(c));
  expect(typed, `${el.getAttribute("data-slot")} has typed motion values`).toEqual([]);
  // The tokens already hold movement still under reduced motion and keep the fade.
  expect(classesOf(el)).not.toContain("motion-reduce:transition-none");
}

function expectPopupFromTrigger(el: Element, enter: string, exit: string) {
  const c = classesOf(el);
  expect(c).toContain("origin-(--transform-origin)");
  expect(c).toContain("transition-[opacity,scale]");
  expect(c).toContain(`duration-${enter}`);
  expect(c).toContain("ease-out");
  for (const state of ["data-starting-style", "data-ending-style"]) {
    expect(c).toContain(`${state}:scale-(--motion-scale-popup)`);
    expect(c).toContain(`${state}:opacity-0`);
  }
  if (exit !== enter) expect(c).toContain(`data-ending-style:duration-${exit}`);
  expectOnlyTokens(el);
}

describe("popups from a trigger", () => {
  test("a menu and its submenu grow from the trigger, 180 ms in and 120 ms out", async () => {
    const user = userEvent.setup();
    render(
      <Menu>
        <MenuIconTrigger icon={MoreHorizontal} label="More for team-5" />
        <MenuContent>
          <MenuItem>Edit</MenuItem>
          <SubMenu label="Move to">
            <MenuItem>fast</MenuItem>
          </SubMenu>
        </MenuContent>
      </Menu>,
    );
    await user.click(screen.getByRole("button", { name: "More for team-5" }));
    const menu = await screen.findByRole("menu");
    expectPopupFromTrigger(menu, "popup-in", "popup-out");
    await user.click(screen.getByRole("menuitem", { name: "Move to" }));
    const sub = await screen.findByRole("menuitem", { name: "fast" });
    const subMenu = sub.closest("[role=menu]")!;
    expect(subMenu).not.toBe(menu);
    expectPopupFromTrigger(subMenu, "popup-in", "popup-out");
  });

  test("a select's list and an autocomplete's suggestions use the same popup motion", async () => {
    const user = userEvent.setup();
    function Both() {
      const [shape, setShape] = useState("openai");
      const [model, setModel] = useState("");
      return (
        <>
          <Select
            aria-label="Endpoint shape"
            value={shape}
            onValueChange={setShape}
            items={[
              { value: "openai", label: "OpenAI Chat Completions" },
              { value: "anthropic", label: "Anthropic Messages" },
            ]}
          />
          <Field label="Model">{() => <Autocomplete value={model} onValueChange={setModel} items={["gpt-4o", "gpt-4o-mini"]} />}</Field>
        </>
      );
    }
    render(<Both />);
    await user.click(screen.getByRole("combobox", { name: "Endpoint shape" }));
    const list = await screen.findByRole("listbox");
    expectPopupFromTrigger(list.closest("[data-slot=select-content]") ?? list, "popup-in", "popup-out");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());

    await user.type(screen.getByRole("combobox", { name: "Model" }), "gpt");
    const option = await screen.findByRole("option", { name: "gpt-4o" });
    expectPopupFromTrigger(option.closest("[data-slot=autocomplete-content]")!, "popup-in", "popup-out");
  });

  test("a tooltip grows from its trigger in 125 ms, and the next one in a row shows at once", async () => {
    render(
      <Tip label="Copy the key">
        <Button>Copy</Button>
      </Tip>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Copy" }));
    const tip = await screen.findByText("Copy the key");
    const content = tip.closest("[data-slot=tooltip-content]") ?? tip;
    expectPopupFromTrigger(content, "tooltip", "tooltip");
    expect(classesOf(content)).toContain("data-instant:duration-0");
  });
});

describe("dialogs", () => {
  function Opener({ alert }: { alert?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open it</Button>
        {alert ? (
          <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete rule?" body="Gone." confirmLabel="Delete rule" onConfirm={() => new Promise(() => {})} />
        ) : (
          <Dialog open={open} onOpenChange={setOpen} title="Edit endpoint">
            <p>Body</p>
          </Dialog>
        )}
      </>
    );
  }

  function expectDialogMotion(content: Element) {
    const c = classesOf(content);
    expect(c, "centred, not from a trigger").not.toContain("origin-(--transform-origin)");
    expect(c).toContain("transition-[opacity,scale]");
    expect(c).toContain("duration-dialog-in");
    expect(c).toContain("ease-out");
    for (const state of ["data-starting-style", "data-ending-style"]) {
      expect(c).toContain(`${state}:scale-(--motion-scale-popup)`);
      expect(c).toContain(`${state}:opacity-0`);
    }
    expect(c).toContain("data-ending-style:duration-dialog-out");
    expectOnlyTokens(content);
    const backdrop = document.querySelector("[data-slot$=dialog-backdrop]")!;
    expect(classesOf(backdrop)).toEqual(expect.arrayContaining(["transition-opacity", "duration-dialog-in", "data-ending-style:duration-dialog-out"]));
    expectOnlyTokens(backdrop);
  }

  test("a dialog grows from the middle in 200 ms and leaves in 150 ms, with its backdrop; its Close presses like every icon button", async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    expectDialogMotion(await screen.findByRole("dialog", { name: "Edit endpoint" }));
    expect(classesOf(screen.getByRole("button", { name: "Close" }))).toContain("duration-press");
  });

  test("an alert dialog moves like a dialog; its confirm button dims at once while it works", async () => {
    const user = userEvent.setup();
    render(<Opener alert />);
    await user.click(screen.getByRole("button", { name: "Open it" }));
    expectDialogMotion(await screen.findByRole("alertdialog", { name: "Delete rule?" }));
    const confirm = screen.getByRole("button", { name: "Delete rule" });
    expect(classesOf(confirm)).toContain("data-pending:opacity-70");
    await user.click(confirm);
    expect(confirm.hasAttribute("data-pending")).toBe(true);
  });
});

describe("toasts", () => {
  test("a toast rises from the bottom edge over 400 ms with ease, the stack moving with it; a swiped one leaves the way it was thrown", async () => {
    // (toast.tsx's height transition is UI SDK's toast recipe: --toast-height on an absolutely placed toast, layout stays inside it.)
    render(<Toaster />);
    act(() => void notify.success("3 keys disabled"));
    const el = (await screen.findByText("3 keys disabled")).closest("[data-slot=toast]")!;
    const c = classesOf(el);
    expect(c).toEqual(
      expect.arrayContaining([
        "transition-[translate,opacity,height]",
        "duration-toast",
        "ease-[ease]",
        "data-starting-style:translate-y-(--motion-toast-offset)",
        "data-starting-style:opacity-0",
        "data-ending-style:opacity-0",
        "data-swiping:transition-none",
        // The stack doesn't slide under reduced motion; toasts fade in place.
        "motion-reduce:transition-opacity",
        "motion-safe:data-[swipe-direction=right]:translate-x-full",
      ]),
    );
    // It follows a finger dragging down, and leaves downward when thrown that way.
    expect(c.some((k) => k.startsWith("translate-y-[") && k.includes("--toast-swipe-y"))).toBe(true);
    expect(c.some((k) => k.startsWith("motion-safe:data-[swipe-direction=down]:translate-y-["))).toBe(true);
    expectOnlyTokens(el);

    // The region is transparent and doesn't clip: its height follows the stack at once, no wasted layout per frame.
    const region = el.closest("[data-slot=toast-region]")!;
    expect(classesOf(region).filter((k) => /transition|duration/.test(k))).toEqual([]);
  });
});
