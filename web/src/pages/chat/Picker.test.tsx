import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "./api";
import { createPickerController, PickerPopover, PickerTrigger, type View } from "./Picker";

const agent = createAgent();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/test/models") {
        const q = u.searchParams.get("q") ?? "";
        const models = [
          { id: "openai/gpt-4o", model: "gpt-4o", context_length: 128000 },
          { id: "openai/o3", model: "o3", context_length: 200000 },
        ].filter((m) => m.id.includes(q));
        const pools = [{ id: "glm-4.6", model: "glm-4.6" }].filter((m) => m.id.includes(q));
        return json({ total: 3, matched: models.length + pools.length, pools, providers: models.length ? [{ provider: "openai", matched: models.length, models }] : [], truncated: false });
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
  // First comes the typed ID itself, then the matches.
  expect(within(popover).getAllByRole("option")[0].textContent).toContain("Use “o3”");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(latest.model).toBe("openai/o3");
  // Back on the settings list, still open.
  await within(popover).findByRole("button", { name: /Shape/ });
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
  // Scroll areas are not controls; everything else needs a name.
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const run = await agent.act({
    steps: [
      { ref: "Reasoning", action: "setValue", args: ["high"] },
      { ref: "Check tool calls", action: "setChecked", args: [true] },
    ],
  });
  expect(run.ok, run.error?.message).toBe(true);
  expect(latest.reasoning).toBe("high");
  expect(latest.toolCheck).toBe(true);
});
