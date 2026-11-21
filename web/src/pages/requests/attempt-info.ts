import { type Outcome, OUTCOME_KEY } from "@/lib/outcomes";
import type { Tone } from "@/ui/bits";
import type { Attempt } from "./api";
import { clock } from "./bits";

export type { Outcome } from "@/lib/outcomes";

export type Explanation = {
  failed: boolean;
  rule?: string;
  outcome?: Outcome;
  reason?: string;
  action?: string;
  keyState?: { text: string; tone: Tone };
  body?: string;
  headers?: Record<string, string>;
};

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

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
  const endpointGap = outcome === "invalid" && /Endpoint Gap on/i.test(a.action ?? "");
  const tone = outcome && OUTCOME_KEY[outcome].tone;
  switch (outcome) {
    case "cooling_key":
      e.keyState = { text: until ? `Cooling until ${until}` : "Cooling", tone: tone! };
      break;
    case "cooling_key_model":
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

export function servedModel(a: Attempt): string | undefined {
  return a.reported_model && a.reported_model !== a.wire_model ? a.reported_model : undefined;
}

export function thenText(a: Attempt, next: Attempt | undefined): string {
  if (!attemptFailed(a)) return "Returned the answer to the Caller";
  if (!next) return "Returned the error to the Caller";
  if (next.provider !== a.provider) return `Tried ${next.provider}`;
  if (next.upstream_key === a.upstream_key) return "Tried another Endpoint";
  return "Tried the next key";
}

export function jumpLabel(a: Attempt, next: Attempt | undefined): { text: string; tone: Tone } | undefined {
  if (!next || !attemptFailed(a)) return undefined;
  const tried = thenText(a, next);
  const lower = tried.charAt(0).toLowerCase() + tried.slice(1);
  const o = explain(a).outcome;
  if (o === "invalid" && /Endpoint Gap on/i.test(a.action ?? "")) return { text: `Endpoint Gap, ${lower}`, tone: OUTCOME_KEY.model_gap.tone };
  if (o && o !== "retry_elsewhere" && o !== "fail_request") return { text: `${OUTCOME_KEY[o].short}, ${lower}`, tone: OUTCOME_KEY[o].tone };
  if (a.status === 0) return { text: `No response, ${lower}`, tone: "red" };
  return { text: `${a.status}, ${lower}`, tone: a.status === 429 ? "amber" : "red" };
}
