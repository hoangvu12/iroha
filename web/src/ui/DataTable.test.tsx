import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Button } from "./Button";
import { type DataTableProps, type PaginationState, DataTable, RowMenu, columnsFor } from "./DataTable";
import { MenuItem } from "./Menu";

const agent = createAgent();

type Fruit = { id: string; name: string; colour: string; weight: number };

const FRUITS: Fruit[] = [
  { id: "1", name: "banana", colour: "yellow", weight: 120 },
  { id: "2", name: "apple", colour: "red", weight: 180 },
  { id: "3", name: "cherry", colour: "red", weight: 8 },
];
const SAMPLE: Fruit[] = FRUITS;
const many = (n: number): Fruit[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), name: `fruit-${String(i + 1).padStart(3, "0")}`, colour: "green", weight: i }));

const col = columnsFor<Fruit>();
const columns = col.columns([
  col.accessor("name", { header: "Name", sortFn: "alphanumeric", meta: { opens: true } }),
  col.accessor("colour", { header: "Colour", enableSorting: false }),
  col.accessor("weight", { header: "Weight", meta: { align: "right" } }),
]);

function Fruits(p: Partial<DataTableProps<Fruit>>) {
  return (
    <DataTable
      id="fruit"
      label="Fruit"
      columns={columns}
      data={FRUITS}
      sample={SAMPLE}
      getRowId={(f) => f.id}
      rowName={(f) => f.name}
      defaultSorting={[{ id: "name", desc: false }]}
      {...p}
    />
  );
}

const bodyRows = () => within(screen.getByRole("table", { name: "Fruit" })).getAllByRole("row").slice(1);
const names = () => bodyRows().map((r) => within(r).getAllByRole("cell").find((c) => c.textContent && !c.querySelector("[role=checkbox]"))?.textContent);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a header sorts its column: aria-sort says which way, a second press turns it round", async () => {
  const user = userEvent.setup();
  render(<Fruits />);
  expect(names()).toEqual(["apple", "banana", "cherry"]);
  const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
  expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");

  await user.click(screen.getByRole("button", { name: "Sort by Name" }));
  expect(nameHeader.getAttribute("aria-sort")).toBe("descending");
  expect(names()).toEqual(["cherry", "banana", "apple"]);

  screen.getByRole("button", { name: "Sort by Weight" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("columnheader", { name: /Weight/ }).getAttribute("aria-sort")).toBe("ascending");
  expect(names()).toEqual(["cherry", "banana", "apple"]);
  expect(screen.queryByRole("button", { name: "Sort by Colour" })).toBeNull();
});

test("a controlled sort reports the change and draws what it is given", async () => {
  const user = userEvent.setup();
  const onSortingChange = vi.fn();
  render(<Fruits sorting={[{ id: "weight", desc: true }]} onSortingChange={onSortingChange} />);
  expect(names()).toEqual(["apple", "banana", "cherry"]);
  await user.click(screen.getByRole("button", { name: "Sort by Name" }));
  expect(onSortingChange).toHaveBeenCalledWith([{ id: "name", desc: false }]);
});

test("selecting rows turns the toolbar into the bulk bar; Shift selects a range; Clear selection empties it", async () => {
  const user = userEvent.setup();
  const seen = vi.fn();
  render(
    <Fruits
      toolbar={<span>Search here</span>}
      bulk={({ rows }) => {
        seen(rows.map((r) => r.name).sort());
        return <Button>Eat</Button>;
      }}
    />,
  );
  expect(screen.getByText("Search here")).toBeTruthy();
  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  expect(screen.getByRole("group", { name: "1 selected" })).toBeTruthy();
  expect(screen.queryByText("Search here")).toBeNull();
  expect(screen.getByRole("button", { name: "Eat" })).toBeTruthy();
  expect(bodyRows()[0].hasAttribute("data-selected")).toBe(true);

  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("checkbox", { name: "Select cherry" }));
  await user.keyboard("{/Shift}");
  expect(screen.getByRole("group", { name: "3 selected" })).toBeTruthy();
  expect(seen).toHaveBeenLastCalledWith(["apple", "banana", "cherry"]);
  expect(screen.getByRole("checkbox", { name: "Unselect all rows on this page" }).getAttribute("aria-checked")).toBe("true");

  await user.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(screen.queryByRole("group", { name: /selected/ })).toBeNull();
  expect(screen.getByText("Search here")).toBeTruthy();
});

