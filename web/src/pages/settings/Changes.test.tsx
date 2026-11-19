import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { AuditEntry } from "@/api/types";
import { EntryChanges } from "./Changes";

// UI ticket 23: an Audit Entry's JSON values are highlighted like every code block.

const entry = {
  id: "ae_1",
  changes: [
    {
      resource: "gateway_key",
      id: "gk_1",
      name: "linh",
      op: "update",
      fields: ["scope"],
      before: { scope: { all: true } },
      after: { scope: { all: false, providers: ["acme"] } },
    },
  ],
} as unknown as AuditEntry;

test("a JSON value in an Audit Entry is highlighted", () => {
  const { container } = render(
    <MemoryRouter>
      <EntryChanges entry={entry} labels={new Map()} />
    </MemoryRouter>,
  );
  const [before, after] = [...container.querySelectorAll("pre")];
  expect(before.textContent).toBe('{\n  "all": true\n}');
  expect([...after.querySelectorAll("[data-token]")].map((e) => `${e.getAttribute("data-token")} ${e.textContent}`)).toEqual([
    'key "all"',
    "literal false",
    'key "providers"',
    'string "acme"',
  ]);
});
