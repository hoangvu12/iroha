import { type Outcome, OUTCOME_KEY } from "@/lib/outcomes";
import type { Tone } from "@/ui/bits";
import type { Attempt } from "./api";
import { clock } from "./bits";

// What Iroha made of each failed Attempt, from the fields GET
// /api/requests/{id} gives it (internal/requests.Attempt): the matched
// Failure Rule, what the failure meant (outcome), what Iroha did about it
// (action: the Key State effect), and the upstream error body and headers.
// The drawer, the Attempts tab and the Route view all read them through here.

export type { Outcome } from "@/lib/outcomes";

export type Explanation = {
  failed: boolean;
  rule?: string;
  outcome?: Outcome;
  /** What the Provider answered, in one line. */
  reason?: string;
  /** What Iroha did about it, as recorded ("Upstream Key team-3 cooling until ..."). */
  action?: string;
  /** The Key State the Attempt left the Upstream Key in ("Cooling until 14:33:01"). */
  keyState?: { text: string; tone: Tone };
  body?: string;
  headers?: Record<string, string>;
};

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

/** "... cooling until 2026-11-19T14:33:01Z." -> "14:33:01" (local time). */
function untilIn(text?: string): string | undefined {
  const m = text?.match(ISO);
  return m ? clock(m[0]) : undefined;
}

export function attemptFailed(a: Attempt): boolean {
  return a.status === 0 || a.status >= 400;
}

export function explain(a: Attempt): Explanation {
  const outcome = (a.outcome || undefined) as Outcome | undefined;
  const e: Explanation = {
    failed: attemptFailed(a),
    rule: a.rule || undefined,
    outcome,
    reason: a.reason || undefined,
    action: a.action || undefined,
    body: a.failure_body || a.error || undefined,
    headers: a.failure_headers && Object.keys(a.failure_headers).length > 0 ? a.failure_headers : undefined,
  };
  const until = untilIn(a.action);
  const stays = /stays invalid/i.test(a.action ?? "");
  // An invalid verdict on one Endpoint of a key that works on another is an
  // Endpoint Gap there (ticket 40): the action names it, the key stays as it was.
  const endpointGap = outcome === "invalid" && /Endpoint Gap on/i.test(a.action ?? "");
  const tone = outcome && OUTCOME_KEY[outcome].tone;
  switch (outcome) {
    case "cooling_key":
      e.keyState = { text: until ? `Cooling until ${until}` : "Cooling", tone: tone! };
      break;
    case "cooling_key_model":
      // Three models refused within minutes escalate to the whole key (the action says so).
      e.keyState = /whole key/i.test(a.action ?? "")
        ? { text: `Cooling until ${untilIn(a.action?.slice(a.action.search(/whole key/i))) ?? until ?? "later"}`, tone: tone! }
        : { text: until ? `Cooling for ${a.wire_model} until ${until}` : `Cooling for ${a.wire_model}`, tone: tone! };
      break;
    case "invalid":
      e.keyState = endpointGap ? { text: `Endpoint Gap on ${a.endpoint}`, tone: OUTCOME_KEY.model_gap.tone } : { text: stays ? "Still invalid" : "Invalid", tone: tone! };
      break;
    case "model_gap":
      e.keyState = { text: `Model Gap for ${a.wire_model}`, tone: tone! };
      break;
    case "retry_elsewhere":
    case "fail_request":
      e.keyState = { text: OUTCOME_KEY[outcome].short, tone: tone! };
      break;
  }
  if (stays && e.keyState) e.keyState = { text: "Still invalid", tone: OUTCOME_KEY.invalid.tone };
  return e;
}

/**
 * The model the Provider said served attempt `a` (a dated snapshot, a router's
 * pick), when it differs from the model sent; the Caller saw its own name.
 */
export function servedModel(a: Attempt): string | undefined {
  return a.reported_model && a.reported_model !== a.wire_model ? a.reported_model : undefined;
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
  const o = explain(a).outcome;
  if (o === "invalid" && /Endpoint Gap on/i.test(a.action ?? "")) return { text: `Endpoint Gap, ${lower}`, tone: OUTCOME_KEY.model_gap.tone };
  // The outcomes that changed the key name themselves (one map: lib/outcomes.ts).
  if (o && o !== "retry_elsewhere" && o !== "fail_request") return { text: `${OUTCOME_KEY[o].short}, ${lower}`, tone: OUTCOME_KEY[o].tone };
  if (a.status === 0) return { text: `No response, ${lower}`, tone: "red" };
  return { text: `${a.status}, ${lower}`, tone: a.status === 429 ? "amber" : "red" };
}