test("the header box selects the page, shows mixed when some are, and selected rows that leave the data are forgotten", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Fruits bulk={() => null} />);
  await user.click(screen.getByRole("checkbox", { name: "Select banana" }));
  expect(screen.getByRole("checkbox", { name: "Select all rows on this page" }).getAttribute("aria-checked")).toBe("mixed");
  await user.click(screen.getByRole("checkbox", { name: "Select all rows on this page" }));
  expect(screen.getByRole("group", { name: "3 selected" })).toBeTruthy();
  rerender(<Fruits bulk={() => null} data={FRUITS.filter((f) => f.name !== "banana")} />);
  await waitFor(() => expect(screen.getByRole("group", { name: "2 selected" })).toBeTruthy());
});

test("a row click opens the row, its Open button does too, and its controls and menu don't", async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  const ate = vi.fn();
  render(
    <Fruits
      bulk={() => null}
      onRowClick={(f) => opened(f.name)}
      rowActions={(f) => (
        <RowMenu name={f.name}>
          <MenuItem onSelect={() => ate(f.name)}>Eat</MenuItem>
        </RowMenu>
      )}
    />,
  );
  await user.click(within(bodyRows()[1]).getByText("yellow"));
  expect(opened).toHaveBeenLastCalledWith("banana");
  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  await user.click(screen.getByRole("button", { name: "More for cherry" }));
  await user.click(await screen.findByRole("menuitem", { name: "Eat" }));
  expect(ate).toHaveBeenCalledWith("cherry");
  expect(opened).toHaveBeenCalledTimes(1);

  screen.getByRole("button", { name: "Open apple" }).focus();
  await user.keyboard("{Enter}");
  expect(opened).toHaveBeenLastCalledWith("apple");
  expect(opened).toHaveBeenCalledTimes(2);
});

function SelectableFruits(p: Partial<DataTableProps<Fruit>> & { opened: (name: string) => void; ate?: (name: string) => void }) {
  const { opened, ate = () => {}, ...rest } = p;
  return (
    <Fruits
      bulk={() => <Button>Eat</Button>}
      onRowClick={(f) => opened(f.name)}
      rowActions={(f) => (
        <RowMenu name={f.name}>
          <MenuItem onSelect={() => opened(f.name)}>Open</MenuItem>
          <MenuItem onSelect={() => ate(f.name)}>Eat</MenuItem>
        </RowMenu>
      )}
      {...rest}
    />
  );
}
const checked = (name: string) => screen.getByRole("checkbox", { name: `Select ${name}` }).getAttribute("aria-checked");

test("select mode: once a row is selected, a click anywhere on a row toggles it instead of opening it", async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  render(<SelectableFruits opened={opened} />);
  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  expect(screen.getByRole("group", { name: "1 selected" })).toBeTruthy();

  await user.click(within(bodyRows()[1]).getByText("yellow"));
  expect(checked("banana")).toBe("true");
  expect(screen.getByRole("group", { name: "2 selected" })).toBeTruthy();
  await user.click(within(bodyRows()[0]).getByText("180"));
  expect(checked("apple")).toBe("false");
  expect(opened).not.toHaveBeenCalled();

  await user.click(within(bodyRows()[1]).getByText("yellow"));
  expect(screen.queryByRole("group", { name: /selected/ })).toBeNull();
  await user.click(within(bodyRows()[2]).getByText("8"));
  expect(opened).toHaveBeenCalledWith("cherry");
});

test("select mode: Shift+click on a row selects the range from the last one picked", async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  render(<SelectableFruits opened={opened} data={many(6)} />);
  await user.click(screen.getByRole("checkbox", { name: "Select fruit-002" }));
  await user.keyboard("{Shift>}");
  await user.click(within(bodyRows()[4]).getByText("4"));
  await user.keyboard("{/Shift}");
  expect(screen.getByRole("group", { name: "4 selected" })).toBeTruthy();
  expect(["fruit-001", "fruit-002", "fruit-003", "fruit-004", "fruit-005", "fruit-006"].map(checked)).toEqual(["false", "true", "true", "true", "true", "false"]);
  expect(opened).not.toHaveBeenCalled();
});

