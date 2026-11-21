import type { OwnerSession } from "@/api/session";
import type { AuditEntry } from "@/api/types";
import type { AdminToken } from "./api";

const at = "2026-11-19T09:41:07.000Z";

export const SAMPLE_ADMIN_TOKENS: AdminToken[] = ["deploy-script", "zeron-agent", "backup-cron"].map((name, i) => ({
  id: `at_sample_${i}`,
  name,
  note: "",
  secret: "iroha_admin_sample000000000000000000",
  revoked: false,
  created_at: at,
  last_used_at: at,
}));

export const SAMPLE_AUDIT_ENTRIES: AuditEntry[] = Array.from({ length: 20 }, (_, i) => ({
  id: `ae_sample_${i}`,
  time: at,
  actor: { kind: "owner_session", id: "os_sample", name: "Owner" },
  action: "update",
  summary: "Upstream Key dashscope/key-07 disabled",
  revertible: true,
  changes: [{ resource: "upstream_key", id: `key_sample_${i}`, name: "dashscope/key-07", op: "update", fields: ["enabled"], before: {}, after: {} }],
}));

export const SAMPLE_SESSIONS: OwnerSession[] = [
  {
    id: "os_sample_0",
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36",
    created_at: at,
    expires_at: at,
    last_seen_at: at,
    active: true,
    current: true,
  },
  {
    id: "os_sample_1",
    user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile Safari/604.1",
    created_at: at,
    expires_at: at,
    last_seen_at: at,
    active: true,
    current: false,
  },
];
