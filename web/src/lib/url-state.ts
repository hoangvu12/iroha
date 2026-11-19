import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

/** A change to the URL's params: a value sets it, `undefined`, `null` or `""` removes it. */
export type ParamPatch = Record<string, string | null | undefined>;

/** `params` with `patch` applied; every param it doesn't name (other filters, `sheet`) stays. */
export function patchParams(params: URLSearchParams, patch: ParamPatch): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  return next;
}

/**
 * Page state kept in the URL's params (search, filters, sort, an open record),
 * so a reload or a shared link shows the same view. Every change replaces the
 * history entry: typing in a search box or sorting doesn't fill Back.
 * - `setParam(k, v)`: one param (empty removes it).
 * - `setParams({ q: undefined, state: undefined })`: several at once (Clear filters).
 * - `setSort(sort, desc, defaultSort)`: `?sort=&dir=desc` for DataTable's `onSortingChange`; the default sort ascending leaves no param.
 */
export function useUrlParams() {
  const [params, setSearchParams] = useSearchParams();
  const setParams = useCallback((patch: ParamPatch) => setSearchParams((p) => patchParams(p, patch), { replace: true }), [setSearchParams]);
  const setParam = useCallback((k: string, v?: string | null) => setParams({ [k]: v }), [setParams]);
  const setSort = useCallback(
    (sort: string, desc: boolean, defaultSort: string) => setParams({ sort: sort === defaultSort ? undefined : sort, dir: desc ? "desc" : undefined }),
    [setParams],
  );
  return useMemo(() => ({ params, setParam, setParams, setSort }), [params, setParam, setParams, setSort]);
}