test("select mode: the name's Open button and the row menu's Open still open the row", async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  render(<SelectableFruits opened={opened} />);
  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  await user.click(screen.getByRole("button", { name: "Open banana" }));
  expect(opened).toHaveBeenLastCalledWith("banana");
  await user.click(screen.getByRole("button", { name: "More for cherry" }));
  await user.click(await screen.findByRole("menuitem", { name: "Open" }));
  expect(opened).toHaveBeenLastCalledWith("cherry");
  expect(screen.getByRole("group", { name: "1 selected" })).toBeTruthy();
  expect(checked("banana")).toBe("false");
  expect(checked("cherry")).toBe("false");
});

test("the checkbox's whole cell selects the row, in and out of select mode, and never opens it", async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  render(<SelectableFruits opened={opened} />);
  const cell = screen.getByRole("checkbox", { name: "Select banana" }).closest("td")!;
  await user.click(cell);
  expect(checked("banana")).toBe("true");
  await user.click(cell);
  expect(checked("banana")).toBe("false");
  const head = screen.getByRole("checkbox", { name: "Select all rows on this page" }).closest("th")!;
  await user.click(head);
  expect(screen.getByRole("group", { name: "3 selected" })).toBeTruthy();
  expect(opened).not.toHaveBeenCalled();
});

test("select mode: buttons and links keep their own Space and Enter; Space on the row's box toggles it", async () => {
  const user = userEvent.setup();
  const opened = vi.fn();
  const linked = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
  const withLink = col.columns([
    ...columns,
    col.display({ id: "where", header: "Where", cell: ({ row }) => <a href={`#${row.original.name}`} onClick={linked}>Shop of {row.original.name}</a> }),
  ]);
  render(<SelectableFruits opened={opened} columns={withLink} />);
  screen.getByRole("button", { name: "Open cherry" }).focus();
  await user.keyboard(" ");
  expect(opened).toHaveBeenLastCalledWith("cherry");

  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  screen.getByRole("button", { name: "Open banana" }).focus();
  await user.keyboard(" ");
  expect(opened).toHaveBeenLastCalledWith("banana");
  expect(checked("banana")).toBe("false");
  await user.keyboard("{Enter}");
  expect(opened).toHaveBeenCalledTimes(3);
  expect(checked("banana")).toBe("false");
  screen.getByRole("link", { name: "Shop of banana" }).focus();
  await user.keyboard(" ");
  expect(checked("banana")).toBe("false");
  await user.keyboard("{Enter}");
  expect(linked).toHaveBeenCalledTimes(1);
  screen.getByRole("checkbox", { name: "Select banana" }).focus();
  await user.keyboard(" ");
  expect(checked("banana")).toBe("true");
  expect(screen.getByRole("group", { name: "2 selected" })).toBeTruthy();
});

test("an agent in select mode selects rows by their boxes and still opens one by its name", async () => {
  const opened = vi.fn();
  render(<SelectableFruits opened={opened} />);
  const run = await agent.act({
    steps: [
      { ref: "Select apple", action: "toggle" },
      { ref: "Select cherry", action: "toggle" },
    ],
  });
  expect(run.ok, run.error?.message).toBe(true);
  const labels = agent.snapshot().filter((e) => !e.offPage).map((e) => e.label);
  for (const l of ["Clear selection", "Select banana", "Open banana", "More for banana"]) expect(labels, `${l} is missing`).toContain(l);
  const open = await agent.act({ steps: [{ ref: "Open banana", action: "press" }] });
  expect(open.ok, open.error?.message).toBe(true);
  expect(opened).toHaveBeenCalledWith("banana");
  expect(screen.getByRole("group", { name: "2 selected" })).toBeTruthy();
});

test("pages of 25: numbered pages and Next move through them; the page size picked is remembered for this table", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Fruits data={many(60)} footer={(c) => `${c.from}–${c.to} of ${c.shown}`} />);
  expect(bodyRows()).toHaveLength(25);
  expect(screen.getByText("1–25 of 60")).toBeTruthy();
  const pages = screen.getByRole("navigation", { name: "Pages of Fruit" });
  expect(within(pages).getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe("page");

  await user.click(within(pages).getByRole("button", { name: "Next page" }));
  expect(names()[0]).toBe("fruit-026");
  await user.click(within(pages).getByRole("button", { name: "Page 3" }));
  expect(bodyRows()).toHaveLength(10);
  expect(screen.getByText("51–60 of 60")).toBeTruthy();

  await user.click(screen.getByRole("combobox", { name: "Rows per page" }));
  await user.click(await screen.findByRole("option", { name: "50 per page" }));
  expect(bodyRows()).toHaveLength(50);
  expect(names()[0]).toBe("fruit-001");

  unmount();
  render(<Fruits data={many(60)} />);
  expect(bodyRows()).toHaveLength(50);
});

