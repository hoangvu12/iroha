import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { DataTable, columnsFor } from "./DataTable";

type Fruit = { id: string; name: string };
const col = columnsFor<Fruit>();
const columns = col.columns([col.accessor("name", { header: "Name" })]);
const many = (n: number, prefix = "fruit"): Fruit[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix}-${i}` }));

function Live({ data }: { data: Fruit[] }) {
  return (
    <DataTable
      id="fruit"
      label="Fruit"
      columns={columns}
      data={data}
      sample={data}
      getRowId={(f) => f.id}
      rowName={(f) => f.name}
      paging={{ mode: "infinite", hasMore: false, loadingMore: false, onLoadMore: () => {}, newRowsLabel: (n) => `${n} new` }}
    />
  );
}

function layOut() {
  const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-row-id")) return box(40 + [...this.parentElement!.children].indexOf(this) * 48 - document.documentElement.scrollTop, 48);
    if (this.tagName === "THEAD") return box(0, 40);
    return box(0, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.scrollTop = 0;
});

const classesOf = (el: Element) => el.getAttribute("class")!.split(/\s+/);
const pill = () => document.querySelector<HTMLElement>("[data-new-rows]")!;

test("the pill rises in on the list tokens and fades out in place, keeping its count, inert and hidden", async () => {
  layOut();
  const user = userEvent.setup();
  const rows = many(40);
  const { rerender } = render(<Live data={rows} />);
  expect(pill().getAttribute("data-shown")).toBeNull();
  expect(pill().hasAttribute("inert")).toBe(true);
  expect(pill().getAttribute("aria-hidden")).toBe("true");

  document.documentElement.scrollTop = 480;
  fireEvent.scroll(document);
  rerender(<Live data={[...many(2, "new"), ...rows]} />);
  const shown = screen.getByRole("button", { name: "2 new" });
  expect(pill().contains(shown)).toBe(true);
  expect(pill().getAttribute("data-shown")).toBe("");
  expect(pill().hasAttribute("inert")).toBe(false);

  const c = classesOf(pill());
  for (const k of ["transition-[opacity,translate]", "duration-list-in", "ease-out", "not-data-shown:translate-y-(--motion-shift)", "not-data-shown:opacity-0"]) expect(c).toContain(k);
  expect(c).toContain("not-data-shown:[transition-duration:var(--duration-list-out),0ms]");
  expect(c).toContain("not-data-shown:[transition-delay:0ms,var(--duration-list-out)]");
  expect(c.filter((k) => /(^|:)duration-[1-9]/.test(k))).toEqual([]);

  await user.click(shown);
  expect(screen.queryByRole("button", { name: /new$/ })).toBeNull();
  expect(pill().getAttribute("data-shown")).toBeNull();
  expect(pill().hasAttribute("inert")).toBe(true);
  expect(pill().textContent).toContain("2 new");
});

test("a table that isn't live has no pill", () => {
  render(
    <DataTable id="fruit" label="Fruit" columns={columns} data={many(3)} sample={many(3)} getRowId={(f) => f.id} rowName={(f) => f.name} paging={{ mode: "infinite", hasMore: false, loadingMore: false, onLoadMore: () => {} }} />,
  );
  expect(document.querySelector("[data-new-rows]")).toBeNull();
});
