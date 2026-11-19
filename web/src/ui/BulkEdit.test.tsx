import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { applySet, BulkEdit, type BulkChanges, type BulkField, bulkDone, commonValue } from "./BulkEdit";
import { SaveError, SaveStatus, useSave } from "./SaveStatus";
import type { BulkResult } from "@/api/types";

const agent = createAgent();
const quiet = { ignore: "script, style, [data-ui-sdk-announcer]" };

type Row = { id: string; name: string; on: boolean; tier: string; note: string; zones: string[] };
const rows: Row[] = [
  { id: "1", name: "team-1", on: true, tier: "gold", note: "x", zones: ["eu", "us"] },
  { id: "2", name: "team-2", on: false, tier: "gold", note: "x", zones: ["eu"] },
  { id: "3", name: "team-3", on: true, tier: "silver", note: "x", zones: ["eu"] },
];
const fields: BulkField<Row>[] = [
  { kind: "boolean", id: "on", label: "Enabled", get: (r) => r.on },
  { kind: "select", id: "tier", label: "Tier", get: (r) => r.tier, options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] },
  { kind: "text", id: "note", label: "Note", get: (r) => r.note },
  { kind: "set", id: "zones", label: "Zones", get: (r) => r.zones, options: [{ value: "eu", label: "eu" }, { value: "us", label: "us" }, { value: "asia", label: "asia" }] },
];

function Bar({ apply, list = rows }: { apply: (c: BulkChanges) => Promise<unknown>; list?: Row[] }) {
  const save = useSave();
  return (
    <div role="group" aria-label="3 selected">
      <BulkEdit rows={list} noun={["key", "keys"]} fields={fields} at={save} onApply={async (c) => ({ message: "Done", entry: (await apply(c)) as string })} />
      <SaveStatus save={save} saving={false} />
      <SaveError save={save} />
    </div>
  );
}

test("the pure helpers: a shared value or mixed, and a set change as a delta", () => {
  expect(commonValue(rows, (r) => r.note)).toEqual({ mixed: false, value: "x" });
  expect(commonValue(rows, (r) => r.on)).toEqual({ mixed: true });
  expect(commonValue([], (r: Row) => r.on)).toEqual({ mixed: true });
  expect(applySet(["eu", "us"], { add: ["asia"], remove: ["us"] }, ["eu", "us", "asia"])).toEqual(["eu", "asia"]);
  expect(applySet(["us"], { add: ["eu"], remove: [] }, ["eu", "us"])).toEqual(["eu", "us"]);
});

