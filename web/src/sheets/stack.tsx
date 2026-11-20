import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { RequestRecord } from "@/pages/requests/api";
import { readStack, recordKey, type SheetRecord, writeStack } from "./records";

// The open sheets (spec "Stacked sheets"): a flat list in the URL, oldest
// first. React state leads and the URL follows in the same event (UI SDK's
// controlled-value rule); Back, Forward and links lead the other way.

/**
 * One open sheet. `id` names the sheet itself, which keeps it while its record
 * changes in place (↑/↓, a tab, a record of the same kind opened over it);
 * `opened` changes each time `open` puts a record in it, so the sheet takes focus.
 */
export type SheetEntry = { id: number; record: SheetRecord; opened?: number };

/** History state on an entry pushed by opening a sheet: the search it was opened from, and the params the link dropped. */
type Pushed = { sheetBack?: string; dropped?: string[] };

type Stack = {
  stack: SheetEntry[];
  /**
   * Open a record from `from` (a sheet's index, -1 for the page): closes the sheets above `from`, or focuses the record if it is open already.
   * `drop` names search params to remove on the way (a dialog the URL holds, which the sheet replaces; Back brings it back).
   */
  open: (record: SheetRecord, from?: number, drop?: string[]) => void;
  /** Close the sheet at `index` and every sheet above it (default: the top one). */
  close: (index?: number) => void;
  /** Show another record (or tab) in the sheet at `index`, without a history entry. */
  replace: (index: number, record: SheetRecord) => void;
  /** The URL that shows the stack after `open(record, from, drop)`, for links' href. */
  hrefFor: (record: SheetRecord, from?: number, drop?: string[]) => string;
  /** The element focused when the sheet with this id was opened, for focus on close. */
  opener: (id: number) => Element | null;
  requestRows: RequestRecord[];
  setRequestRows: (rows: RequestRecord[]) => void;
};

const StackContext = createContext<Stack | null>(null);
const LevelContext = createContext(-1);

let nextId = 1;

/** Entries for `records`: a record already shown keeps its sheet; a sheet whose record went keeps its place for one of the same kind (Back after a swap). */
function toEntries(records: SheetRecord[], prev: SheetEntry[]): SheetEntry[] {
  const keys = new Set(records.map(recordKey));
  return records.map((record, i) => {
    const same = prev.find((e) => recordKey(e.record) === recordKey(record));
    if (same) return { ...same, record };
    const there = prev[i];
    if (there && there.record.kind === record.kind && !keys.has(recordKey(there.record))) return { ...there, record };
    return { id: nextId++, record };
  });
}

/** `search` without the params in `drop`. */
function without(search: string, drop?: string[]): string {
  if (!drop?.length) return search;
  const p = new URLSearchParams(search);
  for (const k of drop) p.delete(k);
  const s = p.toString();
  return s ? `?${s}` : "";
}

const sameStack = (a: SheetEntry[], b: SheetEntry[]) =>
  a.length === b.length && a.every((e, i) => e.id === b[i].id && JSON.stringify(e.record) === JSON.stringify(b[i].record));

let nextOpened = 1;

/**
 * The stack after opening `record` from `from`. A record of the same kind as
 * the sheet it would close takes that sheet's place (a feed row clicked while
 * a Request is open, another key from a Provider's list): the content swaps
 * and nothing slides out and in again.
 */
function opened(stack: SheetEntry[], record: SheetRecord, from: number): SheetEntry[] {
  const at = stack.findIndex((e) => recordKey(e.record) === recordKey(record));
  if (at >= 0) return stack.slice(0, at + 1);
  const kept = stack.slice(0, Math.max(0, from + 1));
  const over = stack[kept.length];
  const id = over && over.record.kind === record.kind ? over.id : nextId++;
  return [...kept, { id, record, opened: nextOpened++ }];
}

