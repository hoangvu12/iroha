import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SETTINGS } from "./api";
import { SnippetDialog } from "./SnippetDialog";

const agent = createAgent();

afterEach(() => vi.unstubAllGlobals());

const snippets = {
  url: "http://iroha.local/v1/chat/completions",
  curl: "curl -N 'http://iroha.local/v1/chat/completions' \\\n  -H \"Authorization: Bearer $IROHA_KEY\" \\\n  -d '{\"model\":\"acme/m\"}'\n",
  python: 'import os\n\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="http://iroha.local/v1", api_key=os.environ["IROHA_KEY"])\n',
  typescript: 'import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "http://iroha.local/v1", apiKey: process.env.IROHA_KEY });\n',
  key_env: true,
};

function open(shape: "openai-chat" | "anthropic-messages" | "gemini" = "openai-chat", answer: object = snippets) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SnippetDialog open onOpenChange={() => {}} settings={{ ...DEFAULT_SETTINGS, model: "acme/m", shape, upstreamKey: "key-1" }} prompt="hi" />
    </QueryClientProvider>,
  );
  return fetch;
}

const code = () => document.querySelector("[role=dialog] pre") as HTMLElement;

// UI ticket 23: highlighted, and only the code.
test("the snippet is highlighted, with no install or pinning notes under it", async () => {
  const user = userEvent.setup();
  open();
  await waitFor(() => expect(code().textContent).toBe(snippets.curl));
  expect(code().querySelector('[data-token="function"]')?.textContent).toBe("curl");

  await user.click(screen.getByRole("radio", { name: "Python" }));
  await waitFor(() => expect(code().textContent).toBe(snippets.python));
  expect([...code().querySelectorAll('[data-token="keyword"]')].map((e) => e.textContent)).toEqual(["import", "from", "import"]);

  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).not.toMatch(/pip install|npm install|standard library|test-only/);

  await user.click(screen.getByRole("radio", { name: "TypeScript" }));
  await waitFor(() => expect(code().textContent).toBe(snippets.typescript));
  expect(dialog.textContent).not.toMatch(/npm install|ES module/);
});

test("an agent switches the language and copies the snippet", async () => {
  open("anthropic-messages");
  await waitFor(() => expect(code().textContent).toBe(snippets.curl));
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const result = await agent.act({
    steps: [
      { ref: "Language", action: "setValue", args: ["python"] },
      { ref: "Copy the Python snippet", action: "press" },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(snippets.python));
});

// UI ticket 28: a long snippet makes the dialog taller than the window, and the
// dialog scrolls as a page; the code only scrolls sideways (long lines).
test("a long snippet flows in the dialog: no height limit, only a sideways scroll", async () => {
  const curl = Array.from({ length: 80 }, (_, i) => `  -H "X-Line-${i}: ${i}" \\`).join("\n");
  open("openai-chat", { curl, python: "print()", typescript: "console.log()" });
  const dialog = await screen.findByRole("dialog", { name: "Use this from code" });
  await screen.findByText(/X-Line-79/);
  const viewport = dialog.querySelector("[data-slot=scroll-area-viewport]")!;
  expect(viewport.className, "no height limit").not.toMatch(/max-h-/);
});
