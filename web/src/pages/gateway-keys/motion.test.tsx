import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { GatewayKey } from "./api";
import { CreateDialog } from "./CreateDialog";
import { type Draft, emptyDraft } from "./scope";
import { ScopeEditor } from "./ScopeEditor";

// Motion of Gateway Keys (UI ticket 20): what opens inside the access editor
// and the model picker grows with the collapse recipe, from the motion tokens
// (architecture.md "UI motion system"). jsdom has no Tailwind, so this reads
// the classes on the real markup; the feel is checked in Chrome.

const CREATED: GatewayKey = {
  id: "gk_9",
  name: "linh",
  secret: "iroha_gk_revealonce0001",
  scope: { all: true },
  capture: false,
  revoked: false,
  created_at: "2026-11-19T00:00:00Z",
  recent_requests: 0,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/providers") return json({ providers: [{ id: "p1", handle: "openai", name: "OpenAI", enabled: true, archived: false }] });
      if (u.pathname === "/api/pools") return json({ pools: [] });
      if (u.pathname === "/api/gateway-keys" && init?.method === "POST") return json({ audit_entry: "ae_1", changes: [], gateway_key: CREATED });
      if (u.pathname === "/api/providers/openai/models")
        return json({ total: 2, offset: 0, limit: 200, models: ["gpt-4o", "o3"].map((m) => ({ id: m, model: m, visible: true, hidden: false })) });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const classesOf = (el: Element) => el.getAttribute("class")!.split(/\s+/);

/** The collapse recipe, tokens only: height from UI SDK's measure, 0 on the first and last frame. */
function expectCollapse(panel: Element) {
  const c = classesOf(panel);
  expect(panel.getAttribute("data-slot")).toBe("collapsible-panel");
  for (const k of ["h-(--collapsible-panel-height)", "overflow-hidden", "transition-[height]", "duration-collapse", "ease-out", "data-starting-style:h-0", "data-ending-style:h-0"])
    expect(c).toContain(k);
  expect(c.filter((x) => /(^|:)duration-\d/.test(x))).toEqual([]);
}

function Editor({ start }: { start: Draft }) {
  const [draft, setDraft] = useState(start);
  return <ScopeEditor draft={draft} onChange={setDraft} />;
}

function renderEditor(start: Draft) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Editor start={start} />
    </QueryClientProvider>,
  );
}

describe("access editor", () => {
  test("Only some opens the checklist with the collapse recipe, and Everything folds it away", async () => {
    const user = userEvent.setup();
    renderEditor({ ...emptyDraft(), all: true });
    await user.click(screen.getByRole("radio", { name: "Only some" }));
    const list = await screen.findByRole("region", { name: "Providers and Pools" });
    expectCollapse(list.closest("[data-slot=collapsible-panel]")!);
    await user.click(screen.getByRole("radio", { name: "Everything" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Providers and Pools" })).toBeNull());
  });

  test("an editor that starts on Only some shows its checklist at once", async () => {
    renderEditor({ all: false, providers: new Map(), pools: new Set() });
    const list = await screen.findByRole("region", { name: "Providers and Pools" });
    // Open on its first paint: UI SDK sets no starting style, so nothing grows when the dialog opens.
    expect(list.closest("[data-slot=collapsible-panel]")!.hasAttribute("data-starting-style")).toBe(false);
  });

  test("Only these in the model picker opens its list the same way", async () => {
    const user = userEvent.setup();
    renderEditor({ all: false, providers: new Map([["openai", null]]), pools: new Set() });
    await user.click(await screen.findByRole("button", { name: "Models of openai: All models" }));
    const dialog = await screen.findByRole("dialog", { name: "Models of openai" });
    await user.click(within(dialog).getByRole("radio", { name: "Only these" }));
    const search = await within(dialog).findByRole("searchbox", { name: "Search models" });
    expectCollapse(search.closest("[data-slot=collapsible-panel]")!);
  });

  test("the Models of trigger responds to a press like a button", async () => {
    renderEditor({ all: false, providers: new Map([["openai", null]]), pools: new Set() });
    const trigger = await screen.findByRole("button", { name: "Models of openai: All models" });
    expect(classesOf(trigger)).toContain("press");
  });
});

/** Rises a row's distance into place as it fades in (list-in, ease-out); a plain fade under reduced motion, where the shift token is 0. */
function expectRiseIn(el: Element) {
  const c = classesOf(el);
  for (const k of ["transition-[opacity,translate]", "duration-list-in", "ease-out", "starting:translate-y-(--motion-shift-sm)", "starting:opacity-0"]) expect(c).toContain(k);
}

describe("the new key, shown once", () => {
  test("Gateway Key created: the badge grows in and the title, text and key rise into place together", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CreateDialog open onOpenChange={() => {}} existing={[]} />
      </QueryClientProvider>,
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    // The form's body: the created view must not reuse it, or `@starting-style` never applies (a new element is what enters).
    const formBody = name.closest("form")!.parentElement!;
    await user.type(name, "linh");
    await user.click(screen.getByRole("radio", { name: "Everything" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway Key created" });
    expect(formBody.isConnected).toBe(false);
    const secret = within(dialog).getByText(CREATED.secret);
    expectRiseIn(secret.closest(".starting\\:opacity-0")!);
    expectRiseIn(within(dialog).getByText("Gateway Key created").closest(".starting\\:opacity-0")!);
    expectRiseIn(within(dialog).getByText(/Copy it now/).closest(".starting\\:opacity-0")!);
    const badge = dialog.querySelector("[data-badge]")!;
    for (const k of ["transition-[opacity,scale]", "duration-dialog-in", "ease-out", "starting:scale-(--motion-scale-popup)", "starting:opacity-0"]) expect(classesOf(badge)).toContain(k);
  });
});
