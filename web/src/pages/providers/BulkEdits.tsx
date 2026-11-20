import { applySet, BulkEdit, type BulkChanges, type BulkField, bulkDone, type SetChange } from "@/ui/BulkEdit";
import type { Save } from "@/ui/SaveStatus";
import type { Facts, Member, Model, Provider, UpstreamKey } from "./api";
import { calls, natural, useRefresh } from "./api";

// What each Provider table edits together (UI ticket 30; the reasons are in
// the ticket's Comments). Names and secrets are never bulk-edited.

/** Upstream Keys: Enabled, and the Endpoints each may use (when the Provider has several). */
export function KeysBulkEdit({ handle, provider, rows, at, size }: { handle: string; provider?: Provider; rows: UpstreamKey[]; at: Save; size?: "sm" | "md" }) {
  const refresh = useRefresh();
  const eps = (provider?.endpoints ?? []).map((e) => e.name);
  // No restriction means every Endpoint, so it shows as each one ticked.
  const allowed = (k: UpstreamKey) => (k.endpoints.length ? k.endpoints : eps);
  const fields: BulkField<UpstreamKey>[] = [
    { kind: "boolean", id: "enabled", label: "Enabled", on: "enabled", get: (k) => k.enabled, hint: "A disabled key gets no traffic until it is enabled again." },
  ];
  if (eps.length > 1)
    fields.push({
      kind: "set",
      id: "endpoints",
      label: "Endpoints",
      hint: "A key is only sent to the Endpoints ticked. A key left with all of them (or none) may use every Endpoint.",
      get: allowed,
      options: (provider?.endpoints ?? []).map((e) => ({ value: e.name, label: e.name, detail: e.url })),
    });

  const apply = async (c: BulkChanges) => {
    const ordered = [...rows].sort((a, b) => natural(a.name, b.name));
    const items = ordered.map((k) => {
      const item: { key: string; enabled?: boolean; endpoints?: string[] } = { key: k.id };
      if (typeof c.enabled === "boolean") item.enabled = c.enabled;
      if (c.endpoints) {
        const next = applySet(allowed(k), c.endpoints as SetChange, eps);
        item.endpoints = next.length === eps.length ? [] : next;
      }
      return item;
    });
    const res = await calls.editKeys(handle, items);
    await refresh();
    return bulkDone(res, ordered.map((k) => k.name), ["key", "keys"]);
  };
  return <BulkEdit rows={rows} noun={["key", "keys"]} fields={fields} at={at} onApply={apply} size={size} />;
}

const tri = (b?: boolean) => (b === undefined ? "" : b ? "yes" : "no");
const tokens = (n?: number) => (n ? String(n) : "");
const num = (s: string) => (s.trim() ? Number(s.replace(/[_,\s]/g, "")) : undefined);

/** Models: Hidden from Callers, Pinned to the list, and the Owner's metadata overrides. */
export function ModelsBulkEdit({ handle, rows, at, size }: { handle: string; rows: Model[]; at: Save; size?: "sm" | "md" }) {
  const refresh = useRefresh();
  const fields: BulkField<Model>[] = [
    { kind: "boolean", id: "hidden", label: "Hidden from Callers", on: "hidden", get: (m) => m.hidden, hint: "Callers don't see a hidden model, and asking for it is refused." },
    {
      kind: "boolean",
      id: "added",
      label: "Pinned to the list",
      on: "pinned",
      get: (m) => m.added,
      hint: "Listed whatever discovery finds. Unpinning a model discovery doesn't find takes it off the list (Undo brings it back).",
    },
    {
      kind: "select",
      id: "chat",
      label: "Chat",
      get: (m) => m.overrides.chat ?? "",
      options: [
        { value: "", label: "Not set" },
        { value: "ok", label: "Chats" },
        { value: "unsupported", label: "Doesn't chat" },
      ],
    },
    {
      kind: "select",
      id: "reasoning",
      label: "Reasons before answering",
      get: (m) => tri(m.overrides.reasoning),
      options: [
        { value: "", label: "Not set" },
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    },
    { kind: "text", id: "context_length", label: "Context window", inputMode: "numeric", placeholder: "tokens", get: (m) => tokens(m.overrides.context_length), hint: "Empty uses the Provider's list, then models.dev." },
    { kind: "text", id: "max_output_tokens", label: "Max output", inputMode: "numeric", placeholder: "tokens", get: (m) => tokens(m.overrides.max_output_tokens) },
  ];

  const apply = async (c: BulkChanges) => {
    const counts: Partial<Record<"context_length" | "max_output_tokens", number | undefined>> = {};
    for (const k of ["context_length", "max_output_tokens"] as const) {
      if (typeof c[k] !== "string") continue;
      const v = num(c[k] as string);
      if (v !== undefined && !(Number.isInteger(v) && v > 0)) throw new Error("Token counts are whole numbers above 0.");
      counts[k] = v;
    }
    const meta = "chat" in c || "reasoning" in c || Object.keys(counts).length > 0;
    const items = rows.map((m) => {
      const item: { model: string; hidden?: boolean; added?: boolean; metadata?: Facts } = { model: m.model };
      if (typeof c.hidden === "boolean") item.hidden = c.hidden;
      if (typeof c.added === "boolean") item.added = c.added;
      if (meta) {
        // Overrides are replaced as a whole: start from this model's own.
        const f: Facts = { ...m.overrides };
        if (typeof c.chat === "string") {
          if (c.chat) f.chat = c.chat as Facts["chat"];
          else delete f.chat;
        }
        if (typeof c.reasoning === "string") {
          if (c.reasoning) f.reasoning = c.reasoning === "yes";
          else delete f.reasoning;
        }
        for (const [k, v] of Object.entries(counts) as ["context_length" | "max_output_tokens", number | undefined][]) {
          if (v) f[k] = v;
          else delete f[k];
        }
        item.metadata = f;
      }
      return item;
    });
    const res = await calls.saveModels(handle, items);
    await refresh();
    return bulkDone(res, rows.map((m) => m.model), ["model", "models"]);
  };
  return <BulkEdit rows={rows} noun={["model", "models"]} fields={fields} at={at} onApply={apply} size={size} />;
}

/** A Pool's members: On. The whole list is saved in one change, so it all applies or none does. */
export function MembersBulkEdit({
  pool,
  members,
  rows,
  at,
  size,
}: {
  pool: string;
  members: Member[];
  rows: Member[];
  at: Save;
  size?: "sm" | "md";
}) {
  const refresh = useRefresh();
  const key = (m: Pick<Member, "provider" | "model">) => `${m.provider}/${m.model}`;
  const fields: BulkField<Member>[] = [{ kind: "boolean", id: "enabled", label: "On", get: (m) => m.enabled, hint: "Iroha skips a member that is off and tries the next one." }];
  const apply = async (c: BulkChanges) => {
    const picked = new Set(rows.map(key));
    const on = c.enabled as boolean;
    const next = members.map(({ provider, model, enabled }) => ({ provider, model, enabled: picked.has(`${provider}/${model}`) ? on : enabled }));
    const res = await calls.updatePool(pool, { members: next });
    await refresh();
    const n = rows.filter((m) => m.enabled !== on).length;
    if (n === 0) return { message: `Nothing changed: ${rows.length === 1 ? "it was" : "they were"} already ${on ? "on" : "off"}` };
    return { message: `${n} member${n === 1 ? "" : "s"} switched ${on ? "on" : "off"}`, entry: res.audit_entry };
  };
  return <BulkEdit rows={rows} noun={["member", "members"]} fields={fields} at={at} onApply={apply} size={size} />;
}
