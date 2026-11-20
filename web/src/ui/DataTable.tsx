import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animateIn } from "@ui-sdk/core";
import { ArrowDown, ArrowUp, ChevronRight, MoreHorizontal } from "lucide-react";
import {
  type Cell,
  type ColumnDef,
  type ColumnFiltersState,
  type ExpandedState,
  type Header,
  type PaginationState,
  type Row,
  type RowData,
  type RowSelectionState,
  type SortingState,
  type Updater,
  type ColumnVisibilityState,
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_arrIncludesSome,
  filterFn_equals,
  filterFn_includesString,
  globalFilteringFeature,
  metaHelper,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "./Button";
import { Checkbox } from "./Checkbox";
import { useHoldView } from "./hold-view";
import { useLeaving } from "./presence";
import { useRowMotion } from "./row-motion";
import { cn } from "./cn";
import type { CopyState } from "./CopyButton";
import { Menu, MenuContent, MenuIconTrigger } from "./Menu";
import { Pager } from "./Pagination";
import { ScrollArea } from "./ScrollArea";
import { Select } from "./Select";
import { Skeleton } from "./Skeleton";
import { useRevealRows } from "./reveal-rows";
import { ErrorState, type FilterChip, NoResults } from "./States";

export type { ColumnFiltersState, PaginationState, RowSelectionState, SortingState, ColumnVisibilityState as VisibilityState, RowData } from "@tanstack/react-table";

// The one table of the app (spec "One data table"): a semantic <table> driven by
// TanStack Table v9, with UI SDK parts for its controls. How to use it, for
// every table: docs/agents/architecture.md, "UI ticket 06".

/** What a column may say about how it is drawn. */
export type DataColumnMeta = {
  /** Width class on the header cell: "w-[24%]", "w-10". */
  width?: string;
  /** Right-aligned, tabular figures (numbers). */
  align?: "right";
  /** Classes on each body cell. */
  className?: string;
  /** Name of a header that isn't plain text (for "Sort by …"). */
  label?: string;
  /**
   * This cell opens the row: its content is wrapped in a button named
   * "Open <row name>" that calls `onRowClick`, so the keyboard and agents can open
   * the row. Only for plain text cells (never around a link or button).
   */
  opens?: boolean;
};

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic, datetime: sortFn_datetime, text: sortFn_text },
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: { includesString: filterFn_includesString, equals: filterFn_equals, arrIncludesSome: filterFn_arrIncludesSome },
  columnVisibilityFeature,
  rowExpandingFeature,
  rowSelectionFeature,
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<DataColumnMeta>(),
});
export type DataTableFeatures = typeof dataTableFeatures;

/** The column helper for a DataTable of `T`: `const col = columnsFor<UpstreamKey>()`, then `col.columns([col.accessor(...), col.display(...)])` at module scope. */
export const columnsFor = <T extends RowData>() => createColumnHelper<DataTableFeatures, T>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataColumn<T extends RowData> = ColumnDef<DataTableFeatures, T, any>;
export type DataRow<T extends RowData> = Row<DataTableFeatures, T>;

// ---- Page size, remembered per table ----

export const PAGE_SIZES = [25, 50, 100];
const sizeKey = (id: string) => `iroha:table:${id}:page-size`;

function readPageSize(id: string, sizes: number[]): number {
  try {
    const v = Number(localStorage.getItem(sizeKey(id)));
    return sizes.includes(v) ? v : sizes[0];
  } catch {
    return sizes[0];
  }
}

function writePageSize(id: string, size: number) {
  try {
    localStorage.setItem(sizeKey(id), String(size));
  } catch {
    // Storage refused (private window, blocked site data): the choice lasts this visit only.
  }
}

/**
 * Pagination state with the page size remembered for this table. DataTable uses it
 * for client pages; a server-paged table calls it itself, puts the state in its
 * query key and passes it as `paging={{ mode: "server", pagination, onPaginationChange, rowCount }}`.
 */
export function useTablePaging(id: string, sizes: number[] = PAGE_SIZES) {
  const [pagination, setState] = useState<PaginationState>(() => ({ pageIndex: 0, pageSize: readPageSize(id, sizes) }));
  const setPagination = useCallback(
    (u: Updater<PaginationState>) =>
      setState((prev) => {
        const next = typeof u === "function" ? u(prev) : u;
        if (next.pageSize !== prev.pageSize) writePageSize(id, next.pageSize);
        return next.pageIndex === prev.pageIndex && next.pageSize === prev.pageSize ? prev : next;
      }),
    [id],
  );
  return [pagination, setPagination] as const;
}

