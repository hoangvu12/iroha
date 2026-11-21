import type { Tone } from "@/ui/bits";

export type Outcome = "invalid" | "cooling_key" | "cooling_key_model" | "model_gap" | "retry_elsewhere" | "fail_request";

export const OUTCOME_KEY: Record<Outcome, { tone: Tone; short: string }> = {
  invalid: { tone: "red", short: "Invalid key" },
  cooling_key: { tone: "amber", short: "Cooling" },
  cooling_key_model: { tone: "amber", short: "Cooling" },
  model_gap: { tone: "blue", short: "Model Gap" },
  retry_elsewhere: { tone: "gray", short: "Unchanged" },
  fail_request: { tone: "gray", short: "Unchanged" },
};
