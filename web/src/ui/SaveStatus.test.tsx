import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "@/api/client";
import { Button } from "./Button";
import { Input } from "./Input";
import { DONE_MS, SaveError, SaveStatus, UNDO_MS, useSave } from "./SaveStatus";
import { Switch } from "./Switch";
import { Toaster } from "./toast";

const agent = createAgent();

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Text on the page, not in UI SDK's announcer regions. */
const onPage = { ignore: "script, style, [data-ui-sdk-announcer]" };

async function announced() {
  await act(() => vi.advanceTimersByTimeAsync(150));
  return [...document.querySelectorAll("[data-ui-sdk-announcer]")].map((r) => r.textContent).filter(Boolean);
}

/** A name field saved inline, the way settings rows save. */
function NameField({ call, refresh }: { call: (name: string) => Promise<{ audit_entry?: string }>; refresh?: () => void }) {
  const [name, setName] = useState("team-5");
  const save = useSave({ refresh });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(() => call(name), { message: `Renamed to ${name}` });
      }}
    >
      <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" loading={save.pending}>
        Save
      </Button>
      <SaveStatus save={save} />
      <SaveError save={save} />
    </form>
  );
}

test("an inline save shows Saving on the field, then the result with Undo in place, and no toast", async () => {
  const user = setup();
  let finish!: (r: { audit_entry?: string }) => void;
  const call = vi.fn(() => new Promise<{ audit_entry?: string }>((r) => (finish = r)));
  const refresh = vi.fn();
  render(
    <>
      <NameField call={call} refresh={refresh} />
      <Toaster />
    </>,
  );
  await user.clear(screen.getByRole("textbox", { name: "Name" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "team-6");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(call).toHaveBeenCalledWith("team-6");
  expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("Saving…", onPage)).toBeTruthy();

  await act(async () => finish({ audit_entry: "ae_1" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByText("Saving…", onPage)).toBeNull();
  expect(screen.getByText("Renamed to team-6", onPage)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Undo: Renamed to team-6" })).toBeTruthy();
  expect(await announced()).toContain("Renamed to team-6");
  expect(document.querySelector("[data-slot=toast]")).toBeNull();

  act(() => void vi.advanceTimersByTime(UNDO_MS));
  expect(screen.queryByText("Renamed to team-6", onPage)).toBeNull();
});

test("Undo reverts the change's Audit Entry and says so in the same place", async () => {
  const user = setup();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(answer(200, { audit_entry: "ae_2", changes: [] }));
  vi.stubGlobal("fetch", fetch);
  const refresh = vi.fn();
  render(<NameField call={async () => ({ audit_entry: "ae_1" })} refresh={refresh} />);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(await screen.findByRole("button", { name: "Undo: Renamed to team-5" }));
  expect(String(fetch.mock.calls[0][0])).toBe("/api/audit-entries/ae_1/revert");
  expect(fetch.mock.calls[0][1]?.method).toBe("POST");
  expect(await screen.findByText("Change reverted", onPage)).toBeTruthy();
  expect(refresh).toHaveBeenCalledTimes(2);
  // Reverting the revert redoes the change.
  expect(screen.getByRole("button", { name: "Undo: Change reverted" })).toBeTruthy();
});

test("a failed save shows its error under the field until the next try", async () => {
  const user = setup();
  const call = vi
    .fn()
    .mockRejectedValueOnce(new ApiError({ status: 409, code: "name_taken", message: "team-6 is taken.", hint: "Pick another name.", method: "PATCH", path: "/x" }))
    .mockResolvedValueOnce({});
  render(<NameField call={call} />);
  await user.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("team-6 is taken. Pick another name.");
  act(() => void vi.advanceTimersByTime(UNDO_MS * 2));
  expect(screen.getByRole("alert")).toBe(alert);
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.queryByRole("alert")).toBeNull();
  // Nothing to undo: the result goes sooner.
  expect(await screen.findByText("Renamed to team-5", onPage)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  act(() => void vi.advanceTimersByTime(DONE_MS));
  expect(screen.queryByText("Renamed to team-5", onPage)).toBeNull();
});

test("a switch saving on toggle shows its new state at once, is busy, and goes back if the save fails", async () => {
  const user = setup();
  let fail!: (e: Error) => void;
  function Capture() {
    const [on, setOn] = useState(false);
    const save = useSave();
    return (
      <>
        <Switch
          label="Capture prompts"
          checked={on}
          pending={save.pending}
          onChange={(next) =>
            void save.run(
              () =>
                new Promise<object>((_, reject) => {
                  fail = reject;
                }).then(() => setOn(next)),
              { message: next ? "Capture on" : "Capture off" },
            )
          }
        />
        <SaveError save={save} />
      </>
    );
  }
  render(<Capture />);
  const sw = screen.getByRole("switch", { name: "Capture prompts" });
  await user.click(sw);
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(sw.getAttribute("aria-busy")).toBe("true");
  // A second press while saving is ignored.
  await user.click(sw);
  expect(sw.getAttribute("aria-checked")).toBe("true");
  await act(async () => fail(new Error("Iroha is restarting.")));
  await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
  expect(sw.hasAttribute("aria-busy")).toBe(false);
  expect(screen.getByRole("alert").textContent).toBe("Iroha is restarting.");
  expect(document.activeElement).toBe(sw);
});

test("an agent finds the field, the save and the Undo by name", async () => {
  setup();
  render(<NameField call={async () => ({ audit_entry: "ae_1" })} />);
  const result = await agent.act({
    steps: [
      { ref: "Name", action: "setValue", args: ["team-9"] },
      { ref: "Save", action: "press" },
    ],
  });
  expect(result.ok, result.error?.message).toBe(true);
  await screen.findByText("Renamed to team-9", onPage);
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  expect(components.map((e) => e.label)).toEqual(expect.arrayContaining(["Name", "Save", "Undo: Renamed to team-9"]));
});
