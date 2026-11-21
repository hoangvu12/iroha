import { render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { Skeleton } from "@/ui/Skeleton";
import { SheetBody, SheetLoading, SheetTitle } from "./Sheet";

function inSheet(body: ReactNode) {
  render(
    <MemoryRouter>
      <Dialog open modal={false}>
        <DialogContent>{body}</DialogContent>
      </Dialog>
    </MemoryRouter>,
  );
}

test("a sheet loading its record is named by the record and reads as loading", async () => {
  inSheet(<SheetLoading name="Provider acme" />);
  expect(await screen.findByRole("dialog", { name: "Provider acme" })).toBeTruthy();
  expect(screen.getByText("Loading Provider acme")).toBeTruthy();
});

test("the sample a sheet's skeleton is measured from does not name the sheet", async () => {
  inSheet(
    <SheetBody>
      <DialogTitle className="sr-only">Request req_9</DialogTitle>
      <Skeleton data={undefined} sample={{ model: "sample-model" }} label="Loading Request">
        {(r) => <SheetTitle kind="Request" title={r.model} />}
      </Skeleton>
    </SheetBody>,
  );
  const sheet = await screen.findByRole("dialog", { name: "Request req_9" });
  expect(document.querySelectorAll(`[id="${sheet.getAttribute("aria-labelledby")}"]`)).toHaveLength(1);
});
