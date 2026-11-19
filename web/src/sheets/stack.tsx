import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { RequestRecord } from "@/pages/requests/api";
import { readStack, recordKey, type SheetRecord, writeStack } from "./records";

// The open sheets (spec "Stacked sheets"): a flat list in the URL, oldest
// first. React state leads and the URL follows in the same event (UI SDK's
// controlled-value rule); Back, Forward and links lead the other way.

export type SheetEntry = { id: number; record: SheetRecord };

/** History state on an entry pushed by opening a sheet: the search it was opened from. */
type Pushed = { sheetBack?: string };

type Stack = {
  stack: SheetEntry[];
  /** Open a record from `from` (a sheet's index, -1 for the page): closes the sheets above `from`, or focuses the record if it is open already. */
  open: (record: SheetRecord, from?: number) => void;
  /** Close the sheet at `index` and every sheet above it (default: the top one). */
  close: (index?: number) => void;
  /** Show another record (or tab) in the sheet at `index`, without a history entry. */
  replace: (index: number, record: SheetRecord) => void;
  /** The URL that shows the stack after `open(record, from)`, for links' href. */
  hrefFor: (record: SheetRecord, from?: number) => string;
  /** The element focused when the sheet with this id was opened, for focus on close. */
  opener: (id: number) => Element | null;
  requestRows: RequestRecord[];
  setRequestRows: (rows: RequestRecord[]) => void;
};

const StackContext = createContext<Stack | null>(null);
const LevelContext = createContext(-1);

let nextId = 1;

function toEntries(records: SheetRecord[], prev: SheetEntry[]): SheetEntry[] {
  return records.map((record) => {
    const same = prev.find((e) => recordKey(e.record) === recordKey(record));
    return { id: same?.id ?? nextId++, record };
  });
}

const sameStack = (a: SheetEntry[], b: SheetEntry[]) =>
  a.length === b.length && a.every((e, i) => e.id === b[i].id && JSON.stringify(e.record) === JSON.stringify(b[i].record));

/** The stack after opening `record` from `from`. */
function opened(stack: SheetEntry[], record: SheetRecord, from: number): SheetEntry[] {
  const at = stack.findIndex((e) => recordKey(e.record) === recordKey(record));
  if (at >= 0) return stack.slice(0, at + 1);
  return [...stack.slice(0, Math.max(0, from + 1)), { id: nextId++, record }];
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
    (next: SheetEntry[], how: "push" | "close" | "replace") => {
      const { location: loc } = latest.current;
      setState((s) => ({ ...s, stack: next }));
      latest.current = { ...latest.current, stack: next };
      const search = writeStack(loc.search, next.map((e) => e.record));
      const to = { pathname: loc.pathname, search, hash: loc.hash };
      const pushedFrom = (loc.state as Pushed | null)?.sheetBack;
      if (how === "push") navigate(to, { state: { sheetBack: loc.search } satisfies Pushed });
      // Closing what this entry opened is going back, so Back never reopens it.
      else if (how === "close" && pushedFrom !== undefined && pushedFrom === search) navigate(-1);
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
      open: (record, from = -1) => {
        const cur = latest.current.stack;
        const next = opened(cur, record, from);
        if (sameStack(next, cur)) return;
        const added = next[next.length - 1];
        const isNew = !cur.some((e) => e.id === added.id);
        if (isNew) openers.current.set(added.id, document.activeElement);
        write(next, isNew ? "push" : "close");
      },
      close: (index) => {
        const cur = latest.current.stack;
        if (cur.length === 0) return;
        write(cur.slice(0, index ?? cur.length - 1), "close");
      },
      replace: (index, record) => {
        const cur = latest.current.stack;
        if (!cur[index]) return;
        const next = cur.map((e, i) => (i === index ? { id: e.id, record } : e));
        if (!sameStack(next, cur)) write(next, "replace");
      },
      hrefFor: (record, from = -1) => {
        const loc = latest.current.location;
        return loc.pathname + writeStack(loc.search, opened(latest.current.stack, record, from).map((e) => e.record));
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
