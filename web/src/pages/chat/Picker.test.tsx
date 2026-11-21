import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { popupMotionClass } from "@/ui/popup";
import { DEFAULT_SETTINGS, type Settings } from "./api";
import { createPickerController, PickerPopover, PickerTrigger, type View } from "./Picker";

const agent = createAgent();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let modelSearches: URL[] = [];
beforeEach(() => {
  modelSearches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/test/models") {
        modelSearches.push(u);
        const q = u.searchParams.get("q") ?? "";
        const models = [
          { id: "openai/gpt-4o", model: "gpt-4o", context_length: 128000 },
          { id: "openai/o3", model: "o3", context_length: 200000 },
        ].filter((m) => m.id.includes(q));
        const zai = [{ id: "zai/glm-4.6", model: "glm-4.6" }].filter((m) => m.id.includes(q));
        const pools = [{ id: "glm-4.6", model: "glm-4.6" }].filter((m) => m.id.includes(q));
        const providers = [
          ...(models.length ? [{ provider: "openai", matched: models.length, models }] : []),
          ...(zai.length ? [{ provider: "zai", matched: zai.length, models: zai }] : []),
        ];
        return json({ total: 4, matched: models.length + zai.length + pools.length, pools, providers, truncated: false });
      }
      if (u.pathname === "/api/providers/openai/keys")
        return json({ upstream_keys: [{ id: "k1", name: "team-5", state: { state: "active" } }] });
      if (u.pathname === "/api/gateway-keys") return json({ gateway_keys: [{ id: "g1", name: "linh", scope: { all: true } }] });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

let latest: Settings;
function Composer({ start }: { start: Settings }) {
  const [settings, setSettings] = useState(start);
  const [picker] = useState(createPickerController);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  latest = settings;
  const view: View = settings.model ? "main" : "models";
  return (
    <div ref={setAnchor}>
      <PickerTrigger controller={picker} payload={view} aria-label={settings.model ? `Model ${settings.model}. Settings` : "Pick a model"}>
        {settings.model || "Pick a model"}
      </PickerTrigger>
      <PickerPopover controller={picker} anchor={anchor} settings={settings} onChange={(p) => setSettings((s) => ({ ...s, ...p }))} />
    </div>
  );
}

function renderComposer(start: Settings = DEFAULT_SETTINGS) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Composer start={start} />
    </QueryClientProvider>,
  );
}

