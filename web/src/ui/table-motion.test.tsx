import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import css from "@/styles/index.css?raw";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { CopyButton } from "./CopyButton";
import { type DataTableProps, DataTable, columnsFor } from "./DataTable";
import { DONE_MS, SaveStatus, useSave } from "./SaveStatus";
import { Segmented } from "./Segmented";
import { Switch } from "./Switch";

// Motion of the tables (UI ticket 16): rows added or removed after an action
// enter and leave, the bulk bar leaves as one crossfade with the toolbar, a
// slow page change dims, and the shared table controls take their values from
// the motion tokens. jsdom has no transitions: a stubbed running animation
// keeps an exit going until the test ends it, as in app/ChatSheet.test.tsx.

type Fruit = { id: string; name: string };
const FRUITS: Fruit[] = [
  { id: "1", name: "apple" },
  { id: "2", name: "banana" },
  { id: "3", name: "cherry" },
];
const col = columnsFor<Fruit>();
const columns = col.columns([col.accessor("name", { header: "Name", sortFn: "alphanumeric" })]);

function Fruits(p: Partial<DataTableProps<Fruit>>) {
  return <DataTable id="fruit" label="Fruit" columns={columns} data={FRUITS} sample={FRUITS} getRowId={(f) => f.id} rowName={(f) => f.name} {...p} />;
}