export function SheetStackProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const urlRecords = useMemo(() => readStack(location.search), [location.search]);

  const [state, setState] = useState(() => ({ url: urlRecords, stack: toEntries(urlRecords, []) }));
  let stack = state.stack;
  if (state.url !== urlRecords) {
    // The URL moved on its own (Back, Forward, a link, another page).
    const next = toEntries(urlRecords, state.stack);
    stack = sameStack(next, state.stack) ? state.stack : next;
    setState({ url: urlRecords, stack });
  }

  const latest = useRef({ stack, location });
  latest.current = { stack, location };
  const openers = useRef(new Map<number, Element | null>());

  const write = useCallback(
    (next: SheetEntry[], how: "push" | "close" | "replace", drop?: string[]) => {
      const { location: loc } = latest.current;
      setState((s) => ({ ...s, stack: next }));
      latest.current = { ...latest.current, stack: next };
      const search = writeStack(without(loc.search, drop), next.map((e) => e.record));
      const to = { pathname: loc.pathname, search, hash: loc.hash };
      const pushed = loc.state as Pushed | null;
      const pushedFrom = pushed?.sheetBack;
      if (how === "push") navigate(to, { state: { sheetBack: loc.search, dropped: drop } satisfies Pushed });
      // Closing what this entry opened is going back, so Back never reopens it (and a dialog the link left comes back).
      else if (how === "close" && pushedFrom !== undefined && without(pushedFrom, pushed?.dropped) === search) navigate(-1);
      else navigate(to, { replace: true, state: loc.state });
    },
    [navigate],
  );

  // Links from before the stack (?request=<id>) become ?sheet=request:<id>.
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.has("request") && !p.has("sheet"))
      navigate({ pathname: location.pathname, search: writeStack(location.search, urlRecords), hash: location.hash }, { replace: true, state: location.state });
  }, [location, urlRecords, navigate]);

  const [requestRows, setRequestRows] = useState<RequestRecord[]>([]);

  const value = useMemo<Stack>(
    () => ({
      stack,
      open: (record, from = -1, drop) => {
        const cur = latest.current.stack;
        const next = opened(cur, record, from);
        const dropping = !!drop?.some((k) => new URLSearchParams(latest.current.location.search).has(k));
        if (sameStack(next, cur) && !dropping) return;
        const added = next[next.length - 1];
        // New to the stack, in a sheet of its own or in the place of one of its kind.
        const isNew = !cur.some((e) => recordKey(e.record) === recordKey(added.record));
        if (isNew) openers.current.set(added.id, document.activeElement);
        // Leaving a dialog for a sheet is a step forward too: Back returns to the dialog.
        write(next, isNew || dropping ? "push" : "close", drop);
      },
      close: (index) => {
        const cur = latest.current.stack;
        const keep = index ?? cur.length - 1;
        // Nothing above `index` (a click that already closed them): no history step.
        if (cur.length === 0 || keep >= cur.length) return;
        write(cur.slice(0, keep), "close");
      },
      replace: (index, record) => {
        const cur = latest.current.stack;
        if (!cur[index]) return;
        const next = cur.map((e, i) => (i === index ? { id: e.id, record } : e));
        if (!sameStack(next, cur)) write(next, "replace");
      },
      hrefFor: (record, from = -1, drop) => {
        const loc = latest.current.location;
        return loc.pathname + writeStack(without(loc.search, drop), opened(latest.current.stack, record, from).map((e) => e.record));
      },
      opener: (id) => openers.current.get(id) ?? null,
      requestRows,
      setRequestRows,
    }),
    [stack, write, requestRows],
  );

  return <StackContext.Provider value={value}>{children}</StackContext.Provider>;
}

export function useSheets(): Stack {
  const ctx = useContext(StackContext);
  if (!ctx) throw new Error("useSheets outside SheetStackProvider");
  return ctx;
}

/** The stack, or null outside a SheetStackProvider (links then fall back to plain navigation). */
export function useMaybeSheets(): Stack | null {
  return useContext(StackContext);
}

/** The index of the sheet this is rendered in, -1 on the page. */
export function useSheetLevel(): number {
  return useContext(LevelContext);
}

export const SheetLevel = LevelContext.Provider;

/** The Requests feed lends its loaded rows to the Request sheet (seed and ↑/↓ stepping). */
export function useLendRequestRows(rows: RequestRecord[]) {
  const ctx = useContext(StackContext);
  const set = ctx?.setRequestRows;
  useEffect(() => {
    set?.(rows);
  }, [set, rows]);
  useEffect(() => () => set?.([]), [set]);
}
