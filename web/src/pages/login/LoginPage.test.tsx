import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, expect, test, vi } from "vitest";
import { LoginPage } from "./LoginPage";
import { SetupPage } from "./SetupPage";

const agent = createAgent();

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPage(page: React.ReactNode) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  render(<QueryClientProvider client={new QueryClient()}>{page}</QueryClientProvider>);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

const sent = (fetch: ReturnType<typeof renderPage>, i = 0) => {
  const [url, init] = fetch.mock.calls[i];
  return { url, method: init?.method, body: JSON.parse(String(init?.body)) };
};

test("an agent signs in on the Login page", async () => {
  const fetch = renderPage(<LoginPage />);
  fetch.mockResolvedValue(answer(201, { password_set: true, signed_in: true }));

  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  expect(labels).toContain("Password");
  expect(labels).toContain("Sign in");

  const result = await agent.act({
    steps: [
      { ref: "Password", action: "setValue", args: ["correct horse"] },
      { ref: "Sign in", action: "press" },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(sent(fetch)).toEqual({ url: "/api/session", method: "POST", body: { password: "correct horse" } });
});

test("a wrong password shows under the field, marks it invalid and is announced", async () => {
  const user = userEvent.setup();
  const fetch = renderPage(<LoginPage />);
  fetch.mockResolvedValue(answer(401, { error: { code: "owner_password_wrong", message: "Wrong password.", hint: "" } }));
  const input = screen.getByLabelText<HTMLInputElement>("Password", { selector: "input" });
  await user.type(input, "nope{Enter}");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("That's not the Owner password.");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
});

test("Setup refuses empty fields, then sets the password with the Admin Token", async () => {
  const user = userEvent.setup();
  const fetch = renderPage(<SetupPage />);
  fetch.mockResolvedValue(answer(200, { password_set: true, signed_in: true }));
  const submit = screen.getByRole("button", { name: "Set password and sign in" });
  await user.click(submit);
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["Paste an Admin Token.", "Use at least 8 characters."]);

  await user.type(screen.getByLabelText("Admin Token", { selector: "input" }), "iroha_admin_x");
  await user.type(screen.getByLabelText("Password", { selector: "input" }), "long enough");
  await user.type(screen.getByLabelText("Confirm password", { selector: "input" }), "long enough");
  await user.click(submit);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const put = fetch.mock.calls[0];
  expect(put[0]).toBe("/api/owner-password");
  expect((put[1]?.headers as Record<string, string>).Authorization).toBe("Bearer iroha_admin_x");
  expect(sent(fetch, 1)).toEqual({ url: "/api/session", method: "POST", body: { password: "long enough" } });
});
