import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { expect, test } from "vitest";
import { RouteTabs, Tab, TabList, TabPanel, Tabs } from "./Tabs";

const agent = createAgent();
const TABS = ["keys", "endpoints", "models"] as const;

function Where() {
  return <output aria-label="Path">{useLocation().pathname}</output>;
}

function ProviderTabs() {
  const { tab = "" } = useParams();
  return (
    <>
      <RouteTabs
        label="Provider sections"
        value={tab}
        items={TABS.map((t) => ({ value: t, to: `/providers/acme/${t}`, label: t[0].toUpperCase() + t.slice(1) }))}
      >
        <p>Showing {tab}</p>
      </RouteTabs>
      <Where />
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/providers/acme/:tab" element={<ProviderTabs />} />
      </Routes>
    </MemoryRouter>,
  );
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

test("route tabs are a named tablist of links; the URL picks the tab and its panel", async () => {
  renderAt("/providers/acme/endpoints");
  await settle();
  const list = screen.getByRole("tablist", { name: "Provider sections" });
  const tabs = screen.getAllByRole("tab");
  expect(tabs.map((t) => t.textContent)).toEqual(["Keys", "Endpoints", "Models"]);
  expect(tabs.map((t) => t.getAttribute("href"))).toEqual(["/providers/acme/keys", "/providers/acme/endpoints", "/providers/acme/models"]);
  expect(screen.getByRole("tab", { name: "Endpoints" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("tabpanel", { name: "Endpoints" }).textContent).toBe("Showing endpoints");
  expect(list.querySelector('[data-slot="tabs-indicator"]')).not.toBeNull();
});

test("clicking a tab, the arrows, Home and End move to that tab's route", async () => {
  const user = userEvent.setup();
  renderAt("/providers/acme/keys");
  await settle();
  await user.click(screen.getByRole("tab", { name: "Models" }));
  expect(screen.getByLabelText("Path").textContent).toBe("/providers/acme/models");
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByLabelText("Path").textContent).toBe("/providers/acme/endpoints");
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Endpoints" }));
  await user.keyboard("{Home}");
  expect(screen.getByLabelText("Path").textContent).toBe("/providers/acme/keys");
  await user.keyboard("{End}");
  expect(screen.getByLabelText("Path").textContent).toBe("/providers/acme/models");
  expect(screen.getByRole("tabpanel", { name: "Models" }).textContent).toBe("Showing models");
});

test("an underline tab row scrolls sideways inside a Scroll Area whose scrollbar never shows", async () => {
  renderAt("/providers/acme/keys");
  await settle();
  const list = screen.getByRole("tablist", { name: "Provider sections" });
  const viewport = list.closest('[data-slot="scroll-area-viewport"]') as HTMLElement;
  expect(viewport).not.toBeNull();
  // A Scrollbar part is what makes UI SDK hide the browser's own bars.
  expect(viewport.style.scrollbarWidth).toBe("none");
  const bar = viewport.parentElement!.querySelector('[data-slot="scroll-area-scrollbar"]')!;
  expect(bar.getAttribute("data-orientation")).toBe("horizontal");
  expect(bar.className).toContain("invisible");
});

function Segments() {
  const [side, setSide] = useState("sent");
  return (
    <Tabs value={side} onValueChange={(v) => v && setSide(v)}>
      <TabList label="Captured side" variant="segmented">
        <Tab value="sent">Caller sent</Tab>
        <Tab value="response">Response</Tab>
      </TabList>
      <TabPanel value="sent">The prompt</TabPanel>
      <TabPanel value="response">The answer</TabPanel>
    </Tabs>
  );
}

test("state tabs switch panels; an agent can pick a tab by its text", async () => {
  render(<Segments />);
  await settle();
  expect(screen.getByRole("tabpanel", { name: "Caller sent" }).textContent).toBe("The prompt");
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  expect(entries.every((e) => e.label)).toBe(true);
  expect(entries.map((e) => e.label)).toContain("Captured side");
  const result = await agent.act({ steps: [{ ref: "Captured side", action: "setValue", args: ["response"] }] });
  expect(result.ok).toBe(true);
  await settle();
  expect(screen.getByRole("tabpanel", { name: "Response" }).textContent).toBe("The answer");
});
