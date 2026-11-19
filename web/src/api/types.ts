// Types shared by every resource of the admin API. They mirror the Go types
// (and the schemas in GET /api/openapi.json); resource-specific types live
// next to the page that uses them, or in src/api/<resource>.ts.

export type Actor = {
  kind: "admin_token" | "owner_session";
  id: string;
  name: string; // Admin Token name, or "Owner"
};

/** One record a change touched (audit.Change). */
export type Change = {
  resource: string;
  id: string;
  name: string;
  op: "create" | "update" | "delete";
  fields?: string[];
  before: unknown;
  after: unknown;
};

/** The audit part of every mutation response (audit.Result). */
export type AuditResult = {
  dry_run: boolean;
  outcome: "created" | "updated" | "deleted" | "unchanged";
  audit_entry?: string;
  changes: Change[];
};

export type ApiErrorShape = { code: string; message: string; hint?: string; details?: unknown };

export type BulkItem<T> = {
  index: number;
  ok: boolean;
  outcome?: AuditResult["outcome"];
  result?: T;
  error?: ApiErrorShape;
  changes: Change[];
};

export type BulkResult<T> = {
  dry_run: boolean;
  audit_entry?: string;
  succeeded: number;
  failed: number;
  items: BulkItem<T>[];
};

export type AuditEntry = {
  id: string;
  time: string;
  actor: Actor;
  action: string;
  summary: string;
  revertible: boolean;
  not_revertible?: string;
  revert_of?: string;
  reverted_by?: string;
  changes: Change[];
};

export type AuditEntryPage = { entries: AuditEntry[]; next_before?: string };

export type RevertResult = AuditResult & { reverted: string };

export type Health = { status: "ok" | "ready"; version: string; ui: boolean };
