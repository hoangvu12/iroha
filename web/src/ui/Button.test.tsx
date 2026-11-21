import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { Plus, Trash2 } from "lucide-react";
import { expect, test, vi } from "vitest";
import { Button, IconButton, buttonClass } from "./Button";

const agent = createAgent();

test("Button is UI SDK's button, named by its text and not a submit button by default", () => {
  render(<Button icon={Plus}>Add key</Button>);
  const button = screen.getByRole("button", { name: "Add key" });
  expect(button.getAttribute("data-slot")).toBe("button");
  expect(button.getAttribute("type")).toBe("button");
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(button.hasAttribute("aria-disabled")).toBe(false);
  expect(button.querySelector("svg")).not.toBeNull();
});

test("Button keeps the look of its variant and size", () => {
  render(
    <>
      <Button variant="primary" size="lg">
        Save
      </Button>
      <Button variant="danger" size="sm">
        Delete
      </Button>
      <Button>Cancel</Button>
    </>,
  );
  const save = screen.getByRole("button", { name: "Save" });
  expect(save.className).toContain("bg-primary");
  expect(save.className).toContain("h-11");
  const del = screen.getByRole("button", { name: "Delete" });
  expect(del.className).toContain("bg-danger");
  expect(del.className).toContain("h-8");
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(cancel.className).toContain("border-border-strong");
  expect(cancel.className).toContain("h-9");
  expect(buttonClass("primary", "md")).toContain("bg-primary");
});

test("a click, Enter and Space run onClick; type=submit submits its form", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <Button onClick={onClick}>Run</Button>
      <Button type="submit">Send</Button>
    </form>,
  );
  await user.click(screen.getByRole("button", { name: "Run" }));
  screen.getByRole("button", { name: "Run" }).focus();
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  expect(onClick).toHaveBeenCalledTimes(3);
  expect(onSubmit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("loading makes the button busy and unpressable; disabled is unpressable", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  const { rerender } = render(
    <Button loading onClick={onClick}>
      Sign in
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Sign in" });
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.hasAttribute("data-disabled")).toBe(true);
  await user.click(button);
  rerender(
    <Button disabled onClick={onClick}>
      Sign in
    </Button>,
  );
  expect(button.hasAttribute("aria-busy")).toBe(false);
  await user.click(button);
  expect(onClick).not.toHaveBeenCalled();
});

test("buttons, icon buttons and button-styled links press down with the motion tokens, unless disabled or pending", () => {
  render(
    <>
      <Button>Save</Button>
      <IconButton icon={Trash2} label="Delete key" />
    </>,
  );
  for (const cls of [
    screen.getByRole("button", { name: "Save" }).className,
    screen.getByRole("button", { name: "Delete key" }).className,
    buttonClass("primary"),
  ]) {
    const classes = cls.split(" ");
    expect(classes).toContain("press");
    const others = classes.filter((c) => /^(transition|duration-|ease-)/.test(c));
    expect(others, "press owns the transition").toEqual([]);
  }
});

test("IconButton is named by its label", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(<IconButton icon={Trash2} label="Delete key" onClick={onClick} />);
  const button = screen.getByRole("button", { name: "Delete key" });
  expect(button.getAttribute("data-slot")).toBe("button");
  expect(button.getAttribute("type")).toBe("button");
  await user.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});

test("an agent finds Button and IconButton by name and presses them", async () => {
  const save = vi.fn();
  const remove = vi.fn();
  render(
    <>
      <Button variant="primary" onClick={save}>
        Save changes
      </Button>
      <IconButton icon={Trash2} label="Delete key" onClick={remove} />
    </>,
  );
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  expect(labels).toContain("Save changes");
  expect(labels).toContain("Delete key");

  const result = await agent.act({
    steps: [
      { ref: "Save changes", action: "press" },
      { ref: "Delete key", action: "press" },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  expect(save).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
});
