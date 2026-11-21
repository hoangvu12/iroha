import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { popupMotionClass } from "@/ui/popup";
import { DEFAULT_SETTINGS, migrateLegacySettings, sendBody } from "./api";
import { callAToolChip, ToolsButton } from "./tools";

const agent = createAgent();

const TOOLS = [
  { name: "get_weather", description: "Get the current weather in a city.", parameters: {} },
  { name: "get_time", description: "Get the current date and time in a time zone.", parameters: {} },
  { name: "calculate", description: "Evaluate an arithmetic expression exactly.", parameters: {} },
  { name: "web_search", description: "Search the web and return the top results.", parameters: {} },
];

let toolLists = 0;
beforeEach(() => {
  toolLists = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/test/tools") {
        toolLists++;
        return new Response(JSON.stringify({ tools: TOOLS }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

let latest: string[];
function Composer({ start }: { start: string[] }) {
  const [tools, setTools] = useState(start);
  latest = tools;
  return <ToolsButton tools={tools} onChange={setTools} />;
}

function renderButton(start: string[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Composer start={start} />
    </QueryClientProvider>,
  );
}

test("the button is a wrench with the number of tools on, named by it", () => {
  const { unmount } = renderButton(["get_weather", "calculate"]);
  const button = screen.getByRole("button", { name: "Tools, 2 on" });
  expect(button.textContent).toBe("2");
  expect(button.textContent).not.toContain("Tools");
  unmount();
  renderButton([]);
  const off = screen.getByRole("button", { name: "Tools, off" });
  expect(off.textContent).toBe("");
});

test("the popover lists every tool with its description and a Switch; a Switch turns one on or off, in list order", async () => {
  const user = userEvent.setup();
  renderButton(["calculate"]);
  await user.click(screen.getByRole("button", { name: "Tools, 1 on" }));
  const popover = await screen.findByRole("dialog", { name: "Test tools" });
  for (const t of TOOLS) {
    expect(within(popover).getByText(t.name)).toBeTruthy();
    expect(within(popover).getByText(t.description)).toBeTruthy();
  }
  const weather = within(popover).getByRole("switch", { name: "get_weather" });
  expect(weather.getAttribute("aria-checked")).toBe("false");
  expect(within(popover).getByRole("switch", { name: "calculate" }).getAttribute("aria-checked")).toBe("true");
  await user.click(weather);
  expect(latest).toEqual(["get_weather", "calculate"]);
  await user.click(within(popover).getByRole("switch", { name: "calculate" }));
  expect(latest).toEqual(["get_weather"]);
  expect(screen.getByRole("button", { name: "Tools, 1 on" })).toBeTruthy();
});

test("All on and All off set every tool; the one already true is disabled", async () => {
  const user = userEvent.setup();
  renderButton([]);
  await user.click(screen.getByRole("button", { name: "Tools, off" }));
  const popover = await screen.findByRole("dialog", { name: "Test tools" });
  await within(popover).findByRole("switch", { name: "get_weather" });
  expect(within(popover).getByRole("button", { name: "All off" }).hasAttribute("disabled") || within(popover).getByRole("button", { name: "All off" }).getAttribute("aria-disabled") === "true").toBe(true);
  await user.click(within(popover).getByRole("button", { name: "All on" }));
  expect(latest).toEqual(TOOLS.map((t) => t.name));
  expect(screen.getByRole("button", { name: "Tools, 4 on" })).toBeTruthy();
  await user.click(within(popover).getByRole("button", { name: "All off" }));
  expect(latest).toEqual([]);
});

test("Escape closes the popover and focus returns to the button", async () => {
  const user = userEvent.setup();
  renderButton(["get_time"]);
  const button = screen.getByRole("button", { name: "Tools, 1 on" });
  await user.click(button);
  await screen.findByRole("dialog", { name: "Test tools" });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(button);
});

test("an agent finds the tools by name and switches them", async () => {
  const user = userEvent.setup();
  renderButton([]);
  await user.click(screen.getByRole("button", { name: "Tools, off" }));
  const popover = await screen.findByRole("dialog", { name: "Test tools" });
  await within(popover).findByRole("switch", { name: "web_search" });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const l of ["All on", "All off", "get_weather", "web_search"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({
    steps: [
      { ref: "web_search", action: "setChecked", args: [true] },
      { ref: "get_time", action: "setChecked", args: [true] },
    ],
  });
  expect(run.ok, run.error?.message).toBe(true);
  expect(latest).toEqual(["get_time", "web_search"]);
});

test("the popover grows from the button on the shared popup recipe (ui/popup.ts)", async () => {
  const user = userEvent.setup();
  renderButton([]);
  await user.click(screen.getByRole("button", { name: "Tools, off" }));
  const popover = await screen.findByRole("dialog", { name: "Test tools" });
  const classes = popover.className.split(/\s+/);
  for (const c of popupMotionClass.split(/\s+/)) expect(classes).toContain(c);
  expect(toolLists).toBe(1);
});

test("Call a tool turns every tool on when none is, and asks for one that is on", () => {
  const all = TOOLS.map((t) => t.name);
  expect(callAToolChip([], all)).toEqual({ prompt: expect.stringContaining("weather in Hanoi"), patch: { tools: all } });
  expect(callAToolChip(["calculate"], all)).toEqual({ prompt: expect.stringContaining("calculate"), patch: undefined });
  expect(callAToolChip(["get_time", "get_weather"], all).prompt).toContain("weather in Hanoi");
});

test("chats saved with the old tool check keep get_weather; the send body carries the chosen tools", () => {
  expect(migrateLegacySettings({ model: "a/b", shape: "gemini", reasoning: "low", toolCheck: true }).tools).toEqual(["get_weather"]);
  expect(migrateLegacySettings({ model: "a/b", shape: "gemini", reasoning: "low", toolCheck: false }).tools).toEqual([]);
  expect(migrateLegacySettings({ ...DEFAULT_SETTINGS, tools: ["calculate"] }).tools).toEqual(["calculate"]);
  const body = sendBody({ ...DEFAULT_SETTINGS, model: "a/b", tools: ["calculate", "get_time"] }, undefined, []);
  expect(body.tools).toEqual(["calculate", "get_time"]);
  expect("tool_check" in body).toBe(false);
});