test("mixed values show as mixed: a dash, a 'Mixed' placeholder in a select and a field, and a dash with a count in a set", async () => {
  const user = userEvent.setup();
  render(<Bar apply={async () => "aud"} />);
  await user.click(screen.getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 3 keys" });
  expect(within(dialog).getByRole("checkbox", { name: "Enabled" }).getAttribute("aria-checked")).toBe("mixed");
  expect(dialog.textContent).toContain("Mixed: on for 2 of 3 keys");
  expect(within(dialog).getByRole("combobox", { name: "Tier" }).textContent).toContain("Mixed");
  // A value every row shares shows as the value.
  expect((within(dialog).getByRole("textbox", { name: "Note" }) as HTMLInputElement).value).toBe("x");
  expect(within(dialog).getByRole("checkbox", { name: "eu" }).getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByRole("checkbox", { name: "us" }).getAttribute("aria-checked")).toBe("mixed");
  expect(within(dialog).getByRole("checkbox", { name: "asia" }).getAttribute("aria-checked")).toBe("false");
  expect(dialog.textContent).toContain("1 of 3");
  // Nothing changed yet: Apply waits.
  expect(within(dialog).getByRole("button", { name: "Apply to 3 keys" }).hasAttribute("disabled") || within(dialog).getByRole("button", { name: "Apply to 3 keys" }).getAttribute("aria-disabled") === "true").toBe(true);
});

test("only changed fields are sent; Keep as is and setting a value back leave a field untouched", async () => {
  const user = userEvent.setup();
  const apply = vi.fn(async () => "aud_1");
  render(<Bar apply={apply} />);
  await user.click(screen.getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 3 keys" });
  // Enabled: mixed -> on for all.
  await user.click(within(dialog).getByRole("checkbox", { name: "Enabled" }));
  expect(within(dialog).getByRole("checkbox", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
  expect(dialog.textContent).toContain("On for all 3 keys");
  // Note: typed, then put back by Keep as is.
  const note = within(dialog).getByRole("textbox", { name: "Note" });
  await user.type(note, "y");
  await user.click(within(dialog).getByRole("button", { name: "Keep Note as each key has it" }));
  expect((within(dialog).getByRole("textbox", { name: "Note" }) as HTMLInputElement).value).toBe("x");
  // Zones: add asia to all, take us off all, eu untouched (already on all).
  await user.click(within(dialog).getByRole("checkbox", { name: "asia" }));
  await user.click(within(dialog).getByRole("checkbox", { name: "us" })); // mixed -> on
  await user.click(within(dialog).getByRole("checkbox", { name: "us" })); // on -> off
  await user.click(within(dialog).getByRole("button", { name: "Apply to 3 keys" }));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(apply).toHaveBeenCalledWith({ on: true, zones: { add: ["asia"], remove: ["us"] } });
  // The dialog closes and the result (with Undo) shows where Edit was pressed.
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const bar = screen.getByRole("group", { name: "3 selected" });
  expect(await within(bar).findByText("Done", quiet)).toBeTruthy();
  expect(within(bar).getByRole("button", { name: "Undo: Done" })).toBeTruthy();
});

test("a failed apply keeps the dialog open with the error and the draft", async () => {
  const user = userEvent.setup();
  render(<Bar apply={() => Promise.reject(new Error("Iroha is down."))} />);
  await user.click(screen.getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 3 keys" });
  await user.click(within(dialog).getByRole("checkbox", { name: "Enabled" }));
  await user.click(within(dialog).getByRole("button", { name: "Apply to 3 keys" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Iroha is down.");
  expect(within(dialog).getByRole("checkbox", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
});

test("bulkDone words a partial failure naming the rows that failed, keeping Undo for the rest", () => {
  const res: BulkResult<unknown> = {
    dry_run: false,
    audit_entry: "aud_9",
    succeeded: 3,
    failed: 2,
    items: [
      { index: 0, ok: true, outcome: "updated", changes: [] },
      { index: 1, ok: false, error: { code: "not_found", message: "No key team-2." }, changes: [] },
      { index: 2, ok: true, outcome: "updated", changes: [] },
      { index: 3, ok: true, outcome: "unchanged", changes: [] },
      { index: 4, ok: false, error: { code: "conflict", message: "Revoked." }, changes: [] },
    ],
  };
  const d = bulkDone(res, ["team-1", "team-2", "team-3", "team-4", "team-5"], ["key", "keys"]);
  expect(d).toEqual({ message: "2 keys changed, 1 already so; not changed: team-2 (No key team-2.), team-5 (Revoked.)", tone: "bad", entry: "aud_9" });
  expect(bulkDone({ ...res, failed: 0, succeeded: 5, items: res.items.map((i) => ({ ...i, ok: true, outcome: "updated" as const, error: undefined })) }, ["a", "b", "c", "d", "e"], ["key", "keys"])).toEqual({ message: "5 keys changed", entry: "aud_9" });
  expect(bulkDone({ dry_run: false, succeeded: 2, failed: 0, items: [{ index: 0, ok: true, outcome: "unchanged", changes: [] }, { index: 1, ok: true, outcome: "unchanged", changes: [] }] }, ["a", "b"], ["key", "keys"])).toEqual({ message: "Nothing changed: both keys already had that" });
});

test("an agent opens the edit, changes a field by name and applies it", async () => {
  const apply = vi.fn(async () => "aud_1");
  function Page() {
    const [list] = useState(rows);
    return <Bar apply={apply} list={list} />;
  }
  render(<Page />);
  expect((await agent.act({ steps: [{ ref: "Edit…", action: "press" }] })).ok).toBe(true);
  await screen.findByRole("dialog", { name: "Edit 3 keys" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Enabled", "Tier", "Note", "eu", "us", "asia", "Apply to 3 keys", "Cancel"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Enabled", action: "toggle" }, { ref: "Apply to 3 keys", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(apply).toHaveBeenCalledWith({ on: true }));
});