export type DataTablePaging =
  /** Numbered pages over the loaded rows (the default). */
  | { mode: "pages"; sizes?: number[] }
  /** Numbered pages the server cuts: `data` is the current page, `rowCount` all rows the filters match. */
  | { mode: "server"; pagination: PaginationState; onPaginationChange: (u: Updater<PaginationState>) => void; rowCount: number; sizes?: number[] }
  /**
   * One growing list: `onLoadMore` runs when its end scrolls into view (or "Load more" is pressed).
   * `newRowsLabel` makes it live: rows arriving on top don't move the view while the reader is
   * scrolled down or pointing at a row, and a pill with this text ("3 new") goes back to the top.
   */
  | { mode: "infinite"; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; moreLabel?: string; newRowsLabel?: (count: number) => string }
  /** Every row at once (short, fixed lists). */
  | { mode: "none" };

export type BulkSelection<T> = {
  /** Row IDs selected, on every page. */
  ids: string[];
  /** The selected rows that are loaded (all of them, unless the server pages). */
  rows: T[];
  clear: () => void;
};

export type DataTableCounts = {
  /** Rows the search and filters match (server: `rowCount`). */
  shown: number;
  /** Rows loaded before filtering. */
  total: number;
  /** 1-based range on this page. */
  from: number;
  to: number;
};

export type DataTableProps<T extends RowData> = {
  /** Stable name: remembers the page size (`iroha:table:<id>:page-size`) and the skeleton's shape (`table:<id>`, `:phone`). */
  id: string;
  /** Names the table and its scroller ("Upstream Keys"); "Loading <label>" while loading. */
  label: string;
  /** Built with `columnsFor<T>()`, at module scope or memoised. */
  columns: DataColumn<T>[];
  /** The rows; `undefined` while loading (pass `query.data`). */
  data: T[] | undefined;
  /** A page's worth of typical rows the skeleton is measured from (module constant). */
  sample: T[];
  getRowId: (row: T) => string;
  /** The row's name in its controls: "Select team-1", "More for team-1", "Open team-1". */
  rowName: (row: T) => string;

  /** A failed load: shows `ErrorState` with Try again (only while there is no data to show). */
  error?: unknown;
  errorTitle?: string;
  onRetry?: () => void;
  /** Shown when there are no rows at all (EmptyState with its one action). */
  empty?: ReactNode;
  /** Filters in force, as chips over "No <label> match"; `onClearFilters` is its Clear filters. */
  filterChips?: FilterChip[];
  onClearFilters?: () => void;
  /** Title of the default NoResults: "No keys match". */
  noResultsTitle?: string;
  /** Replaces the default NoResults. */
  noResults?: ReactNode;

  /** Search box and filters, above the table; the bulk bar takes its place while rows are selected. */
  toolbar?: ReactNode;
  /** The search text (controlled; the page owns the box, often in the URL). */
  search?: string;
  /** Whether a row matches the search; default: any text column contains it. */
  searchFn?: (row: T, needle: string) => boolean;
  /** Column filters (controlled): `[{ id: "state", value: "cooling" }]`, matched by each column's `filterFn`. */
  columnFilters?: ColumnFiltersState;
  /** Search and filters are already applied by the server. */
  manualFiltering?: boolean;

  /** Sorting (controlled with `onSortingChange`, e.g. from the URL), or `defaultSorting` to start from. */
  sorting?: SortingState;
  onSortingChange?: (s: SortingState) => void;
  defaultSorting?: SortingState;
  /** The server sorts: rows come in order. */
  manualSorting?: boolean;
  /** Hidden columns by ID (`{ key: false }`). */
  columnVisibility?: ColumnVisibilityState;

  /** Row selection with a bulk-action bar: what the bar shows besides "N selected" and Clear selection. While anything is selected, a row click selects (UI ticket 25). */
  bulk?: (sel: BulkSelection<T>) => ReactNode;
  /** Selection, if the page must own it; otherwise the table does. */
  selection?: RowSelectionState;
  onSelectionChange?: (s: RowSelectionState) => void;

  /** The last cell of each row: usually `<RowMenu>`; may hold a Switch beside it. */
  rowActions?: (row: T) => ReactNode;
  /** Clicking a row (not one of its controls) opens it; in select mode (rows selected) it toggles the row instead. Mark the name column `meta: { opens: true }` for the keyboard, and the way in while selecting. */
  onRowClick?: (row: T) => void;
  rowTone?: (row: T) => "danger" | undefined;
  /** The row open beside the table (its sheet): highlighted, `aria-current`, and scrolled into view when it changes. */
  activeRowId?: string;
  /** Expandable rows: what shows under a row once its chevron is pressed. */
  renderExpanded?: (row: T) => ReactNode;

  /** Phones (< 768 px): the row as two lines (C31). Without it phones get the table, scrolling sideways. */
  phoneRow?: (row: T) => ReactNode;
  /** Phones: controls that stay on the row beside it (a row's Switch), even when the row opens on a tap. */
  phoneActions?: (row: T) => ReactNode;

  paging?: DataTablePaging;
  /** Line under the table, left of the pages: "42 keys". */
  footer?: (counts: DataTableCounts) => ReactNode;
  /** The rows are the previous query's while the next loads (`isPlaceholderData`): dimmed, no skeleton. */
  dimmed?: boolean;
};