test("a page size can't be remembered when storage is refused, and the table still works", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const user = userEvent.setup();
  render(<Fruits data={many(60)} />);
  expect(bodyRows()).toHaveLength(25);
  await user.click(screen.getByRole("combobox", { name: "Rows per page" }));
  await user.click(await screen.findByRole("option", { name: "100 per page" }));
  expect(bodyRows()).toHaveLength(60);
  vi.restoreAllMocks();
});

test("a new search starts again on page 1, and a search that matches nothing shows the filters with Clear filters", async () => {
  const user = userEvent.setup();
  const cleared = vi.fn();
  const Page = () => {
    const [q, setQ] = useState("");
    return (
      <>
        <Button onClick={() => setQ("fruit-05")}>Find</Button>
        <Button onClick={() => setQ("kiwi")}>Find kiwi</Button>
        <Fruits data={many(60)} search={q} filterChips={q ? [{ label: `Search: ${q}`, onRemove: () => setQ("") }] : []} noResultsTitle="No fruit match" onClearFilters={cleared} />
      </>
    );
  };
  render(<Page />);
  await user.click(screen.getByRole("button", { name: "Page 2" }));
  await user.click(screen.getByRole("button", { name: "Find" }));
  expect(names()).toEqual(Array.from({ length: 10 }, (_, i) => `fruit-05${i}`));
  await user.click(screen.getByRole("button", { name: "Find kiwi" }));
  expect(screen.getByText("No fruit match")).toBeTruthy();
  expect(screen.getByText("Search: kiwi")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(cleared).toHaveBeenCalled();
});

test("a column filter matches by the column's filterFn", () => {
  const cols = col.columns([
    col.accessor("name", { header: "Name" }),
    col.accessor("colour", { header: "Colour", filterFn: "equals" }),
  ]);
  render(<Fruits columns={cols} columnFilters={[{ id: "colour", value: "red" }]} />);
  expect(names()).toEqual(["apple", "cherry"]);
});

test("server pages: a page press asks for that page (0-based state, 1-based buttons) and the rows are drawn as given", async () => {
  const user = userEvent.setup();
  const Page = () => {
    const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 25 });
    const rows = many(130).slice(pagination.pageIndex * 25, pagination.pageIndex * 25 + 25);
    return <Fruits data={rows} paging={{ mode: "server", pagination, onPaginationChange: setPagination, rowCount: 130 }} manualSorting footer={(c) => `${c.from}–${c.to} of ${c.shown}`} />;
  };
  render(<Page />);
  expect(screen.getByText("1–25 of 130")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Page 6" }));
  expect(names()).toEqual(Array.from({ length: 5 }, (_, i) => `fruit-${126 + i}`));
  expect(screen.getByText("126–130 of 130")).toBeTruthy();
});

test("infinite: no pages; the end of the list loads more (Load more for the keyboard), and nothing more when there is none", async () => {
  const user = userEvent.setup();
  const onLoadMore = vi.fn();
  const { rerender } = render(<Fruits data={many(60)} paging={{ mode: "infinite", hasMore: true, loadingMore: false, onLoadMore, moreLabel: "Show older" }} />);
  expect(bodyRows()).toHaveLength(60);
  expect(screen.queryByRole("navigation", { name: "Pages of Fruit" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show older" }));
  expect(onLoadMore).toHaveBeenCalledTimes(1);
  rerender(<Fruits data={many(60)} paging={{ mode: "infinite", hasMore: false, loadingMore: false, onLoadMore }} />);
  expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
});

test("infinite: the end coming into the window loads more (the page scrolls the rows, not the table)", () => {
  let fire: (e: { isIntersecting: boolean }[]) => void = () => {};
  let root: unknown = "unset";
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: typeof fire, opts?: IntersectionObserverInit) {
        fire = cb;
        root = opts?.root;
      }
      observe() {}
      disconnect() {}
    },
  );
  const onLoadMore = vi.fn();
  render(<Fruits paging={{ mode: "infinite", hasMore: true, loadingMore: false, onLoadMore }} />);
  expect(root).toBeNull();
  fire([{ isIntersecting: true }]);
  expect(onLoadMore).toHaveBeenCalledTimes(1);
});

