import type { Tone } from "@/ui/bits";
import type { Attempt, RequestRecord } from "./api";
import { clock } from "./bits";

// What Iroha made of each Attempt: the matched Failure Rule, what it meant
// (outcome), what Iroha did about it (Key State effect), and the upstream
// error. Ticket 05 adds these fields to Attempts in GET /api/requests/{id};
// this file is the ONLY place that reads them, so a rename is a one-line fix
// in FIELDS below. Everything degrades to the plain status when they are absent.

const FIELDS = {
  rule: "rule", // the Failure Rule the failure matched
  outcome: "outcome", // invalid | cooling_key | cooling_key_model | model_gap | retry_elsewhere | fail_request
  reason: "reason", // what the Provider answered, in one line
  action: "action", // what Iroha did: Key State change, next candidate
  failureBody: "failure_body", // upstream response body of a failed Attempt
  failureHeaders: "failure_headers", // upstream response headers of a failed Attempt
} as const;

/** On the Request (ticket 05): one line saying what happened at each Attempt. */
export const requestSummary = (r: RequestRecord): string | undefined => str((r as unknown as Record<string, unknown>).summary);

export type Outcome = "invalid" | "cooling_key" | "cooling_key_model" | "model_gap" | "retry_elsewhere" | "fail_request";

export type Explanation = {
  failed: boolean;
  rule?: string;
  outcome?: Outcome;
  reason?: string;
  action?: string;
  /** The Key State the Attempt left the Upstream Key in ("Cooling until 14:33:01"). */
  keyState?: { text: string; tone: Tone };
  body?: string;
  headers?: Record<string, string>;
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

/** "cooling until 2026-11-19T14:33:01Z" in an action -> "14:33:01" (local time). */
function untilIn(text?: string): string | undefined {
  const m = text?.match(ISO);
  return m ? clock(m[0]) : undefined;
}

export function attemptFailed(a: Attempt): boolean {
  return a.status === 0 || a.status >= 400;
}

export function explain(a: Attempt): Explanation {
  const outcome = str(a[FIELDS.outcome]) as Outcome | undefined;
  const action = str(a[FIELDS.action]);
  const headers = a[FIELDS.failureHeaders];
  const e: Explanation = {
    failed: attemptFailed(a),
    rule: str(a[FIELDS.rule]),
    outcome,
    reason: str(a[FIELDS.reason]),
    action,
    body: str(a[FIELDS.failureBody]) ?? a.error,
    headers: headers && typeof headers === "object" ? (headers as Record<string, string>) : undefined,
  };
  const until = untilIn(action);
  switch (outcome) {
    case "cooling_key":
      e.keyState = { text: until ? `Cooling until ${until}` : "Cooling", tone: "amber" };
      break;
    case "cooling_key_model":
      e.keyState = { text: until ? `Cooling for ${a.wire_model} until ${until}` : `Cooling for ${a.wire_model}`, tone: "amber" };
      break;
    case "invalid":
      e.keyState = { text: "Invalid", tone: "red" };
      break;
    case "model_gap":
      e.keyState = { text: `Model Gap for ${a.wire_model}`, tone: "blue" };
      break;
    case "retry_elsewhere":
    case "fail_request":
      e.keyState = { text: "Unchanged", tone: "gray" };
      break;
  }
  return e;
}

/** What Iroha did next after attempt `a`: "Tried the next key", "Tried openrouter", "Returned the error to the Caller". */
export function thenText(a: Attempt, next: Attempt | undefined): string {
  if (!attemptFailed(a)) return "Returned the answer to the Caller";
  if (!next) return "Returned the error to the Caller";
  if (next.provider !== a.provider) return `Tried ${next.provider}`;
  if (next.upstream_key === a.upstream_key) return "Tried another Endpoint";
  return "Tried the next key";
}

/**
 * The pill on the line from `a` to `next`, saying why Iroha moved on
 * ("Cooling, tried the next key"). Only drawn when it explains a jump.
 */
export function jumpLabel(a: Attempt, next: Attempt | undefined): { text: string; tone: Tone } | undefined {
  if (!next || !attemptFailed(a)) return undefined;
  const tried = thenText(a, next);
  const lower = tried.charAt(0).toLowerCase() + tried.slice(1);
  const e = explain(a);
  switch (e.outcome) {
    case "cooling_key":
    case "cooling_key_model":
      return { text: `Cooling, ${lower}`, tone: "amber" };
    case "model_gap":
      return { text: `Model Gap, ${lower}`, tone: "blue" };
    case "invalid":
      return { text: `Invalid key, ${lower}`, tone: "red" };
  }
  if (a.status === 0) return { text: `No response, ${lower}`, tone: "red" };
  return { text: `${a.status}, ${lower}`, tone: a.status === 429 ? "amber" : "red" };
}