const EMPTY_FILTERS: ColumnFiltersState = [];
const NO_PAGING: PaginationState = { pageIndex: 0, pageSize: Number.MAX_SAFE_INTEGER };

// Clicks on a row's own controls, or inside a popup rendered in place in it, don't open the row.
const OWN_TARGET = "button, a, input, textarea, select, label, [role=menuitem], [role=checkbox], [role=switch], [popover], dialog, [data-slot$='-content']";
// Space keeps its own meaning on these in select mode: boxes, switches, fields, menu triggers and popups.
const SPACE_OWN = "input, textarea, select, [contenteditable], [role=checkbox], [role=switch], [aria-haspopup]:not([aria-haspopup=false]), [role=menuitem], [popover], dialog, [data-slot$='-content']";

export function DataTable<T extends RowData>(props: DataTableProps<T>) {
  const {
    id,
    label,
    columns,
    data,
    sample,
    getRowId,
    rowName,
    paging = { mode: "pages" },
    bulk,
    rowActions,
    onRowClick,
    renderExpanded,
    phoneRow,
  } = props;
  const phone = useIsPhone() && !!phoneRow;
  const loading = data === undefined;
  const rows = data ?? sample;

  // Sorting: controlled or own.
  const [ownSorting, setOwnSorting] = useState<SortingState>(props.defaultSorting ?? []);
  const sorting = props.sorting ?? ownSorting;
  const onSortingChange = (u: Updater<SortingState>) => {
    const next = typeof u === "function" ? u(sorting) : u;
    if (props.onSortingChange) props.onSortingChange(next);
    else setOwnSorting(next);
  };

  // Selection: controlled or own.
  const [ownSelection, setOwnSelection] = useState<RowSelectionState>({});
  const rowSelection = props.selection ?? ownSelection;
  const setSelection = useCallback(
    (u: Updater<RowSelectionState>) => {
      if (props.onSelectionChange) props.onSelectionChange(typeof u === "function" ? u(props.selection ?? {}) : u);
      else setOwnSelection(u);
    },
    [props.onSelectionChange, props.selection], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [selecting, setSelecting] = useState(false); // phones: checkboxes shown

  const [expanded, setExpanded] = useState<ExpandedState>({});

  // Pages: client pages keep their own state (page size remembered), server pages the page's.
  const sizes = paging.mode === "pages" || paging.mode === "server" ? (paging.sizes ?? PAGE_SIZES) : PAGE_SIZES;
  const [ownPaging, setOwnPaging] = useTablePaging(id, sizes);
  const pagination = paging.mode === "server" ? paging.pagination : paging.mode === "pages" ? ownPaging : NO_PAGING;
  const setPagination = paging.mode === "server" ? paging.onPaginationChange : setOwnPaging;

  const search = props.search ?? "";
  const searchFn = props.searchFn;
  const globalFilterFn = useMemo(
    () => (searchFn ? (row: DataRow<T>, _column: string, value: string) => searchFn(row.original, String(value).trim().toLowerCase()) : ("includesString" as const)),
    [searchFn],
  );

  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: rows,
    getRowId: (r: T) => getRowId(r),
    state: {
      sorting,
      rowSelection,
      pagination,
      expanded,
      globalFilter: search,
      columnFilters: props.columnFilters ?? EMPTY_FILTERS,
      columnVisibility: props.columnVisibility ?? {},
    },
    onSortingChange,
    onRowSelectionChange: setSelection,
    onPaginationChange: setPagination,
    onExpandedChange: setExpanded,
    globalFilterFn,
    enableSortingRemoval: false,
    sortDescFirst: false,
    enableMultiSort: false,
    manualSorting: props.manualSorting,
    manualFiltering: props.manualFiltering,
    manualPagination: paging.mode !== "pages",
    rowCount: paging.mode === "server" ? paging.rowCount : undefined,
    autoResetPageIndex: false,
    autoResetExpanded: false,
    enableRowSelection: !!bulk,
    isRowRangeSelectionEvent: (e: unknown) => !!(e as { shiftKey?: boolean }).shiftKey,
    getRowCanExpand: () => !!renderExpanded,
  });

  // A new search, filter or sort starts again on page 1.
  const query = JSON.stringify([search, props.columnFilters ?? [], sorting]);
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    if (pagination.pageIndex !== 0) setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageCount = paging.mode === "pages" || paging.mode === "server" ? Math.max(1, table.getPageCount()) : 1;
  // A page left empty (rows deleted, filtered away) shows the last page instead.
  useEffect(() => {
    if (!loading && paging.mode !== "infinite" && pagination.pageIndex > pageCount - 1) setPagination((p) => ({ ...p, pageIndex: pageCount - 1 }));
  }, [loading, pageCount, pagination.pageIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Forget selected rows that are gone (deleted, renamed); a server-paged table can't know.
  useEffect(() => {
    if (!data || paging.mode === "server" || props.selection) return;
    const ids = new Set(data.map(getRowId));
    setOwnSelection((s) => {
      const kept = Object.keys(s).filter((k) => ids.has(k));
      return kept.length === Object.keys(s).length ? s : Object.fromEntries(kept.map((k) => [k, true]));
    });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);
  const selectedCount = selectedIds.length;
  const clear = () => {
    table.resetRowSelection(true);
    setSelecting(false);
  };

  const filteredRows = table.getFilteredRowModel().rows;
  const shown = paging.mode === "server" ? paging.rowCount : filteredRows.length;
  const pageRows = table.getRowModel().rows;
  // Many rows arriving over the skeleton: a screenful comes with the reveal, the rest right after (UI ticket 26).
  const shownRows = useRevealRows(pageRows, loading);
  // Rows the server filtered can be none because of the filters; loaded rows filtered here can't.
  const serverFiltered = !!props.manualFiltering || paging.mode === "server";
  const filtered = serverFiltered && (search.trim() !== "" || (props.columnFilters?.length ?? 0) > 0 || (props.filterChips?.length ?? 0) > 0);

  // ---- States in place of the table ----
  let state: ReactNode;
  if (props.error && !data) state = <ErrorState title={props.errorTitle ?? `Couldn't load ${label}`} error={props.error} onRetry={props.onRetry} />;
  else if (data && data.length === 0 && !filtered) state = props.empty ?? null;
  else if (data && (serverFiltered ? data.length === 0 : filteredRows.length === 0))
    state = props.noResults ?? (props.onClearFilters ? <NoResults title={props.noResultsTitle ?? "Nothing matches"} filters={props.filterChips} onClear={props.onClearFilters} /> : null);
  const showToolbar = loading || (data && data.length > 0) || filtered;

  // ---- Toolbar or bulk bar ----
  const selectedRows = bulk ? table.getSelectedRowModel().rows.map((r) => r.original) : [];
  const canSelectMore = bulk && paging.mode === "pages" && table.getIsAllPageRowsSelected() && filteredRows.some((r) => !r.getIsSelected());
  const barContent =
    bulk && selectedCount > 0 ? (
      <>
        <span className="mr-2 text-[15px] font-medium tabular">{selectedCount} selected</span>
        {bulk({ ids: selectedIds, rows: selectedRows, clear })}
        {canSelectMore && (
          <Button variant="ghost" size="sm" onClick={() => table.setRowSelection(Object.fromEntries(filteredRows.map((r) => [r.id, true])))}>
            Select all {filteredRows.length}
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="text-fg-muted" onClick={clear}>
          Clear selection
        </Button>
      </>
    ) : undefined;
  const toolbarContent =
    props.toolbar || (phone && bulk) ? (
      <>
        {props.toolbar}
        {phone && bulk && data && data.length > 0 && <Button onClick={() => setSelecting((s) => !s)}>{selecting ? "Done" : "Select"}</Button>}
      </>
    ) : undefined;

  // ---- The table ----
  const extraCols = (bulk ? 1 : 0) + (renderExpanded ? 1 : 0) + (rowActions ? 1 : 0);
  const colCount = table.getVisibleLeafColumns().length + extraCols;
  const allPage = table.getIsAllPageRowsSelected();
  const somePage = table.getIsSomePageRowsSelected() || (!allPage && pageRows.some((r) => r.getIsSelected()));

  const toggleRow = (row: DataRow<T>, on: boolean, event?: Event) =>
    row.getToggleSelectedHandler()({ target: { checked: on }, shiftKey: (event as MouseEvent | undefined)?.shiftKey ?? false });
  // Select mode (UI ticket 25): while any row is selected, a click on a row (not its own
  // controls) toggles it, Shift+click selects a range, and Space on the row's controls toggles it.
  // The name's Open button and the row menu still open the row.
  const selectMode = !!bulk && selectedCount > 0;
  const rowPress = (row: DataRow<T>, click: (() => void) | undefined) => (e: ReactMouseEvent<HTMLElement>) => {
    const own = (e.target as Element).closest(`${OWN_TARGET}, [data-select-cell]`);
    if (own && e.currentTarget.contains(own)) return;
    if (selectMode) toggleRow(row, !row.getIsSelected(), e.nativeEvent);
    else click?.();
  };
  // Shift+click in select mode picks a range, not the text in between.
  const noTextRange = (e: ReactMouseEvent) => {
    if (selectMode && e.shiftKey) e.preventDefault();
  };
  const spaceToggles = (row: DataRow<T>) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!selectMode || e.key !== " " || e.repeat) return;
    const own = (e.target as Element).closest(SPACE_OWN);
    if (own && e.currentTarget.contains(own)) return;
    e.preventDefault();
    toggleRow(row, !row.getIsSelected(), e.nativeEvent);
  };
  /** The checkbox's whole cell is its hit area: a press beside the box toggles the row (Shift: a range). */
  const selectCell = (toggle: (e: ReactMouseEvent) => void) => (e: ReactMouseEvent<HTMLElement>) => {
    const own = (e.target as Element).closest(OWN_TARGET);
    if (own && e.currentTarget.contains(own)) return;
    toggle(e);
  };
  // A click on a row opens it; a table of expandable rows that open nothing shows the row's details instead.
  const rowClick = (row: DataRow<T>): (() => void) | undefined =>
    onRowClick ? () => onRowClick(row.original) : renderExpanded ? () => row.toggleExpanded() : undefined;
  const expandButton = (row: DataRow<T>, name: string) => {
    const open = row.getIsExpanded();
    return (
      <IconButton
        icon={ChevronRight}
        size="sm"
        label={open ? `Hide details of ${name}` : `Show details of ${name}`}
        aria-expanded={open}
        className={cn("[&_svg]:transition-[rotate] [&_svg]:duration-collapse [&_svg]:ease-out", open && "[&_svg]:rotate-90")}
        onClick={() => row.toggleExpanded()}
      />
    );
  };

  // ---- Live rows (infinite with newRowsLabel) and the open row ----
  // The rows are found under this root when needed: refs inside the Skeleton don't hold.
  const rootRef = useRef<HTMLDivElement>(null);
  const newRowsLabel = paging.mode === "infinite" ? paging.newRowsLabel : undefined;
  const hold = useHoldView({ enabled: !!newRowsLabel && !loading && state === undefined, ids: pageRows.map((r) => r.id), root: rootRef });
  const pill = newRowsLabel ? <NewRowsPill count={hold.newAbove} label={newRowsLabel} onPress={hold.toTop} /> : null;
  // Stepping through rows from the sheet (↑/↓) keeps the open row in view.
  const active = props.activeRowId;
  useEffect(() => {
    if (!active || loading) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-rows] > [data-row-id="${CSS.escape(active)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, loading, phone, shownRows.length]);

  // Rows added or removed after an action enter and leave; only tables holding all their rows (server pages and the live feed don't).
  const rowMotion = useRowMotion({ data, getRowId, enabled: (paging.mode === "pages" || paging.mode === "none") && !props.dimmed, root: rootRef });
  const recordRow = (rowId: string, index: number, layout: "table" | "list", node: ReactElement) =>
    loading || layout !== (phone ? "list" : "table") ? node : rowMotion.record(rowId, index, node, layout);

  const desktop = (
    <TableScroller label={label}>
      <table aria-label={label} className={cn("w-full border-collapse text-left text-sm", props.dimmed && dimClass)}>
        <thead className="table-head relative z-[1] bg-bg shadow-[inset_0_-1px_0_var(--border)]">
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {bulk && (
                <th scope="col" data-select-cell="" className={cn(thClass, "w-9 cursor-pointer")} onClick={selectCell(() => table.toggleAllPageRowsSelected(!allPage))}>
                  <Checkbox
                    label={allPage ? "Unselect all rows on this page" : "Select all rows on this page"}
                    checked={allPage ? true : somePage ? "mixed" : false}
                    onChange={(on) => table.toggleAllPageRowsSelected(on)}
                  />
                </th>
              )}
              {renderExpanded && (
                <th scope="col" className={cn(thClass, "w-9")}>
                  <span className="sr-only">Details</span>
                </th>
              )}
              {group.headers.map((h) => (
                <HeaderCell key={h.id} header={h} render={<table.FlexRender header={h} />} />
              ))}
              {rowActions && (
                <th scope="col" className={cn(thClass, "w-10")}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          ))}
        </thead>
        <tbody data-rows="">
          {/* One flat list keyed by row ID, so a row arriving on top doesn't remount the rows under it; rows leaving are put back where they were. */}
          {rowMotion.withLeaving(shownRows.map((row, index) => {
            const r = row.original;
            const name = rowName(r);
            const selected = row.getIsSelected();
            const open = row.getIsExpanded();
            const click = rowClick(row);
            const current = active !== undefined && row.id === active;
            return [
              recordRow(row.id, index, "table", <tr
                key={row.id}
                data-row-id={row.id}
                aria-current={current ? "true" : undefined}
                data-active={current || undefined}
                data-selected={selected || undefined}
                data-tone={props.rowTone?.(r)}
                onClick={click || selectMode ? rowPress(row, click) : undefined}
                onMouseDown={noTextRange}
                onKeyDown={spaceToggles(row)}
                className={cn(
                  "group border-b border-border last:border-b-0",
                  rowClass,
                  (click || selectMode) && "cursor-pointer hover:bg-subtle",
                  "data-[tone=danger]:bg-danger-tint/50",
                  "data-selected:bg-selected data-selected:hover:bg-selected",
                  "scroll-mt-10 data-active:bg-selected data-active:hover:bg-selected",
                  open && "border-b-0",
                )}
              >
                {bulk && (
                  <td data-select-cell="" className={cn(tdClass, "w-9 cursor-pointer")} onClick={selectCell((e) => toggleRow(row, !selected, e.nativeEvent))}>
                    <Checkbox label={`Select ${name}`} checked={selected} onChange={(on, ev) => toggleRow(row, on, ev)} />
                  </td>
                )}
                {renderExpanded && <td className={cn(tdClass, "w-9")}>{expandButton(row, name)}</td>}
                {row.getVisibleCells().map((cell) => (
                  <BodyCell key={cell.id} cell={cell} name={name} onOpen={onRowClick && (() => onRowClick(r))} render={<table.FlexRender cell={cell} />} />
                ))}
                {rowActions && <td className={cn(tdClass, "w-10 text-right")}>{rowActions(r)}</td>}
              </tr>),
              open && renderExpanded ? (
                <tr key={`${row.id}:details`} data-selected={selected || undefined} className="border-b border-border last:border-b-0 data-selected:bg-selected">
                  {/* Fades in as it opens; the rows under it move down at once (rows never animate height). */}
                  <td colSpan={colCount} className="px-1.5 pb-4 transition-opacity duration-fade ease-out starting:opacity-0">
                    {renderExpanded(r)}
                  </td>
                </tr>
              ) : null,
            ];
          }), "table")}
        </tbody>
      </table>
    </TableScroller>
  );

  const showChecks = !!bulk && (selecting || selectedCount > 0);
  const list = phoneRow && (
    <>
      {/* Sticks to the top of the page while the list scrolls under it. */}
      {pill && <div className="pointer-events-none sticky top-3 z-[2] flex h-0 justify-center">{pill}</div>}
      <ul data-rows="" aria-label={label} className={cn("divide-y divide-border border-y border-border", props.dimmed && dimClass)}>
        {rowMotion.withLeaving(shownRows.map((row, index) => {
          const r = row.original;
          const name = rowName(r);
          const selected = row.getIsSelected();
          const content = phoneRow(r);
          const current = active !== undefined && row.id === active;
          return [
            recordRow(row.id, index, "list", <li
              key={row.id}
              data-row-id={row.id}
              aria-current={current ? "true" : undefined}
              data-active={current || undefined}
              data-selected={selected || undefined}
              data-tone={props.rowTone?.(r)}
              className={cn("flex flex-wrap items-center gap-3 py-3 data-active:bg-selected data-selected:bg-selected data-[tone=danger]:bg-danger-tint/50", rowClass)}
            >
              {showChecks && <Checkbox label={`Select ${name}`} checked={selected} onChange={(on, ev) => toggleRow(row, on, ev)} className="ml-1" />}
              {showChecks ? (
                // The checkbox is the control; a tap anywhere on the row toggles it too.
                <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-3" onClick={() => toggleRow(row, !selected)}>
                  {content}
                </div>
              ) : onRowClick ? (
                <SdkButton aria-label={`Open ${name}`} className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:bg-subtle" onClick={() => onRowClick(r)}>
                  {content}
                </SdkButton>
              ) : renderExpanded ? (
                // The chevron is the control; a tap on the row shows its details too.
                <div
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
                  onClick={(e) => {
                    const own = (e.target as Element).closest(OWN_TARGET);
                    if (!own || !e.currentTarget.contains(own)) row.toggleExpanded();
                  }}
                >
                  {content}
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>
              )}
              {!showChecks && props.phoneActions?.(r)}
              {!onRowClick && !showChecks && rowActions?.(r)}
              {renderExpanded && !onRowClick && !showChecks && expandButton(row, name)}
              {renderExpanded && row.getIsExpanded() && <div className="min-w-0 basis-full transition-opacity duration-fade ease-out starting:opacity-0">{renderExpanded(r)}</div>}
            </li>),
          ];
        }), "list")}
      </ul>
      {paging.mode === "infinite" && !loading && <LoadMore paging={paging} />}
    </>
  );

  const counts: DataTableCounts = {
    shown,
    total: data?.length ?? 0,
    from: shown === 0 ? 0 : paging.mode === "pages" || paging.mode === "server" ? pagination.pageIndex * pagination.pageSize + 1 : 1,
    to: paging.mode === "pages" || paging.mode === "server" ? Math.min(shown, (pagination.pageIndex + 1) * pagination.pageSize) : shown,
  };
  const pages = (paging.mode === "pages" || paging.mode === "server") && shown > Math.min(...sizes);

  return (
    <div ref={rootRef} data-table={id}>
      {(bulk || toolbarContent) && <BarSlot bar={showToolbar ? barContent : undefined} count={selectedCount} toolbar={showToolbar ? toolbarContent : undefined} />}
      {state !== undefined ? (
        state
      ) : (
        <Skeleton data={data} sample={sample} id={phone ? `table:${id}:phone` : `table:${id}`} label={`Loading ${label}`}>
          {() =>
            phone ? (
              list
            ) : (
              <>
                {/* The "N new" pill floats over the rows in view, under the header stuck to the top of the page. */}
                {pill && (
                  <div className="sticky top-0 z-[2] h-0">
                    <div className="pointer-events-none absolute inset-x-0 top-12 flex justify-center">{pill}</div>
                  </div>
                )}
                {desktop}
                {paging.mode === "infinite" && !loading && <LoadMore paging={paging} />}
              </>
            )
          }
        </Skeleton>
      )}
      {data && state === undefined && (props.footer || pages) && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 text-[13px] text-fg-muted">
          {/* Wraps onto its own line before it gets narrower than this. */}
          <div className="min-w-[min(100%,18rem)] flex-1">{props.footer?.(counts)}</div>
          {pages && (
            // Many pages on a phone: the pager wraps under the size box rather than pushing the page sideways.
            <div className="flex max-w-full flex-wrap items-center gap-3">
              {/* The Select is w-full; its box sets the width (cn has no tailwind-merge). */}
              <div className="w-[150px] md:w-[128px]">
                <Select
                  aria-label="Rows per page"
                  className="h-8"
                  value={String(pagination.pageSize)}
                  onValueChange={(v) => setPagination({ pageIndex: 0, pageSize: Number(v) })}
                  items={sizes.map((s) => ({ value: String(s), label: `${s} per page` }))}
                />
              </div>
              <Pager label={`Pages of ${label}`} page={pagination.pageIndex + 1} pageCount={pageCount} onPageChange={(p) => setPagination((s) => ({ ...s, pageIndex: p - 1 }))} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A row entering after an action rises by shift-sm and fades in; one leaving fades only (architecture.md "UI motion system").
const rowClass =
  "transition-[opacity,translate] duration-list-in ease-out data-starting-style:translate-y-(--motion-shift-sm) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-list-out";
// The previous query's rows dim only once the next is slow, so a fast answer never flickers; they come back at once.
const dimClass = "opacity-60 transition-opacity duration-fade ease-out delay-(--duration-fade)";
const thClass = "h-10 px-1.5 text-[13px] font-normal text-fg-muted";
const tdClass = "h-12 px-1.5 align-middle";

/**
 * The table's scroller (UI ticket 25). The page scrolls the rows: the table is as
 * tall as its rows (numbered pages keep it bounded) and this only scrolls sideways,
 * for tables wider than the page. A sideways scroller would make a sticky header
 * stick to it rather than to the page, so the header (`.table-head`) follows the
 * page with a scroll-driven animation instead (`styles/index.css`, "Table header"):
 * from where the table's top passes the window's top, it moves down with the
 * scroll, at most `--table-stick-end` (the table's height less the header's, kept
 * here). Its own component, so its ref holds inside the Skeleton.
 */
function TableScroller({ label, children }: { label: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = viewport.current;
    const table = el?.querySelector("table");
    if (!el || !table) return;
    const measure = () => el.style.setProperty("--table-stick-end", `${Math.max(0, table.offsetHeight - (table.tHead?.offsetHeight ?? 0))}px`);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(table);
    return () => ro.disconnect();
  }, []);
  return (
    <ScrollArea axis="x" label={label} className="w-full" viewportRef={viewport} viewportClassName="table-scroller" contentClassName="min-w-full">
      {children}
    </ScrollArea>
  );
}

/**
 * The toolbar, or the bulk bar in its place while rows are selected. The bar
 * rises in; when the selection clears it fades out where it was (showing what
 * it said, inert) while the toolbar fades back in under it, in the same cell:
 * one crossfade (architecture.md "UI ticket 16"). Its own component, so the
 * exit ending re-renders only this, not the table.
 */
function BarSlot({ bar, count, toolbar }: { bar: ReactNode | undefined; count: number; toolbar: ReactNode | undefined }) {
  const exit = useLeaving<ReactNode, HTMLDivElement>(bar);
  const shownCount = useRef(count);
  if (count > 0) shownCount.current = count;
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (exit.leaving && toolbarRef.current) return animateIn(toolbarRef.current);
  }, [exit.leaving]);
  const showToolbar = bar === undefined && toolbar !== undefined;
  if (exit.shown === undefined && !showToolbar) return null;
  return (
    <div className="mb-4 grid">
      {showToolbar && (
        <div
          ref={toolbarRef}
          className="col-start-1 row-start-1 flex flex-wrap items-center gap-2 self-start transition-opacity duration-fade ease-out data-starting-style:opacity-0"
        >
          {toolbar}
        </div>
      )}
      {exit.shown !== undefined && (
        <div
          ref={exit.ref}
          data-bulk-bar=""
          aria-label={`${shownCount.current} selected`}
          aria-hidden={exit.leaving || undefined}
          role="group"
          className={cn(
            // Both sit at the top of the shared cell: a taller (wrapped) bar leaving doesn't move the toolbar under it.
            "col-start-1 row-start-1 flex min-h-9 flex-wrap items-center gap-2 self-start",
            "transition-[opacity,translate] duration-list-in ease-out starting:translate-y-(--motion-shift) starting:opacity-0",
            "data-ending-style:opacity-0 data-ending-style:duration-list-out",
          )}
        >
          {exit.shown}
        </div>
      )}
    </div>
  );
}

function HeaderCell<T extends RowData>({ header, render }: { header: Header<DataTableFeatures, T, unknown>; render: ReactNode }) {
  const col = header.column;
  const meta = col.columnDef.meta;
  const sorted = col.getIsSorted();
  const text = meta?.label ?? (typeof col.columnDef.header === "string" ? col.columnDef.header : col.id);
  return (
    <th
      scope="col"
      colSpan={header.colSpan}
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : col.getCanSort() ? "none" : undefined}
      className={cn(thClass, meta?.width, meta?.align === "right" && "text-right")}
    >
      {header.isPlaceholder ? null : col.getCanSort() ? (
        <SdkButton
          aria-label={`Sort by ${text}`}
          onClick={col.getToggleSortingHandler()}
          data-active={sorted ? "" : undefined}
          className="inline-flex select-none items-center gap-1 rounded outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-info/30 data-active:text-fg"
        >
          {render}
          {sorted === "asc" && <ArrowDown size={13} aria-hidden />}
          {sorted === "desc" && <ArrowUp size={13} aria-hidden />}
        </SdkButton>
      ) : (
        render
      )}
    </th>
  );
}

function BodyCell<T extends RowData>({ cell, name, onOpen, render }: { cell: Cell<DataTableFeatures, T, unknown>; name: string; onOpen?: () => void; render: ReactNode }) {
  const meta = cell.column.columnDef.meta;
  return (
    <td className={cn(tdClass, meta?.align === "right" && "text-right tabular", meta?.className)}>
      {meta?.opens && onOpen ? (
        <SdkButton aria-label={`Open ${name}`} onClick={onOpen} className="block max-w-full truncate rounded text-left outline-none focus-visible:underline">
          {render}
        </SdkButton>
      ) : (
        render
      )}
    </td>
  );
}

/**
 * "3 new" (live tables, UI ticket 18): rises into place like the bulk bar and fades out where it is.
 * Kept mounted and switched by `data-shown`, so it can leave with what it said; while hidden it is
 * inert and hidden from readers. The translate snaps back only once the fade is done.
 */
function NewRowsPill({ count, label, onPress }: { count: number; label: (n: number) => string; onPress: () => void }) {
  const last = useRef(count);
  if (count > 0) last.current = count;
  const shown = count > 0;
  return (
    <div
      data-new-rows=""
      data-shown={shown ? "" : undefined}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
      className={cn(
        "transition-[opacity,translate] duration-list-in ease-out",
        "not-data-shown:translate-y-(--motion-shift) not-data-shown:opacity-0",
        "not-data-shown:[transition-duration:var(--duration-list-out),0ms] not-data-shown:[transition-delay:0ms,var(--duration-list-out)]",
      )}
    >
      <Button size="sm" className="pointer-events-auto rounded-full bg-elevated shadow-md" onClick={onPress}>
        <ArrowUp size={14} aria-hidden />
        {label(last.current)}
      </Button>
    </div>
  );
}

function LoadMore({ paging }: { paging: Extract<DataTablePaging, { mode: "infinite" }> }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(paging);
  latest.current = paging;
  // Observed again after each load: an observer reports only changes, and a load
  // that leaves the end in view (short pages, a tall screen) changes nothing.
  useEffect(() => {
    const el = ref.current;
    if (!el || paging.loadingMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => {
        const p = latest.current;
        if (e.isIntersecting && p.hasMore && !p.loadingMore) p.onLoadMore();
      },
      // The page scrolls the rows (UI ticket 25): watched against the window.
      { root: null, rootMargin: "240px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [paging.loadingMore, paging.hasMore]);
  if (!paging.hasMore) return null;
  return (
    <div ref={ref} className="flex justify-center py-4">
      <Button variant="ghost" size="sm" loading={paging.loadingMore} onClick={paging.onLoadMore}>
        {paging.loadingMore ? "Loading…" : (paging.moreLabel ?? "Load more")}
      </Button>
    </div>
  );
}

/** A row's ⋯ menu, named "More for <name>"; `copy` shows a copy made from one of its items (useCopy). */
export function RowMenu({ name, children, copy }: { name: string; children: ReactNode; copy?: CopyState }) {
  return (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label={`More for ${name}`} size="sm" copy={copy} />
      <MenuContent>{children}</MenuContent>
    </Menu>
  );
}
