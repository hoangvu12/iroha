import type { Tone } from "@/ui/bits";

/** What a Failure Rule decides for a failed Attempt (Go `rules.Outcome`). */
export type Outcome = "invalid" | "cooling_key" | "cooling_key_model" | "model_gap" | "retry_elsewhere" | "fail_request";

/**
 * What each outcome does to the Upstream Key, as the Key State colour it leaves and a short
 * name for a pill ("Cooling, tried the next key"). The one map the Rules flow, Try a failure
 * and the Requests page read. Whole effects are worded by the server (`key_effect`,
 * `request_effect`): show those, never re-word an outcome here.
 */
export const OUTCOME_KEY: Record<Outcome, { tone: Tone; short: string }> = {
  invalid: { tone: "red", short: "Invalid key" },
  cooling_key: { tone: "amber", short: "Cooling" },
  cooling_key_model: { tone: "amber", short: "Cooling" },
  model_gap: { tone: "blue", short: "Model Gap" },
  retry_elsewhere: { tone: "gray", short: "Unchanged" },
  fail_request: { tone: "gray", short: "Unchanged" },
};