test("a long table is as tall as its rows: its scroller only scrolls sideways, and the header moves with the page", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "TABLE" ? 100 * 48 + 40 : this.tagName === "THEAD" ? 40 : 0;
  });
  render(<Fruits data={many(100)} paging={{ mode: "none" }} />);
  expect(bodyRows()).toHaveLength(100);
  const region = screen.getByRole("region", { name: "Fruit" });
  expect(region.className).not.toMatch(/max-h-/);
  expect(region.style.getPropertyValue("--table-stick-end")).toBe(`${100 * 48}px`);
});

test("loading shows the skeleton, an error shows Try again, no rows shows the empty state", async () => {
  const user = userEvent.setup();
  const retry = vi.fn();
  const { rerender } = render(<Fruits data={undefined} />);
  expect(screen.getByText("Loading Fruit")).toBeTruthy();
  rerender(<Fruits data={undefined} error={new Error("down")} onRetry={retry} />);
  expect(screen.getByText("Couldn't load Fruit")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalled();
  rerender(<Fruits data={[]} empty={<p>No fruit yet</p>} />);
  expect(screen.getByText("No fruit yet")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

test("the skeleton's sample rows open nothing: no row, Open button, row menu or checkbox reacts", async () => {
  const opened = vi.fn();
  const menu = vi.fn();
  const { container } = render(
    <Fruits
      data={undefined}
      onRowClick={opened}
      bulk={() => null}
      rowActions={(f) => (
        <RowMenu name={f.name}>
          <MenuItem onSelect={() => menu(f.name)}>Eat</MenuItem>
        </RowMenu>
      )}
    />,
  );
  const sampleRows = container.querySelectorAll("[skullet-loading] tbody tr");
  expect(sampleRows.length).toBe(SAMPLE.length);
  for (const row of sampleRows) {
    for (const el of [row, ...row.querySelectorAll("td, button, [role=checkbox]")]) {
      fireEvent.pointerDown(el);
      fireEvent.mouseDown(el);
      fireEvent.click(el);
      fireEvent.keyDown(el, { key: "Enter" });
      fireEvent.keyDown(el, { key: " " });
    }
  }
  expect(opened).not.toHaveBeenCalled();
  expect(menu).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("button", { name: /Clear selection/ })).toBeNull();
});

test("many rows arriving over a skeleton: a screenful comes with the reveal, the rest right after", async () => {
  const footer = ({ shown }: { shown: number }) => `${shown} fruit`;
  const { rerender } = render(<Fruits data={undefined} paging={{ mode: "none" }} footer={footer} />);
  rerender(<Fruits data={many(100)} paging={{ mode: "none" }} footer={footer} />);
  expect(bodyRows()).toHaveLength(30);
  expect(names().slice(0, 3)).toEqual(["fruit-001", "fruit-002", "fruit-003"]);
  expect(screen.getByText("100 fruit")).toBeTruthy();
  await waitFor(() => expect(bodyRows()).toHaveLength(100));
});

test("rows that are there from the start, or few, all come at once", () => {
  const { rerender } = render(<Fruits data={many(100)} paging={{ mode: "none" }} />);
  expect(bodyRows()).toHaveLength(100);
  rerender(<Fruits data={undefined} key="b" paging={{ mode: "none" }} />);
  rerender(<Fruits data={many(30)} key="b" paging={{ mode: "none" }} />);
  expect(bodyRows()).toHaveLength(30);
});

test("expandable rows: the chevron shows the details under the row", async () => {
  const user = userEvent.setup();
  render(<Fruits renderExpanded={(f) => <p>{f.name} weighs {f.weight} g</p>} />);
  const show = screen.getByRole("button", { name: "Show details of apple" });
  expect(show.getAttribute("aria-expanded")).toBe("false");
  await user.click(show);
  expect(screen.getByText("apple weighs 180 g")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Hide details of apple" }));
  expect(screen.queryByText("apple weighs 180 g")).toBeNull();
});

test("expandable rows without onRowClick: a click on the row shows its details, a click on its own controls doesn't", async () => {
  const user = userEvent.setup();
  const ate = vi.fn();
  render(<Fruits renderExpanded={(f) => <p>{f.name} weighs {f.weight} g</p>} rowActions={(f) => <Button onClick={() => ate(f.name)}>Eat {f.name}</Button>} />);
  await user.click(screen.getByRole("button", { name: "Eat apple" }));
  expect(ate).toHaveBeenCalledWith("apple");
  expect(screen.queryByText("apple weighs 180 g")).toBeNull();
  await user.click(within(bodyRows()[0]).getByText("red"));
  expect(screen.getByText("apple weighs 180 g")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide details of apple" }).getAttribute("aria-expanded")).toBe("true");
  await user.click(within(bodyRows()[0]).getByText("red"));
  expect(screen.queryByText("apple weighs 180 g")).toBeNull();
});

test("phones: an expandable row has its chevron at the end and shows its details under it", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
  const user = userEvent.setup();
  render(<Fruits renderExpanded={(f) => <p>{f.name} weighs {f.weight} g</p>} phoneRow={(f) => <span>{f.name}</span>} />);
  const list = screen.getByRole("list", { name: "Fruit" });
  const show = within(list).getByRole("button", { name: "Show details of apple" });
  expect(show.getAttribute("aria-expanded")).toBe("false");
  await user.click(show);
  expect(within(list).getAllByRole("listitem")[0].textContent).toContain("apple weighs 180 g");
  await user.click(within(list).getByText("apple"));
  expect(screen.queryByText("apple weighs 180 g")).toBeNull();
});

test("phones get two-line rows: tap opens, Select shows checkboxes", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
  const user = userEvent.setup();
  const opened = vi.fn();
  render(
    <Fruits
      bulk={() => <Button>Eat</Button>}
      onRowClick={(f) => opened(f.name)}
      phoneRow={(f) => (
        <span>
          {f.name} / {f.colour}
        </span>
      )}
    />,
  );
  expect(screen.queryByRole("table")).toBeNull();
  const list = screen.getByRole("list", { name: "Fruit" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  await user.click(screen.getByRole("button", { name: "Open apple" }));
  expect(opened).toHaveBeenCalledWith("apple");
  await user.click(screen.getByRole("button", { name: "Select" }));
  await user.click(screen.getByText("banana / yellow"));
  expect(screen.getByRole("group", { name: "1 selected" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Select banana" }).getAttribute("aria-checked")).toBe("true");
});

test("phones: phoneActions sit beside a row that opens, and their presses don't open it", async () => {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
  const user = userEvent.setup();
  const opened = vi.fn();
  const eaten = vi.fn();
  render(
    <Fruits
      onRowClick={(f) => opened(f.name)}
      phoneRow={(f) => <span>{f.name}</span>}
      phoneActions={(f) => <Button onClick={() => eaten(f.name)}>Eat {f.name}</Button>}
    />,
  );
  const item = within(screen.getByRole("list", { name: "Fruit" })).getAllByRole("listitem")[0];
  expect(within(item).getByRole("button", { name: "Open apple" })).toBeTruthy();
  await user.click(within(item).getByRole("button", { name: "Eat apple" }));
  expect(eaten).toHaveBeenCalledWith("apple");
  expect(opened).not.toHaveBeenCalled();
});

test("an agent sorts, selects, opens a row's menu and pages", async () => {
  const ate = vi.fn();
  render(
    <Fruits
      data={many(30)}
      bulk={({ rows }) => <Button onClick={() => ate(rows.map((r) => r.name))}>Eat selected</Button>}
      rowActions={(f) => (
        <RowMenu name={f.name}>
          <MenuItem onSelect={() => ate([f.name])}>Eat</MenuItem>
        </RowMenu>
      )}
    />,
  );
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Sort by Name", "Sort by Weight", "Select all rows on this page", "Select fruit-001", "More for fruit-001", "Rows per page", "Pages of Fruit", "Fruit"])
    expect(labels, `${l} is missing`).toContain(l);

  const run = await agent.act({
    steps: [
      { ref: "Sort by Weight", action: "press" },
      { ref: "Select fruit-002", action: "toggle" },
      { ref: "More for fruit-003", action: "press", args: ["Eat"] },
    ],
  });
  expect(run.ok, run.error?.message).toBe(true);
  expect(ate).toHaveBeenCalledWith(["fruit-003"]);
  expect(screen.getByRole("columnheader", { name: /Weight/ }).getAttribute("aria-sort")).toBe("ascending");
  const bulk = await agent.act({ steps: [{ ref: "Eat selected", action: "press" }] });
  expect(bulk.ok, bulk.error?.message).toBe(true);
  expect(ate).toHaveBeenLastCalledWith(["fruit-002"]);

  const page = await agent.act({ steps: [{ ref: "Pages of Fruit", action: "next" }] });
  expect(page.ok, page.error?.message).toBe(true);
  expect(names()[0]).toBe("fruit-026");
  const size = await agent.act({ steps: [{ ref: "Rows per page", action: "setValue", args: ["50"] }] });
  expect(size.ok, size.error?.message).toBe(true);
  expect(bodyRows()).toHaveLength(30);
});

function layOut() {
  const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const y = page().scrollTop;
    if (this.hasAttribute("data-row-id")) {
      const i = [...this.parentElement!.children].indexOf(this);
      return box(140 + i * 48 - y, 48);
    }
    if (this.tagName === "THEAD") return box(Math.max(0, 100 - y), 40);
    return box(0, 0);
  });
}
const page = () => document.documentElement;
function scrollPage(top: number) {
  page().scrollTop = top;
  fireEvent.scroll(document);
}
afterEach(() => {
  page().scrollTop = 0;
});
const live = (data: Fruit[]) => (
  <Fruits data={data} defaultSorting={[]} paging={{ mode: "infinite", hasMore: false, loadingMore: false, onLoadMore: () => {}, newRowsLabel: (n) => `${n} new` }} />
);
const arrived = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `new-${n - 1 - i}`, name: `new-${n - 1 - i}`, colour: "blue", weight: 0 }));

test("the open row is marked current", () => {
  render(<Fruits activeRowId="2" />);
  const current = bodyRows().filter((r) => r.getAttribute("aria-current") === "true");
  expect(current).toHaveLength(1);
  expect(within(current[0]).getByText("apple")).toBeTruthy();
});

test("live rows: the page scrolled down, rows arriving on top keep the view still, and a pill counts them and goes back to the top", async () => {
  layOut();
  const user = userEvent.setup();
  const rows = many(40);
  const { rerender } = render(live(rows));
  scrollPage(580);
  rerender(live([...arrived(2), ...rows]));
  expect(page().scrollTop).toBe(580 + 2 * 48);
  expect(screen.getByRole("button", { name: "2 new" })).toBeTruthy();
  rerender(live([...arrived(3), ...rows]));
  expect(page().scrollTop).toBe(580 + 3 * 48);
  await user.click(screen.getByRole("button", { name: "3 new" }));
  expect(page().scrollTop).toBe(100);
  expect(screen.queryByRole("button", { name: /new$/ })).toBeNull();
});

test("a row arriving on top keeps the rows under it as they are (no remount: hover, focus and flashes stay)", () => {
  const rows = many(5);
  const { rerender } = render(live(rows));
  const before = bodyRows();
  rerender(live([...arrived(1), ...rows]));
  const after = bodyRows().slice(1);
  expect(after).toHaveLength(before.length);
  after.forEach((row, i) => expect(row, `row ${i} was drawn again`).toBe(before[i]));
});

test("live rows: at the top they come in on top; with the pointer over the rows they wait above the view", async () => {
  layOut();
  const user = userEvent.setup();
  const rows = many(40);
  const { rerender } = render(live(rows));
  scrollPage(100);
  rerender(live([...arrived(1), ...rows]));
  expect(page().scrollTop).toBe(100);
  expect(names()[0]).toBe("new-0");
  expect(screen.queryByRole("button", { name: /new$/ })).toBeNull();

  await user.hover(screen.getByText("fruit-003"));
  rerender(live([...arrived(2), ...rows]));
  expect(page().scrollTop).toBe(148);
  expect(screen.getByRole("button", { name: "1 new" })).toBeTruthy();
  scrollPage(100);
  await waitFor(() => expect(screen.queryByRole("button", { name: "1 new" })).toBeNull());
});

test("infinite: a load that leaves the end in view loads again, until there is no more", () => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: (e: { isIntersecting: boolean }[]) => void;
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        this.cb = cb;
      }
      observe() {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  const onLoadMore = vi.fn();
  const paging = (loadingMore: boolean, hasMore = true) => ({ mode: "infinite" as const, hasMore, loadingMore, onLoadMore });
  const { rerender } = render(<Fruits paging={paging(false)} />);
  expect(onLoadMore).toHaveBeenCalledTimes(1);
  rerender(<Fruits paging={paging(true)} />);
  rerender(<Fruits paging={paging(false)} />);
  expect(onLoadMore).toHaveBeenCalledTimes(2);
  rerender(<Fruits paging={paging(false, false)} />);
  expect(onLoadMore).toHaveBeenCalledTimes(2);
});
