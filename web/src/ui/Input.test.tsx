import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { expect, test, vi } from "vitest";
import { Field, Input, PasswordInput, SearchInput } from "./Input";

const agent = createAgent();

/** The text of the elements aria-describedby points at. */
function description(el: HTMLElement) {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .filter(Boolean)
    .join(" ");
}

function Name({ error, onChange }: { error?: string; onChange?: (v: string) => void }) {
  const [name, setName] = useState("");
  return (
    <Field label="Name" hint="Audit Entries show this name." error={error}>
      {(p) => (
        <Input
          {...p}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            onChange?.(e.target.value);
          }}
        />
      )}
    </Field>
  );
}

test("Field's label names the Input and its hint describes it", () => {
  render(<Name />);
  const input = screen.getByRole("textbox", { name: "Name" });
  expect(input.getAttribute("data-slot")).toBe("input");
  expect(description(input)).toBe("Audit Entries show this name.");
  expect(input.hasAttribute("aria-invalid")).toBe(false);
  expect(input.className).toContain("border-border-strong");
});

test("an error replaces the hint, marks the Input invalid and describes it", () => {
  render(<Name error="Name taken." />);
  const input = screen.getByRole("textbox", { name: "Name" });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(description(input)).toBe("Name taken.");
  expect(screen.getByRole("alert").textContent).toBe("Name taken.");
  expect(screen.queryByText("Audit Entries show this name.")).toBeNull();
});

test("typing in a controlled Input reaches its onChange", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<Name onChange={onChange} />);
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Name" });
  await user.type(input, "linh");
  expect(input.value).toBe("linh");
  expect(onChange).toHaveBeenLastCalledWith("linh");
});

test("clicking the label focuses the Input", async () => {
  const user = userEvent.setup();
  render(<Name />);
  await user.click(screen.getByText("Name"));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
});

test("Field still labels a native control rendered from its children", () => {
  render(
    <Field label="Shape" hint="The API format the URL speaks.">
      {(p) => (
        <select {...p}>
          <option>openai-chat</option>
        </select>
      )}
    </Field>,
  );
  const select = screen.getByRole("combobox", { name: "Shape" });
  expect(description(select)).toBe("The API format the URL speaks.");
});

test("PasswordInput is named by its Field, shows and hides with its toggle", async () => {
  const user = userEvent.setup();
  function Password() {
    const [v, setV] = useState("");
    return (
      <Field label="Password">
        {(p) => <PasswordInput {...p} value={v} onChange={(e) => setV(e.target.value)} />}
      </Field>
    );
  }
  render(<Password />);
  const input = screen.getByLabelText<HTMLInputElement>("Password", { selector: "input" });
  expect(input.type).toBe("password");
  expect(input.closest("[data-slot=password-input]")).not.toBeNull();
  await user.type(input, "hunter22");
  expect(input.value).toBe("hunter22");
  const toggle = screen.getByRole("button", { name: "Show password" });
  await user.click(toggle);
  expect(input.type).toBe("text");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  await user.click(toggle);
  expect(input.type).toBe("password");
});

test("SearchInput is a search box named by its aria-label", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<SearchInput aria-label="Search keys" placeholder="Search" onChange={(e) => onChange(e.target.value)} />);
  const box = screen.getByRole("searchbox", { name: "Search keys" });
  expect(box.getAttribute("data-slot")).toBe("input");
  await user.type(box, "k1");
  expect(onChange).toHaveBeenLastCalledWith("k1");
});

test("an agent finds every field by its label and fills it", async () => {
  function Form() {
    const [name, setName] = useState("");
    const [token, setToken] = useState("");
    const [q, setQ] = useState("");
    return (
      <form>
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Admin Token">
          {(p) => <PasswordInput {...p} value={token} onChange={(e) => setToken(e.target.value)} />}
        </Field>
        <SearchInput aria-label="Search models" value={q} onChange={(e) => setQ(e.target.value)} />
        <output aria-label="Echo">{`${name}|${token.length}|${q}`}</output>
      </form>
    );
  }
  render(<Form />);
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const label of ["Name", "Admin Token", "Search models"]) expect(labels).toContain(label);

  const result = await agent.act({
    steps: [
      { ref: "Name", action: "setValue", args: ["deploy-script"] },
      { ref: "Admin Token", action: "setValue", args: ["iroha_admin_x"] },
      { ref: "Search models", action: "setValue", args: ["glm"] },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  expect(screen.getByRole("status", { name: "Echo" }).textContent).toBe("deploy-script|13|glm");
});