const rowEl = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-rows] > [data-row-id="${id}"]`);
const bodyRows = () => within(screen.getByRole("table", { name: "Fruit" })).getAllByRole("row").slice(1);
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

let endTransitions = () => {};
function runningTransitions() {
  let end = () => {};
  const finished = new Promise<void>((r) => (end = r));
  endTransitions = () => act(end);
  const running = { finished, cancel() {}, finish() {}, effect: { getComputedTiming: () => ({ endTime: 60_000, localTime: 0 }) } } as unknown as Animation;
  Element.prototype.getAnimations = () => [running];
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  Element.prototype.getAnimations = () => [];
});

test("a row removed from the data stays where it was, hidden from readers and inert, while it fades; then it leaves", async () => {
  runningTransitions();
  const { container, rerender } = render(<Fruits />);
  rerender(<Fruits data={FRUITS.filter((f) => f.id !== "2")} />);
  const gone = rowEl(container, "2")!;
  expect(gone).not.toBeNull();
  expect(gone.hasAttribute("data-ending-style")).toBe(true);
  expect(gone.hasAttribute("inert")).toBe(true);
  expect(gone.getAttribute("aria-hidden")).toBe("true");
  // In its old place, between the rows still there; readers only see those.
  expect([...container.querySelectorAll("[data-rows] > [data-row-id]")].map((r) => r.getAttribute("data-row-id"))).toEqual(["1", "2", "3"]);
  expect(bodyRows()).toHaveLength(2);
  // Opacity only, the list-out duration.
  expect(classesOf(gone)).toEqual(expect.arrayContaining(["data-ending-style:opacity-0", "data-ending-style:duration-list-out"]));
  endTransitions();
  await waitFor(() => expect(rowEl(container, "2")).toBeNull());
});

test("a row added to the data enters from its starting style (shift-sm and a fade), which then lifts", async () => {
  const { container, rerender } = render(<Fruits />);
  rerender(<Fruits data={[...FRUITS, { id: "4", name: "damson" }]} />);
  const added = rowEl(container, "4")!;
  expect(added.hasAttribute("data-starting-style")).toBe(true);
  expect(rowEl(container, "1")!.hasAttribute("data-starting-style")).toBe(false);
  expect(classesOf(added)).toEqual(
    expect.arrayContaining(["transition-[opacity,translate]", "duration-list-in", "ease-out", "data-starting-style:translate-y-(--motion-shift-sm)", "data-starting-style:opacity-0"]),
  );
  await waitFor(() => expect(added.hasAttribute("data-starting-style")).toBe(false));
});

test("sorting, searching, a new page, the first load and a whole new data set move no rows", async () => {
  runningTransitions();
  const user = userEvent.setup();
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), name: `fruit-${String(i + 1).padStart(2, "0")}` }));
  const { container, rerender } = render(<Fruits data={undefined} />);
  rerender(<Fruits data={many} />);
  const marked = () => container.querySelectorAll("[data-starting-style], [data-ending-style]").length;
  expect(marked()).toBe(0);
  await user.click(screen.getByRole("button", { name: "Sort by Name" }));
  expect(marked()).toBe(0);
  await user.click(screen.getByRole("button", { name: "Page 2" }));
  expect(marked()).toBe(0);
  rerender(<Fruits data={many} search="fruit-0" />);
  expect(marked()).toBe(0);
  // Another record's rows (no row in common): drawn at once.
  rerender(<Fruits data={[{ id: "x", name: "xigua" }]} />);
  expect(marked()).toBe(0);
  expect(rowEl(container, "1")).toBeNull();
});

test("server and infinite tables add no row motion (the Requests feed animates its own arrivals)", () => {
  const paging = { mode: "infinite" as const, hasMore: false, loadingMore: false, onLoadMore: () => {} };
  const { container, rerender } = render(<Fruits paging={paging} />);
  rerender(<Fruits paging={paging} data={[{ id: "0", name: "akee" }, ...FRUITS.slice(1)]} />);
  expect(container.querySelectorAll("[data-starting-style], [data-ending-style]").length).toBe(0);
  expect(rowEl(container, "1")).toBeNull();
});

test("clearing the selection: the bar fades out in place, inert, while the toolbar fades back in under it", async () => {
  runningTransitions();
  const user = userEvent.setup();
  const { container } = render(<Fruits bulk={() => <Button>Delete</Button>} toolbar={<input aria-label="Search fruit" />} />);
  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  const bar = screen.getByRole("group", { name: "1 selected" });
  expect(screen.queryByRole("textbox", { name: "Search fruit" })).toBeNull();
  // A synchronous click: the toolbar's starting style lasts one frame.
  fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  // Still drawn with what it said, leaving: opacity only, list-out.
  expect(bar.isConnected).toBe(true);
  expect(bar.textContent).toContain("1 selected");
  expect(bar.hasAttribute("data-ending-style")).toBe(true);
  expect(bar.hasAttribute("inert")).toBe(true);
  expect(classesOf(bar)).toEqual(expect.arrayContaining(["data-ending-style:opacity-0", "data-ending-style:duration-list-out"]));
  const toolbar = screen.getByRole("textbox", { name: "Search fruit" }).parentElement!;
  expect(toolbar.hasAttribute("data-starting-style")).toBe(true);
  expect(classesOf(toolbar)).toEqual(expect.arrayContaining(["transition-opacity", "duration-fade", "data-starting-style:opacity-0"]));
  endTransitions();
  await waitFor(() => expect(container.querySelector("[data-bulk-bar]")).toBeNull());
});

test("selecting again while the bar leaves brings it back from where it is", async () => {
  runningTransitions();
  const user = userEvent.setup();
  render(<Fruits bulk={() => <Button>Delete</Button>} />);
  await user.click(screen.getByRole("checkbox", { name: "Select apple" }));
  const bar = screen.getByRole("group", { name: "1 selected" });
  await user.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(bar.hasAttribute("data-ending-style")).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: "Select banana" }));
  expect(bar.isConnected).toBe(true);
  expect(bar.hasAttribute("data-ending-style")).toBe(false);
  expect(bar.hasAttribute("inert")).toBe(false);
  expect(screen.getByRole("group", { name: "1 selected" })).toBe(bar);
});

test("dimmed rows dim only after the fade's length (a fast answer never flickers) and come back at once", () => {
  const { rerender } = render(<Fruits dimmed />);
  const table = screen.getByRole("table", { name: "Fruit" });
  expect(classesOf(table)).toEqual(expect.arrayContaining(["opacity-60", "transition-opacity", "duration-fade", "ease-out", "delay-(--duration-fade)"]));
  rerender(<Fruits />);
  expect(classesOf(table).filter((c) => c.startsWith("transition") || c.startsWith("opacity"))).toEqual([]);
});

test("expanded details fade in", async () => {
  const user = userEvent.setup();
  const { container } = render(<Fruits renderExpanded={(f) => <p>About {f.name}</p>} />);
  await user.click(screen.getByRole("button", { name: "Show details of apple" }));
  const cell = screen.getByText("About apple").closest("td")!;
  expect(classesOf(cell)).toEqual(expect.arrayContaining(["transition-opacity", "duration-fade", "ease-out", "starting:opacity-0"]));
  expect(container.querySelectorAll("[data-ending-style]").length).toBe(0);
});

// ---- Shared table controls: tokens only ----

function expectOnlyTokens(el: Element) {
  const typed = classesOf(el).filter((c) => /(^|:)(duration-[1-9]|scale-\d|ease-\[cubic)/.test(c) || c === "transition-transform");
  expect(typed, "typed motion values").toEqual([]);
  expect(classesOf(el)).not.toContain("motion-reduce:transition-none");
}

test("the segmented indicator slides by translate, never left, on the indicator token, and doesn't slide into its first place", () => {
  render(<Segmented label="Show" value="all" onChange={() => {}} items={[{ value: "all", label: "All" }, { value: "gaps", label: "Gaps" }]} />);
  const indicator = document.querySelector("[data-slot=segmented-control-indicator]")!;
  const c = classesOf(indicator);
  expect(c).toEqual(
    expect.arrayContaining([
      "translate-x-(--segmented-control-indicator-left)",
      "translate-y-(--segmented-control-indicator-top)",
      "transition-[translate,width]",
      "duration-indicator",
      "ease-out",
      "data-[activation-direction=none]:transition-none",
    ]),
  );
  expect(c.some((x) => x.startsWith("left-(") || x.startsWith("top-(") || x.includes("[left"))).toBe(false);
  expectOnlyTokens(indicator);
});

test("a switch's thumb moves on the press token and its track colours on hover's", () => {
  render(<Switch label="Enabled" checked onChange={() => {}} />);
  const track = screen.getByRole("switch", { name: "Enabled" });
  const thumb = track.querySelector("[data-slot=switch-thumb]") ?? track.firstElementChild!;
  expect(classesOf(thumb)).toEqual(expect.arrayContaining(["transition-[translate]", "duration-press", "ease-out"]));
  expect(classesOf(track)).toEqual(expect.arrayContaining(["transition-colors", "duration-hover", "ease-[ease]"]));
  expectOnlyTokens(thumb);
  expectOnlyTokens(track);
});

test("selection checkboxes and segmented items change colour only, on hover's duration and curve", () => {
  render(
    <>
      <Checkbox label="Select apple" checked={false} onChange={() => {}} />
      <Segmented label="Show" value="all" onChange={() => {}} items={[{ value: "all", label: "All" }]} />
    </>,
  );
  for (const el of [screen.getByRole("checkbox", { name: "Select apple" }), document.querySelector("[data-slot=segmented-control-item]")!]) {
    expect(classesOf(el)).toEqual(expect.arrayContaining(["transition-colors", "duration-hover", "ease-[ease]"]));
    expect(classesOf(el).some((c) => c.includes("scale"))).toBe(false);
    expectOnlyTokens(el);
  }
});

test("Copied crossfades in on the fade token", async () => {
  const user = userEvent.setup(); // stubs the Clipboard API
  render(<CopyButton icon value="sk-1" what="Key" />);
  await user.click(screen.getByRole("button", { name: "Copy the Key" }));
  const icon = await waitFor(() => screen.getByRole("button", { name: "Copied" }).querySelector("svg")!);
  expect(classesOf(icon)).toEqual(expect.arrayContaining(["transition-[scale,opacity]", "duration-fade", "ease-out", "starting:scale-(--motion-scale-popup)", "starting:opacity-0"]));
  expectOnlyTokens(icon);
});

function Saving() {
  const save = useSave();
  return (
    <>
      <Button onClick={() => void save.run(async () => ({}), { message: "Saved it" })}>Save</Button>
      <SaveStatus save={save} />
    </>
  );
}

test("a save's result fades in, and when its time is up fades out before it leaves", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Saving />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    const result = (await screen.findByText("Saved it", { ignore: "script, style, [data-ui-sdk-announcer]" })).parentElement!;
    expect(classesOf(result)).toEqual(expect.arrayContaining(["transition-opacity", "duration-fade", "ease-out", "starting:opacity-0"]));
    expectOnlyTokens(result);
    runningTransitions();
    await act(() => vi.advanceTimersByTimeAsync(DONE_MS + 10));
    expect(result.isConnected).toBe(true);
    expect(result.hasAttribute("data-ending-style")).toBe(true);
    expect(classesOf(result)).toEqual(expect.arrayContaining(["data-ending-style:opacity-0", "data-ending-style:duration-list-out"]));
    endTransitions();
    await waitFor(() => expect(result.isConnected).toBe(false));
  } finally {
    vi.useRealTimers();
  }
});

test("a row's quiet button: hidden until the row is hovered where there is hover, always shown on touch", () => {
  const rule = css.match(/@utility row-reveal \{[\s\S]*?\n\}/)?.[0] ?? "";
  expect(rule, "@utility row-reveal").not.toBe("");
  expect(rule).toMatch(/opacity:\s*0/);
  expect(rule).toMatch(/@media \(hover: hover\)[\s\S]*:where\(\.group\):hover/);
  expect(rule).toMatch(/@media \(hover: none\)[\s\S]*opacity:\s*1/);
  expect(rule).toMatch(/&:focus-visible/);
  expect(rule).toMatch(/\[data-copy\]/);
  expect(rule).not.toMatch(/transition/);
});

// Rows with a selection that leave are selected no more, and the bar leaves with them.
test("deleting the selected rows: they fade where they were and the bar leaves with them", async () => {
  runningTransitions();
  const user = userEvent.setup();
  function Harness() {
    const [data, setData] = useState(FRUITS);
    return <Fruits data={data} bulk={(sel) => <Button onClick={() => setData((d) => d.filter((f) => !sel.ids.includes(f.id)))}>Delete</Button>} />;
  }
  const { container } = render(<Harness />);
  await user.click(screen.getByRole("checkbox", { name: "Select banana" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(rowEl(container, "2")!.hasAttribute("data-ending-style")).toBe(true);
  expect(container.querySelector("[data-bulk-bar]")!.hasAttribute("data-ending-style")).toBe(true);
  endTransitions();
  await waitFor(() => expect(rowEl(container, "2")).toBeNull());
  await waitFor(() => expect(container.querySelector("[data-bulk-bar]")).toBeNull());
});
