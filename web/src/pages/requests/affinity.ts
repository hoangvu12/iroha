import type { Affinity } from "./api";

const SOURCES: Record<Affinity["source"], string> = {
  header: "Iroha-Session header",
  claude_code: "Claude Code session",
  codex: "Codex session",
  session_id: "session ID",
  opencode: "OpenCode session",
  prompt_cache_key: "prompt_cache_key",
  prefix: "prompt's start",
  none: "no conversation",
};

/** Why the Request's Upstream Key was chosen, in one line, or nothing for Requests recorded before conversation affinity. */
export function affinityReason(a: Affinity | undefined): string | undefined {
  if (!a) return undefined;
  const from = SOURCES[a.source] ?? a.source;
  switch (a.mode) {
    case "on":
      return a.preferred_served === false
        ? `This conversation's key couldn't serve; its next key was tried (${from})`
        : `Key chosen for this conversation (${from})`;
    case "control":
      return `Keys in turn: this conversation is in the experiment's round-robin half (${from})`;
    case "off":
      return `Keys in turn: conversation affinity is off for this Provider (${from})`;
    case "none":
      return "Keys in turn: no conversation found";
  }
  return undefined;
}
