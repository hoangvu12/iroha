import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { affinityReason } from "./affinity";
import type { RequestRecord } from "./api";
import { RequestDetails } from "./Details";
import { SAMPLE_REQUEST } from "./samples";

test("the reason names where the conversation came from and whether its key served", () => {
  expect(affinityReason({ source: "claude_code", mode: "on", preferred_served: true })).toBe("Key chosen for this conversation (Claude Code session)");
  expect(affinityReason({ source: "header", mode: "on", preferred_served: false })).toBe(
    "This conversation's key couldn't serve; its next key was tried (Iroha-Session header)",
  );
  expect(affinityReason({ source: "prefix", mode: "control" })).toBe("Keys in turn: this conversation is in the experiment's round-robin half (prompt's start)");
  expect(affinityReason({ source: "codex", mode: "off" })).toBe("Keys in turn: conversation affinity is off for this Provider (session-id header: Codex, pi)");
  expect(affinityReason({ source: "none", mode: "none" })).toBe("Keys in turn: no conversation found");
  expect(affinityReason(undefined)).toBeUndefined();
});

const details = (r: RequestRecord) =>
  render(
    <MemoryRouter>
      <RequestDetails r={r} />
    </MemoryRouter>,
  );

test("Request Details says why the key was chosen, and nothing for Requests from before", () => {
  const { unmount } = details({ ...SAMPLE_REQUEST, affinity: { source: "opencode", mode: "on", preferred_served: true } });
  expect(screen.getByText("Key choice")).toBeTruthy();
  expect(screen.getByText("Key chosen for this conversation (x-session-affinity header: OpenCode, pi)")).toBeTruthy();
  unmount();
  details({ ...SAMPLE_REQUEST, affinity: undefined });
  expect(screen.queryByText("Key choice")).toBeNull();
});