test("with no model, the button opens the model search; arrows and Enter pick one, then the settings show", async () => {
  const user = userEvent.setup();
  renderComposer();
  await user.click(screen.getByRole("button", { name: "Pick a model" }));
  const popover = await screen.findByRole("dialog", { name: "Model and settings" });
  const search = within(popover).getByRole("combobox", { name: "Search models" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  await user.type(search, "o3");
  await within(popover).findByRole("option", { name: /^o3/ });
  await waitFor(() => expect(within(popover).queryByRole("option", { name: /gpt-4o/ })).toBeNull());
  expect(within(popover).getAllByRole("option")[0].textContent).toContain("Use “o3”");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(latest.model).toBe("openai/o3");
  await within(popover).findByRole("button", { name: /Shape/ });
});

const groupNames = (popover: HTMLElement) =>
  within(popover)
    .getAllByRole("group")
    .map((g) => {
      const label = document.getElementById(g.getAttribute("aria-labelledby") ?? "")!.cloneNode(true) as HTMLElement;
      label.querySelectorAll("[aria-hidden], .tabular").forEach((n) => n.remove());
      return label.textContent?.trim();
    });

test("with a Provider's model picked, its models come first under its name, then Pools and the rest; search filters both", async () => {
  const user = userEvent.setup();
  renderComposer({ ...DEFAULT_SETTINGS, model: "zai/glm-4.6" });
  await user.click(screen.getByRole("button", { name: "Model zai/glm-4.6. Settings" }));
  const popover = await screen.findByRole("dialog", { name: "Model and settings" });
  await user.click(within(popover).getByRole("button", { name: /glm-4.6/ }));
  await within(popover).findByRole("option", { name: /gpt-4o/ });
  expect(groupNames(popover)).toEqual(["zai", "Model Pools", "openai"]);
  expect(modelSearches.at(-1)?.searchParams.get("prefer")).toBe("zai/");
  await user.type(within(popover).getByRole("combobox", { name: "Search models" }), "glm");
  await waitFor(() => expect(within(popover).queryByRole("option", { name: /gpt-4o/ })).toBeNull());
  expect(groupNames(popover)).toEqual(["zai", "Model Pools"]);
  await user.click(within(popover).getAllByRole("option", { name: /glm-4.6/ })[1]);
  expect(latest.model).toBe("glm-4.6");
});

test("with a Pool picked, the search asks for that Pool first and Pools lead", async () => {
  const user = userEvent.setup();
  renderComposer({ ...DEFAULT_SETTINGS, model: "glm-4.6" });
  await user.click(screen.getByRole("button", { name: "Model glm-4.6. Settings" }));
  const popover = await screen.findByRole("dialog", { name: "Model and settings" });
  await user.click(within(popover).getByRole("button", { name: /glm-4.6/ }));
  await within(popover).findByRole("option", { name: /gpt-4o/ });
  expect(modelSearches.at(-1)?.searchParams.get("prefer")).toBe("glm-4.6");
  expect(groupNames(popover)).toEqual(["Model Pools", "openai", "zai"]);
});

test("a settings row opens its list; Escape there goes back, Escape again closes and focus returns", async () => {
  const user = userEvent.setup();
  renderComposer({ ...DEFAULT_SETTINGS, model: "openai/o3" });
  const trigger = screen.getByRole("button", { name: "Model openai/o3. Settings" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const popover = await screen.findByRole("dialog", { name: "Model and settings" });
  await user.click(within(popover).getByRole("button", { name: /Shape/ }));
  const shapes = await within(popover).findByRole("listbox", { name: "Shape" });
  await user.click(within(shapes).getByRole("option", { name: "Anthropic Messages" }));
  expect(latest.shape).toBe("anthropic-messages");
  await user.click(await within(popover).findByRole("button", { name: /Shape/ }));
  await within(popover).findByRole("listbox", { name: "Shape" });
  await user.keyboard("{Escape}");
  await within(popover).findByRole("button", { name: /Shape/ });
  expect(screen.getByRole("dialog", { name: "Model and settings" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("an agent reads the picker by names and changes its settings", async () => {
  const user = userEvent.setup();
  renderComposer({ ...DEFAULT_SETTINGS, model: "openai/o3" });
  await user.click(screen.getByRole("button", { name: "Model openai/o3. Settings" }));
  await screen.findByRole("dialog", { name: "Model and settings" });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const run = await agent.act({
    steps: [{ ref: "Reasoning", action: "setValue", args: ["high"] }],
  });
  expect(run.ok, run.error?.message).toBe(true);
  expect(latest.reasoning).toBe("high");
});

test("an agent opens a settings row by its name: the rows and the model are UI SDK buttons", async () => {
  const user = userEvent.setup();
  renderComposer({ ...DEFAULT_SETTINGS, model: "openai/o3" });
  await user.click(screen.getByRole("button", { name: "Model openai/o3. Settings" }));
  const popover = await screen.findByRole("dialog", { name: "Model and settings" });
  const labels = agent.snapshot().map((e) => e.label);
  for (const l of ["Shape OpenAI Chat", "Send as Owner", "Change the model: o3 on openai"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Shape OpenAI Chat", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await within(popover).findByRole("listbox", { name: "Shape" });
});

test("the popover grows from the composer on the shared popup recipe (ui/popup.ts)", async () => {
  const user = userEvent.setup();
  renderComposer({ ...DEFAULT_SETTINGS, model: "openai/o3" });
  await user.click(screen.getByRole("button", { name: "Model openai/o3. Settings" }));
  const popover = await screen.findByRole("dialog", { name: "Model and settings" });
  const classes = popover.className.split(/\s+/);
  for (const c of popupMotionClass.split(/\s+/)) expect(classes).toContain(c);
});
