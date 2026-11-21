import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

export type ParamPatch = Record<string, string | null | undefined>;

export function patchParams(params: URLSearchParams, patch: ParamPatch): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  return next;
}

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
