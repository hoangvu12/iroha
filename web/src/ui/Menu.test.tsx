import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { COPIED_MS, useCopy } from "./CopyButton";
import { Menu, MenuCheckboxItem, MenuContent, MenuIconTrigger, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, SubMenu } from "./Menu";

const agent = createAgent();

function RowMenu({ name, onRename, onDelete }: { name: string; onRename: () => void; onDelete: () => void }) {
  return (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label={`More for ${name}`} size="sm" />
      <MenuContent>
        <MenuItem onSelect={onRename}>Rename</MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={onDelete}>
          Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

test("a row menu opens from its named icon trigger, runs an item, closes and returns focus", async () => {
  const user = userEvent.setup();
  const onRename = vi.fn();
  const onDelete = vi.fn();
  render(<RowMenu name="team-5" onRename={onRename} onDelete={onDelete} />);
  const trigger = screen.getByRole("button", { name: "More for team-5" });
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  expect(menu.getAttribute("data-slot")).toBe("menu-content");
  expect(screen.getByRole("menuitem", { name: "Delete" }).hasAttribute("data-destructive")).toBe(true);
  await user.click(screen.getByRole("menuitem", { name: "Rename" }));
  expect(onRename).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("keyboard: Enter opens, arrows move, Enter runs, Escape closes back to the trigger", async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn();
  render(<RowMenu name="team-5" onRename={() => {}} onDelete={onDelete} />);
  const trigger = screen.getByRole("button", { name: "More for team-5" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" })));
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(onDelete).not.toHaveBeenCalled();

  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onDelete).toHaveBeenCalledOnce();
});

test("radio items choose one value and close; checkbox items toggle and stay open; submenus open with ArrowRight", async () => {
  const user = userEvent.setup();
  function Filters() {
    const [theme, setTheme] = useState("system");
    const [cols, setCols] = useState({ key: true });
    return (
      <>
        <output>{theme}</output>
        <Menu>
          <MenuIconTrigger icon={MoreHorizontal} label="View options" />
          <MenuContent>
            <MenuRadioGroup label="Theme" value={theme} onValueChange={setTheme}>
              <MenuRadioItem value="system">System</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
            </MenuRadioGroup>
            <MenuCheckboxItem value="key" checked={cols.key} onCheckedChange={(v) => setCols({ key: v })}>
              Upstream Key
            </MenuCheckboxItem>
            <SubMenu label="Status" value="Any">
              <MenuItem onSelect={() => setTheme("failed")}>Failed</MenuItem>
            </SubMenu>
          </MenuContent>
        </Menu>
      </>
    );
  }
  render(<Filters />);
  await user.click(screen.getByRole("button", { name: "View options" }));
  expect(screen.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
  const col = screen.getByRole("menuitemcheckbox", { name: "Upstream Key" });
  await user.click(col);
  expect(col.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("menu")).toBeTruthy();
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(screen.getByText("dark")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

  screen.getByRole("button", { name: "View options" }).focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await user.keyboard("{End}");
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Status/ }));
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Failed" })));
  await user.keyboard("{Enter}");
  expect(screen.getByText("failed")).toBeTruthy();
});

function StatusMenu() {
  return (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label="Filter" />
      <MenuContent>
        <SubMenu label="Status" value="Any">
          <MenuItem onSelect={() => {}}>Failed</MenuItem>
        </SubMenu>
      </MenuContent>
    </Menu>
  );
}

async function openStatus() {
  const user = userEvent.setup();
  render(<StatusMenu />);
  await user.click(screen.getByRole("button", { name: "Filter" }));
  await user.click(await screen.findByRole("menuitem", { name: /Status/ }));
  const failed = await screen.findByRole("menuitem", { name: "Failed" });
  return failed.closest<HTMLElement>("[data-side]")!;
}

test("on a wide screen a submenu opens beside its item", async () => {
  expect((await openStatus()).getAttribute("data-side")).toBe("right");
});

test("on a phone a submenu opens under its item, where it can shift to stay on screen (there's no room beside the menu)", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 767px)", media: q, addEventListener() {}, removeEventListener() {} }));
  try {
    expect((await openStatus()).getAttribute("data-side")).toBe("bottom");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a copy from a menu item shows on the trigger the menu closes back to, keeping its name", async () => {
  const user = userEvent.setup();
  function CopyMenu() {
    const copied = useCopy();
    return (
      <Menu>
        <MenuIconTrigger icon={MoreHorizontal} label="More for team-5" copy={copied.state} />
        <MenuContent>
          <MenuItem onSelect={() => void copied.copy("sk-team-5", "Key")}>Copy key</MenuItem>
        </MenuContent>
      </Menu>
    );
  }
  render(<CopyMenu />);
  const trigger = screen.getByRole("button", { name: "More for team-5" });
  expect(trigger.hasAttribute("data-copy")).toBe(false);
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Copy key" }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(await navigator.clipboard.readText()).toBe("sk-team-5");
  expect(document.activeElement).toBe(trigger);
  await waitFor(() => expect(trigger.getAttribute("data-copy")).toBe("copied"));
  expect(trigger.querySelector("svg.text-success")).not.toBeNull();
  expect(screen.getByRole("button", { name: "More for team-5" })).toBe(trigger);
  await waitFor(() => expect(trigger.hasAttribute("data-copy")).toBe(false), { timeout: COPIED_MS + 500 });
});

test("an agent finds each row's menu by its row name and runs an item", async () => {
  const deleteA = vi.fn();
  const deleteB = vi.fn();
  render(
    <>
      <RowMenu name="alpha" onRename={() => {}} onDelete={deleteA} />
      <RowMenu name="beta" onRename={() => {}} onDelete={deleteB} />
    </>,
  );
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  expect(labels).toContain("More for alpha");
  expect(labels).toContain("More for beta");
  const result = await agent.act({ steps: [{ ref: "More for beta", action: "press", args: ["Delete"] }] });
  expect(result.ok, result.error?.message).toBe(true);
  expect(deleteB).toHaveBeenCalledOnce();
  expect(deleteA).not.toHaveBeenCalled();
});
