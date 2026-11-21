import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { newChat } from "./store";
import { startFor } from "./targets";

vi.mock("./store", async (orig) => ({ ...(await orig<typeof import("./store")>()), newChat: vi.fn(() => "c1") }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const empty = { total: 0, matched: 0, pools: [], providers: [], truncated: false };

let asked: URL[] = [];
beforeEach(() => {
  asked = [];
  vi.mocked(newChat).mockClear();
  localStorage.setItem("iroha.chat.recent-models", JSON.stringify(["acme/z-9"]));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      asked.push(u);
      if (u.pathname === "/api/test/models") return json({ ...empty, suggested: u.searchParams.get("prefer") === "acme/" ? "acme/b-2" : undefined });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const started = () => vi.mocked(newChat).mock.calls[0][0]!;

test("opening from a Provider starts on the model Iroha suggests for it (most served, else first), not the last one used", async () => {
  await startFor({ kind: "provider", provider: "acme" });
  expect(started().settings?.model).toBe("acme/b-2");
  expect(started().origin).toBe("acme");
  expect(asked.some((u) => u.pathname === "/api/test/models" && u.searchParams.get("prefer") === "acme/")).toBe(true);
});

test("opening from an Upstream Key starts on the suggested model with the key pinned", async () => {
  await startFor({ kind: "upstream_key", provider: "acme", key: "team-5" });
  expect(started().settings).toMatchObject({ model: "acme/b-2", upstreamKey: "team-5" });
  expect(started().origin).toBe("acme / team-5");
});

test("a Provider with nothing to suggest starts with no model, so the picker opens", async () => {
  await startFor({ kind: "provider", provider: "empty" });
  expect(started().settings?.model).toBe("");
});

test("Test on a model row starts on that model of that Provider, without asking Iroha", async () => {
  await startFor({ kind: "model", provider: "acme", model: "qwen/qwen3-coder" });
  expect(started().settings?.model).toBe("acme/qwen/qwen3-coder");
  expect(started().origin).toBe("acme");
  expect(started().title).toBe("qwen/qwen3-coder test");
  expect(asked).toHaveLength(0);
});
