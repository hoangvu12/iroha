import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type Draft, emptyDraft } from "./scope";
import { ScopeEditor } from "./ScopeEditor";

const agent = createAgent();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/providers")
        return json({
          providers: [
            { id: "p1", handle: "openai", name: "OpenAI", enabled: true, archived: false },
            { id: "p2", handle: "zai", name: "Z.ai", enabled: true, archived: false },
          ],
        });
      if (u.pathname === "/api/pools") return json({ pools: [{ id: "m1", name: "glm-4.6", maker: "zai" }] });
      if (u.pathname === "/api/providers/openai/models") {
        const all = ["gpt-4o", "gpt-4o-mini", "o3"].filter((m) => m.includes(u.searchParams.get("q") ?? ""));
        return json({ total: all.length, offset: 0, limit: 200, models: all.map((m) => ({ id: m, model: m, visible: true, hidden: false })) });
      }
      if (u.pathname === "/api/providers/zai/models") {
        const all = Array.from({ length: 100 }, (_, i) => `glm-${String(i).padStart(3, "0")}`);
        return json({ total: all.length, offset: 0, limit: 200, models: all.map((m) => ({ id: m, model: m, visible: true, hidden: false })) });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

let latest: Draft;
function Editor({ start = emptyDraft() }: { start?: Draft }) {
  const [draft, setDraft] = useState(start);
  latest = draft;
  return <ScopeEditor draft={draft} onChange={setDraft} />;
}

function renderEditor(start?: Draft) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Editor start={start} />
    </QueryClientProvider>,
  );
}

test("Access is a radio group; Only some lists Providers and Pools as named checkboxes", async () => {
  const user = userEvent.setup();
  renderEditor({ ...emptyDraft(), all: true });
  const access = screen.getByRole("radiogroup", { name: "Access" });
  expect(within(access).getByRole("radio", { name: "Everything" }).getAttribute("aria-checked")).toBe("true");
  await user.click(within(access).getByRole("radio", { name: "Only some" }));
  expect(latest.all).toBe(false);
  const openai = await screen.findByRole("checkbox", { name: "openai" });
  await user.click(openai);
  expect(latest.providers.has("openai")).toBe(true);
  await user.keyboard(" ");
  expect(latest.providers.has("openai")).toBe(false);
  await user.click(screen.getByRole("checkbox", { name: "glm-4.6" }));
  expect([...latest.pools]).toEqual(["glm-4.6"]);
});

test("a checked Provider's models open a dialog that picks some by keyboard and returns focus", async () => {
  const user = userEvent.setup();
  renderEditor({ all: false, providers: new Map([["openai", null]]), pools: new Set() });
  const models = await screen.findByRole("button", { name: "Models of openai: All models" });
  await user.click(models);
  const dialog = await screen.findByRole("dialog", { name: "Models of openai" });
  await user.click(within(dialog).getByRole("radio", { name: "Only these" }));
  const box = await within(dialog).findByRole("checkbox", { name: "gpt-4o-mini" });
  box.focus();
  await user.keyboard(" ");
  await user.click(within(dialog).getByRole("button", { name: "Allow 1 model" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(latest.providers.get("openai")).toEqual(["gpt-4o-mini"]);
  const again = screen.getByRole("button", { name: "Models of openai: 1 model" });
  expect(document.activeElement).toBe(again);
});

test("a long model list scrolls in the shared Scroll Area and draws the rows scrolled into view", async () => {
  const user = userEvent.setup();
  renderEditor({ all: false, providers: new Map([["zai", null]]), pools: new Set() });
  await user.click(await screen.findByRole("button", { name: "Models of zai: All models" }));
  const dialog = await screen.findByRole("dialog", { name: "Models of zai" });
  await user.click(within(dialog).getByRole("radio", { name: "Only these" }));
  await within(dialog).findByRole("checkbox", { name: "glm-000" });
  // The list is the Scroll Area's viewport (its own thin bar), not a native scroller.
  const list = within(dialog).getByRole("region", { name: "Models of zai" });
  expect(list.getAttribute("data-slot")).toBe("scroll-area-viewport");
  expect(within(dialog).queryByRole("checkbox", { name: "glm-099" })).toBeNull();
  list.scrollTop = 100 * 36 - 300;
  fireEvent.scroll(list);
  expect(await within(dialog).findByRole("checkbox", { name: "glm-099" })).toBeTruthy();
  expect(within(dialog).queryByRole("checkbox", { name: "glm-000" })).toBeNull();
});

test("the model dialog scrolls as a page: picked chips flow in it, only the long model list scrolls on its own", async () => {
  const user = userEvent.setup();
  renderEditor({ all: false, providers: new Map([["zai", ["glm-001", "glm-002"]]]), pools: new Set() });
  await user.click(await screen.findByRole("button", { name: "Models of zai: 2 models" }));
  const dialog = await screen.findByRole("dialog", { name: "Models of zai" });
  await within(dialog).findByRole("checkbox", { name: "glm-000" });
  expect(within(dialog).getByRole("button", { name: "Remove glm-001" }).closest("[data-slot^=scroll-area]"), "chips in no scroll box").toBeNull();
  const scrollers = dialog.querySelectorAll("[data-slot=scroll-area-viewport]");
  expect([...scrollers].map((s) => s.getAttribute("aria-label"))).toEqual(["Models of zai"]);
});

test("an agent picks the scope by names alone", async () => {
  renderEditor({ ...emptyDraft(), all: true });
  const run = await agent.act({ steps: [{ ref: "Access", action: "setValue", args: ["some"] }] });
  expect(run.ok, run.error?.message).toBe(true);
  await screen.findByRole("checkbox", { name: "zai" });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const pick = await agent.act({ steps: [{ ref: "zai", action: "setChecked", args: [true] }] });
  expect(pick.ok, pick.error?.message).toBe(true);
  expect(latest.providers.has("zai")).toBe(true);
});
