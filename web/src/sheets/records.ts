// The records a sheet can show, and how the open stack sits in the URL:
// one repeated `sheet` param per sheet, oldest first
// (/requests?range=24h&sheet=request:req_01&sheet=provider:acme&sheet=key:acme/team-5).

export type RequestTab = "details" | "attempts" | "captured";

export type SheetRecord =
  | { kind: "request"; id: string; tab?: RequestTab }
  | { kind: "provider"; handle: string }
  | { kind: "key"; provider: string; key: string }
  | { kind: "endpoint"; provider: string; endpoint: string }
  | { kind: "gateway-key"; key: string }
  | { kind: "pool"; name: string }
  // UI ticket 33: a model of a Provider's list (its ID may hold slashes), and a Failure Rule as it applies to a Provider.
  | { kind: "model"; provider: string; model: string }
  | { kind: "rule"; provider: string; rule: string };

export type SheetKind = SheetRecord["kind"];

/** Shorthands for links: `rec.key("acme", "team-5")`. */
export const rec = {
  request: (id: string): SheetRecord => ({ kind: "request", id }),
  provider: (handle: string): SheetRecord => ({ kind: "provider", handle }),
  key: (provider: string, key: string): SheetRecord => ({ kind: "key", provider, key }),
  endpoint: (provider: string, endpoint: string): SheetRecord => ({ kind: "endpoint", provider, endpoint }),
  gatewayKey: (key: string): SheetRecord => ({ kind: "gateway-key", key }),
  pool: (name: string): SheetRecord => ({ kind: "pool", name }),
  model: (provider: string, model: string): SheetRecord => ({ kind: "model", provider, model }),
  rule: (provider: string, rule: string): SheetRecord => ({ kind: "rule", provider, rule }),
};

/** "Upstream Key", for titles and names. */
export const kindLabel: Record<SheetKind, string> = {
  request: "Request",
  provider: "Provider",
  key: "Upstream Key",
  endpoint: "Endpoint",
  "gateway-key": "Gateway Key",
  pool: "Model Pool",
  model: "Model",
  rule: "Failure Rule",
};

/** The record's own name: "req_01", "acme", "team-5". */
export function recordName(r: SheetRecord): string {
  switch (r.kind) {
    case "request":
      return r.id;
    case "provider":
      return r.handle;
    case "key":
    case "gateway-key":
      return r.key;
    case "endpoint":
      return r.endpoint;
    case "pool":
      return r.name;
    case "model":
      return r.model;
    case "rule":
      return r.rule;
  }
}

const TABS: RequestTab[] = ["details", "attempts", "captured"];

/** The record's identity in the stack (a Request's tab is not part of it). */
export function recordKey(r: SheetRecord): string {
  switch (r.kind) {
    case "request":
      return `request:${r.id}`;
    case "provider":
      return `provider:${r.handle}`;
    case "key":
      return `key:${r.provider}/${r.key}`;
    case "endpoint":
      return `endpoint:${r.provider}/${r.endpoint}`;
    case "gateway-key":
      return `gateway-key:${r.key}`;
    case "pool":
      return `pool:${r.name}`;
    case "model":
      return `model:${r.provider}/${r.model}`;
    case "rule":
      return `rule:${r.provider}/${r.rule}`;
  }
}

function encode(r: SheetRecord): string {
  return r.kind === "request" && r.tab && r.tab !== "details" ? `${recordKey(r)}/${r.tab}` : recordKey(r);
}

function decode(s: string): SheetRecord | undefined {
  const colon = s.indexOf(":");
  if (colon < 0) return undefined;
  const kind = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  if (!rest) return undefined;
  const slash = rest.indexOf("/");
  const head = slash < 0 ? rest : rest.slice(0, slash);
  // Everything after the Provider: a key's or model's name keeps its own slashes.
  const tail = slash < 0 ? "" : rest.slice(slash + 1);
  switch (kind) {
    case "request": {
      const tab = TABS.find((t) => t === tail && t !== "details");
      return tab ? { kind, id: head, tab } : { kind, id: rest.includes("/") ? head : rest };
    }
    case "provider":
      return { kind, handle: rest };
    case "key":
      return head && tail ? { kind, provider: head, key: tail } : undefined;
    case "endpoint":
      return head && tail ? { kind, provider: head, endpoint: tail } : undefined;
    case "gateway-key":
      return { kind, key: rest };
    case "pool":
      return { kind, name: rest };
    case "model":
      return head && tail ? { kind, provider: head, model: tail } : undefined;
    case "rule":
      return head && tail ? { kind, provider: head, rule: tail } : undefined;
  }
  return undefined;
}

/** The stack a URL's search holds. `?request=<id>` (links from before the stack) opens that Request's sheet. */
export function readStack(search: string): SheetRecord[] {
  const p = new URLSearchParams(search);
  const listed = p.getAll("sheet");
  if (listed.length === 0) {
    const legacy = p.get("request");
    return legacy ? [{ kind: "request", id: legacy }] : [];
  }
  const out: SheetRecord[] = [];
  const seen = new Set<string>();
  for (const s of listed) {
    const r = decode(s);
    if (r && !seen.has(recordKey(r))) {
      seen.add(recordKey(r));
      out.push(r);
    }
  }
  return out;
}

/** `search` with its sheets replaced by `stack` (and the old `request` param dropped). */
export function writeStack(search: string, stack: SheetRecord[]): string {
  const p = new URLSearchParams(search);
  p.delete("sheet");
  p.delete("request");
  for (const r of stack) p.append("sheet", encode(r));
  const s = p.toString();
  return s ? `?${s}` : "";
}
