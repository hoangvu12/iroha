// The UI's only way to talk to Iroha: the public admin API (GET
// /api/openapi.json, GET /skill.md), authenticated by the Owner session
// cookie. No private endpoints exist for the UI.

export type ErrorBody = {
  error: { code: string; message: string; hint?: string; details?: unknown };
};

/** A failed call. `call` is the short mono line the error state shows. */
export class ApiError extends Error {
  readonly status: number; // 0 when Iroha never answered
  readonly code: string;
  readonly hint: string;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;

  constructor(o: { status: number; code: string; message: string; hint?: string; details?: unknown; method: string; path: string }) {
    super(o.message);
    this.name = "ApiError";
    this.status = o.status;
    this.code = o.code;
    this.hint = o.hint ?? "";
    this.details = o.details;
    this.method = o.method;
    this.path = o.path;
  }

  /** "GET /api/requests timed out", "POST /api/providers answered 409 name_taken". */
  get call(): string {
    const where = `${this.method} ${this.path.split("?")[0]}`;
    if (this.code === "timeout") return `${where} timed out`;
    if (this.status === 0) return `${where} got no answer`;
    return `${where} answered ${this.status} ${this.code}`;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Codes that mean "this browser is not signed in any more". */
const signedOutCodes = new Set(["admin_token_missing", "owner_session_invalid", "owner_session_expired", "owner_session_revoked"]);

type Listener = (e: ApiError) => void;
const signedOutListeners = new Set<Listener>();

/** Called whenever a call finds the session gone; the auth gate shows the login. */
export function onSignedOut(fn: Listener): () => void {
  signedOutListeners.add(fn);
  return () => signedOutListeners.delete(fn);
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
};

function withQuery(path: string, query?: RequestOptions["query"]): string {
  if (!query) return path;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}${path.includes("?") ? "&" : "?"}${s}` : path;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const url = withQuery(path, opts.query);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new ApiError(
      timedOut
        ? { status: 0, code: "timeout", message: `Iroha didn't answer within ${Math.round(timeoutMs / 1000)} s. It may be restarting.`, method, path: url }
        : { status: 0, code: "network", message: "Couldn't reach Iroha. Check the connection.", method, path: url },
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const env = (data as ErrorBody | undefined)?.error;
    const e = new ApiError({
      status: res.status,
      code: env?.code ?? `http_${res.status}`,
      message: env?.message ?? `Iroha answered ${res.status}.`,
      hint: env?.hint,
      details: env?.details,
      method,
      path: url,
    });
    if (res.status === 401 && signedOutCodes.has(e.code)) signedOutListeners.forEach((fn) => fn(e));
    throw e;
  }
  return data as T;
}

/** Thin verbs over request(). Paths are admin API paths, e.g. "/api/admin-tokens". */
export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, body ?? {}, opts),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};

/** Encode one path segment (a name or ID). */
export const seg = (s: string) => encodeURIComponent(s);
