import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { RequestRecord } from "@/pages/requests/api";
import { readStack, recordKey, type SheetRecord, writeStack } from "./records";

export type SheetEntry = { id: number; record: SheetRecord; opened?: number };

type Pushed = { sheetBack?: string; dropped?: string[] };

export type EditingWishes = { has: (key: string) => boolean; drop: (key: string) => void };

function createEditingWishes() {
  const keys = new Set<string>();
  return { add: (key: string) => void keys.add(key), has: (key: string) => keys.has(key), drop: (key: string) => void keys.delete(key) };
}

type Stack = {
  stack: SheetEntry[];
  open: (record: SheetRecord, from?: number, drop?: string[]) => void;
  openEditing: (record: SheetRecord) => void;
  editingWishes: EditingWishes;
  close: (index?: number) => void;
  replace: (index: number, record: SheetRecord) => void;
  hrefFor: (record: SheetRecord, from?: number, drop?: string[]) => string;
  opener: (id: number) => Element | null;
  requestRows: RequestRecord[];
  setRequestRows: (rows: RequestRecord[]) => void;
};

const StackContext = createContext<Stack | null>(null);
const LevelContext = createContext(-1);

let nextId = 1;

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
      else if (how === "close" && pushedFrom !== undefined && without(pushedFrom, pushed?.dropped) === search) navigate(-1);
      else navigate(to, { replace: true, state: loc.state });
    },
    [navigate],
  );

  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.has("request") && !p.has("sheet"))
      navigate({ pathname: location.pathname, search: writeStack(location.search, urlRecords), hash: location.hash }, { replace: true, state: location.state });
  }, [location, urlRecords, navigate]);

  const [requestRows, setRequestRows] = useState<RequestRecord[]>([]);
  const [editingWishes] = useState(createEditingWishes);

  const value = useMemo<Stack>(() => {
    const open: Stack["open"] = (record, from = -1, drop) => {
      const cur = latest.current.stack;
      const next = opened(cur, record, from);
      const dropping = !!drop?.some((k) => new URLSearchParams(latest.current.location.search).has(k));
      if (sameStack(next, cur) && !dropping) return;
      const added = next[next.length - 1];
      const isNew = !cur.some((e) => recordKey(e.record) === recordKey(added.record));
      if (isNew) openers.current.set(added.id, document.activeElement);
      write(next, isNew || dropping ? "push" : "close", drop);
    };
    return {
      stack,
      open,
      openEditing: (record) => {
        editingWishes.add(recordKey(record));
        open(record);
      },
      editingWishes,
      close: (index) => {
        const cur = latest.current.stack;
        const keep = index ?? cur.length - 1;
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
    };
  }, [stack, write, requestRows, editingWishes]);

  return <StackContext.Provider value={value}>{children}</StackContext.Provider>;
}

export function useSheets(): Stack {
  const ctx = useContext(StackContext);
  if (!ctx) throw new Error("useSheets outside SheetStackProvider");
  return ctx;
}

export function useMaybeSheets(): Stack | null {
  return useContext(StackContext);
}

export function useSheetLevel(): number {
  return useContext(LevelContext);
}

export const SheetLevel = LevelContext.Provider;

export function useLendRequestRows(rows: RequestRecord[]) {
  const ctx = useContext(StackContext);
  const set = ctx?.setRequestRows;
  useEffect(() => {
    set?.(rows);
  }, [set, rows]);
  useEffect(() => () => set?.([]), [set]);
}
