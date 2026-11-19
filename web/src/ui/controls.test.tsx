import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { Autocomplete } from "./Autocomplete";
import { Checkbox } from "./Checkbox";
import { Field } from "./Input";
import { RadioCards } from "./Radio";
import { Segmented } from "./Segmented";
import { Select } from "./Select";
import { Switch } from "./Switch";

const agent = createAgent();

function Controlled() {
  const [on, setOn] = useState(false);
  const [tick, setTick] = useState<boolean | "mixed">("mixed");
  const [filter, setFilter] = useState<"all" | "gaps">("all");
  const [shape, setShape] = useState("openai");
  const [access, setAccess] = useState("all");
  return (
    <div>
      <output data-testid="state">{JSON.stringify({ on, tick, filter, shape, access })}</output>
      <Switch label="Capture prompts" checked={on} onChange={setOn} />
      <Checkbox label="Select every key" checked={tick} onChange={setTick} />
      <Segmented<"all" | "gaps">
        label="Show models"
        value={filter}
        onChange={setFilter}
        items={[
          { value: "all", label: "All" },
          { value: "gaps", label: "With Model Gaps" },
        ]}
      />
      <Field label="Endpoint shape">
        {() => (
          <Select
            value={shape}
            onValueChange={setShape}
            items={[
              { value: "openai", label: "OpenAI Chat Completions" },
              { value: "anthropic", label: "Anthropic Messages" },
            ]}
          />
        )}
      </Field>
      <RadioCards
        label="Access"
        value={access}
        onValueChange={setAccess}
        options={[
          { value: "all", title: "Everything", description: "Every Provider" },
          { value: "some", title: "Only some", description: "Pick them" },
        ]}
      />
    </div>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent!);

test("Switch and Checkbox are UI SDK parts, named by their label, toggled by click and Space", async () => {
  const user = userEvent.setup();
  render(<Controlled />);
  const sw = screen.getByRole("switch", { name: "Capture prompts" });
  expect(sw.getAttribute("data-slot")).toBe("switch");
  await user.click(sw);
  expect(state().on).toBe(true);
  expect(sw.hasAttribute("data-checked")).toBe(true);
  sw.focus();
  await user.keyboard(" ");
  expect(state().on).toBe(false);

  const box = screen.getByRole("checkbox", { name: "Select every key" });
  expect(box.getAttribute("aria-checked")).toBe("mixed");
  await user.click(box);
  expect(state().tick).toBe(true);
  box.focus();
  await user.keyboard(" ");
  expect(state().tick).toBe(false);
});

test("a press on Switch or Checkbox does not reach a clickable row around it", async () => {
  const user = userEvent.setup();
  const row = vi.fn();
  const change = vi.fn();
  render(
    <div onClick={row}>
      <Switch label="Enable team-5" checked={false} onChange={change} />
      <Checkbox label="Select team-5" checked={false} onChange={change} />
    </div>,
  );
  await user.click(screen.getByRole("switch", { name: "Enable team-5" }));
  await user.click(screen.getByRole("checkbox", { name: "Select team-5" }));
  expect(change).toHaveBeenCalledTimes(2);
  expect(row).not.toHaveBeenCalled();
});

test("Switch moves on the motion tokens: the thumb slides on press timing, the track colours on hover timing (UI ticket 20)", () => {
  render(<Switch label="Capture prompts" checked={false} onChange={() => {}} />);
  const track = screen.getByRole("switch", { name: "Capture prompts" });
  const thumb = track.querySelector("[data-slot=switch-thumb]")!;
  const classes = (el: Element) => el.getAttribute("class")!.split(/\s+/);
  for (const k of ["transition-[translate]", "duration-press", "ease-out"]) expect(classes(thumb)).toContain(k);
  for (const k of ["transition-colors", "duration-hover", "ease-[ease]"]) expect(classes(track)).toContain(k);
  // The tokens hold the thumb still under reduced motion (press is 0) and keep the colour fade.
  for (const el of [track, thumb]) expect(classes(el).filter((c) => c === "transition-transform" || c === "motion-reduce:transition-none" || /^duration-\d/.test(c))).toEqual([]);
});

test("Segmented is a radio group: arrows move the choice", async () => {
  const user = userEvent.setup();
  render(<Controlled />);
  const group = screen.getByRole("radiogroup", { name: "Show models" });
  expect(group.getAttribute("data-slot")).toBe("segmented-control");
  const all = screen.getByRole("radio", { name: "All" });
  expect(all.getAttribute("aria-checked")).toBe("true");
  await user.click(screen.getByRole("radio", { name: "With Model Gaps" }));
  expect(state().filter).toBe("gaps");
  await user.keyboard("{ArrowLeft}");
  expect(state().filter).toBe("all");
});

test("Select takes its Field's label, shows the chosen label and picks by keyboard", async () => {
  const user = userEvent.setup();
  render(<Controlled />);
  const trigger = screen.getByRole("combobox", { name: "Endpoint shape" });
  expect(trigger.textContent).toContain("OpenAI Chat Completions");
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("listbox");
  await user.click(screen.getByRole("option", { name: "Anthropic Messages" }));
  expect(state().shape).toBe("anthropic");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toContain("Anthropic Messages");
});

test("RadioCards is a radio group of titled options with descriptions", async () => {
  const user = userEvent.setup();
  render(<Controlled />);
  const group = screen.getByRole("radiogroup", { name: "Access" });
  expect(group.getAttribute("data-slot")).toBe("radio-group");
  const some = screen.getByRole("radio", { name: "Only some" });
  expect(some.getAttribute("aria-describedby")).toBeTruthy();
  await user.click(screen.getByText("Pick them"));
  expect(state().access).toBe("some");
});

test("an agent finds and changes every control", async () => {
  render(<Controlled />);
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const label of ["Capture prompts", "Select every key", "Show models", "Endpoint shape", "Access"]) expect(labels).toContain(label);
  const result = await agent.act({
    steps: [
      { ref: "Capture prompts", action: "setChecked", args: [true] },
      { ref: "Select every key", action: "setChecked", args: [true] },
      { ref: "Show models", action: "setValue", args: ["gaps"] },
      { ref: "Endpoint shape", action: "setValue", args: ["anthropic"] },
      { ref: "Access", action: "setValue", args: ["some"] },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  expect(state()).toEqual({ on: true, tick: true, filter: "gaps", shape: "anthropic", access: "some" });
});

test("Autocomplete takes its Field's label, suggests as you type and keeps text not in the list", async () => {
  const user = userEvent.setup();
  function Model() {
    const [model, setModel] = useState("");
    return (
      <>
        <Field label="Model">{() => <Autocomplete value={model} onValueChange={setModel} items={["glm-4.6", "glm-4.5-air", "qwen3-max"]} />}</Field>
        <output>{model}</output>
      </>
    );
  }
  render(<Model />);
  const input = screen.getByRole("combobox", { name: "Model" });
  await user.type(input, "glm");
  await screen.findByRole("option", { name: "glm-4.5-air" });
  expect(screen.queryByRole("option", { name: "qwen3-max" })).toBeNull();
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(document.querySelector("output")!.textContent).toBe("glm-4.5-air");
  await user.clear(input);
  await user.type(input, "glm-5{Escape}");
  expect(document.querySelector("output")!.textContent).toBe("glm-5");
});
