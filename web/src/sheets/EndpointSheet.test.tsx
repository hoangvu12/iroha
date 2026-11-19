import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, expect, test, vi } from "vitest";
import type { Endpoint, Provider } from "@/pages/providers/api";
import { EndpointsTab } from "@/pages/providers/Endpoints";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

// UI ticket 27: an Endpoint is edited in its sheet, not in a dialog.

const agent = createAgent();
const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const text = { ignore: "script, style, [data-ui-sdk-announcer]" };
const saved = { ...routes };
const main = routes["GET /api/providers/acme/endpoints/main"] as Endpoint;
const provider = routes["GET /api/providers/acme"] as Provider;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(routes)) if (!(k in saved)) delete routes[k];
  Object.assign(routes, saved);
});

/** The Endpoint's sheet once its body shows the Endpoint. */
async function endpointSheet(name: string) {
  const sheet = await loadedSheet(`Endpoint ${name}`);
  await within(sheet).findByRole("button", { name: `Edit ${name}` });
  return sheet;
}

const sent = (fetch: ReturnType<typeof renderWithSheets>["fetch"], method: string) =>
  fetch.mock.calls.filter(([, i]) => i?.method === method).map(([u, i]) => [String(u), i?.body ? JSON.parse(String(i.body)) : undefined]);

test("Edit turns the sheet's facts into the Endpoint's fields; Save keeps the sheet open and says so in it", async () => {
  const user = userEvent.setup();
  routes["PATCH /api/providers/acme/endpoints/main"] = { audit_entry: "aud_1", endpoint: { ...main, url: "https://api2.acme.test/v1" } };
  const { fetch } = renderWithSheets(null, "/x?sheet=endpoint:acme/main");
  const sheet = await endpointSheet("main");
  const s = within(sheet);
  expect(s.queryByRole("textbox", { name: "URL" })).toBeNull();

  await user.click(s.getByRole("button", { name: "Edit main" }));
  const url = await s.findByRole("textbox", { name: "URL" });
  expect((url as HTMLInputElement).value).toBe("https://api.acme.test/v1");
  expect((s.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("main");
  // No dialog: the form is in the sheet.
  expect(screen.queryAllByRole("dialog")).toEqual([sheet]);

  await user.clear(url);
  await user.type(url, "https://api2.acme.test/v1");
  await user.click(s.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sent(fetch, "PATCH")).toHaveLength(1));
  const [u, body] = sent(fetch, "PATCH")[0];
  expect(u).toBe("/api/providers/acme/endpoints/main");
  expect(body).toMatchObject({ url: "https://api2.acme.test/v1", name: "main", shape: "openai-chat" });
  expect(await s.findByText("Endpoint main saved", text)).toBeTruthy();
  await waitFor(() => expect(s.queryByRole("textbox", { name: "URL" })).toBeNull());
});

test("a rename moves the sheet and the URL to the new name; Cancel leaves the facts as they were", async () => {
  const user = userEvent.setup();
  routes["PATCH /api/providers/acme/endpoints/main"] = { audit_entry: "aud_1", endpoint: { ...main, name: "primary" } };
  routes["GET /api/providers/acme/endpoints/primary"] = { ...main, name: "primary" };
  renderWithSheets(null, "/x?sheet=endpoint:acme/main");
  const sheet = await endpointSheet("main");
  const s = within(sheet);

  await user.click(s.getByRole("button", { name: "Edit main" }));
  await user.click(await s.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(s.queryByRole("textbox", { name: "URL" })).toBeNull());

  await user.click(s.getByRole("button", { name: "Edit main" }));
  const name = await s.findByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "primary");
  await user.click(s.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(where()).toBe("/x?sheet=endpoint:acme/primary"));
  expect(await screen.findByRole("dialog", { name: "Endpoint primary" })).toBe(sheet);
});

test("picking a header you name opens its name field under the choice, folding as it opens (UI ticket 17)", async () => {
  const user = userEvent.setup();
  renderWithSheets(null, "/x?sheet=endpoint:acme/main");
  const sheet = await endpointSheet("main");
  await user.click(within(sheet).getByRole("button", { name: "Edit main" }));
  expect(within(sheet).queryByRole("textbox", { name: "Header name" })).toBeNull();
  await user.click(await within(sheet).findByRole("combobox", { name: "Key sent as" }));
  await user.click(await screen.findByRole("option", { name: "A header you name" }));
  const name = await within(sheet).findByRole("textbox", { name: "Header name" });
  const panel = name.closest("[data-slot=collapsible-panel]")!;
  for (const c of ["transition-[height]", "duration-collapse", "data-starting-style:h-0", "data-ending-style:h-0", "overflow-hidden"])
    expect(panel.className.split(/\s+/)).toContain(c);
  // The input's focus ring has room inside the clipping panel.
  for (const c of ["-mx-1", "px-1", "-mb-1", "pb-1"]) expect(panel.className.split(/\s+/)).toContain(c);
});

test("the Endpoints tab: a row opens the sheet, Edit… opens it on the fields, Delete… in the sheet asks and closes it", async () => {
  const user = userEvent.setup();
  routes["DELETE /api/providers/acme/endpoints/main"] = { audit_entry: "aud_2", endpoint: main };
  const { fetch } = renderWithSheets(<EndpointsTab handle="acme" provider={provider} adding={false} setAdding={() => {}} />, "/providers/acme/endpoints");
  await user.click(await screen.findByRole("button", { name: "Open main" }));
  const sheet = await endpointSheet("main");
  await waitFor(() => expect(where()).toBe("/providers/acme/endpoints?sheet=endpoint:acme/main"));
  expect(within(sheet).queryByRole("textbox", { name: "URL" })).toBeNull();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));

  await user.click(screen.getByRole("button", { name: "More for main" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit…" }));
  const editing = await loadedSheet("Endpoint main");
  expect(await within(editing).findByRole("textbox", { name: "URL" })).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Edit main" })).toBeNull();

  await user.click(within(editing).getByRole("button", { name: "Delete main…" }));
  await user.click(within(await screen.findByRole("alertdialog", { name: "Delete main?" })).getByRole("button", { name: "Delete endpoint" }));
  await waitFor(() => expect(sent(fetch, "DELETE")).toEqual([["/api/providers/acme/endpoints/main", undefined]]));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Endpoint main" })).toBeNull());
  await waitFor(() => expect(where()).toBe("/providers/acme/endpoints"));
});

test("an agent opens an Endpoint's sheet from the tab and finds Edit, Delete and the fields by name", async () => {
  renderWithSheets(<EndpointsTab handle="acme" provider={provider} adding={false} setAdding={() => {}} />, "/providers/acme/endpoints");
  await screen.findByRole("table", { name: "Endpoints" });
  const run = await agent.act({ steps: [{ ref: "Open main", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  const sheet = await endpointSheet("main");
  const edit = await agent.act({ steps: [{ ref: "Edit main", action: "press" }] });
  expect(edit.ok, edit.error?.message).toBe(true);
  await within(sheet).findByRole("textbox", { name: "URL" });
  const labels = agent
    .snapshot()
    .filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area")
    .map((e) => e.label);
  for (const l of ["URL", "Name", "Shape", "Key sent as", "Model list URL", "Save", "Cancel", "Delete main…", "Test acme in Chat"]) expect(labels, `${l} is missing`).toContain(l);
});
