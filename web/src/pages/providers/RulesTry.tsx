import { useState } from "react";
import { Textarea } from "@ui-sdk/react/textarea";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Code, langOf } from "@/ui/highlight";
import { Field, Input } from "@/ui/Input";
import type { Classification, Endpoint, FailureInput, Rule } from "./api";
import { calls, errorText } from "./api";
import { appearClass } from "@/ui/motion";
import { Select } from "./controls";

// Try a failure (UI ticket 34): the Owner types an answer from the Provider and
// the server says what the live Failure Rules decide for it
// (POST /api/providers/{p}/rules/classify, the Gateway's own reading and
// Set.Classify). The Flow view lights the path from the result.

type Example = { label: string; status: string; body: string; headers?: string };

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** One click fills the failure: the common answers a Provider gives. */
export const EXAMPLES: Example[] = [
  {
    label: "429 cooling",
    status: "429",
    headers: "Retry-After: 30",
    body: json({ error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } }),
  },
  {
    label: "401 invalid key",
    status: "401",
    body: json({ error: { message: "Incorrect API key provided.", type: "invalid_request_error", code: "invalid_api_key" } }),
  },
  {
    label: "404 model not found",
    status: "404",
    body: json({ error: { message: "The model `gpt-x` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }),
  },
  {
    label: "200 with an error",
    status: "200",
    body: json({ error: { message: "Provider returned error", code: 502 } }),
  },
];

/** An Endpoint URL's host, which host-limited rules match on. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** "Name: value" lines into headers; lines without a colon are left out. */
export function parseHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0 && line.slice(0, i).trim()) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** The result in words, as the Owner reads it above the flow. `n` is the matched rule's step number. */
export function sayResult(c: Classification, n?: number): string {
  if (!c.failure) return "Not a failure: Iroha relays this answer to the Caller; no rule is tried.";
  // The effects are the server's words (as the rules list shows them); only where a cooling time came from is added.
  const from = c.cooling_from === "response" ? " (the time the response names)" : c.cooling_from === "default" ? " (the default; repeats double it, up to 1 h)" : "";
  const who = !c.rule ? "No rule matches, so the fallback decides" : n ? `Rule ${n}, ${c.rule}, matches` : `Rule ${c.rule} matches`;
  return `${who}. Upstream Key: ${c.key_effect}${from}. Request: ${c.request_effect}.`;
}

/**
 * The "Try a failure" panel above the flow. It keeps what the Owner typed; `onResult` gets the
 * decision (or undefined once anything is edited, so a stale path never stays lit).
 */
export function TryFailure({
  handle,
  rules,
  endpoints,
  result,
  onResult,
}: {
  handle: string;
  rules: Rule[];
  endpoints?: Endpoint[];
  result?: Classification;
  onResult: (c: Classification | undefined) => void;
}) {
  const [f, setF] = useState({ status: "", body: "", headers: "", endpoint: "" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const edit = (patch: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...patch }));
    setError(undefined);
    onResult(undefined);
  };

  const run = async () => {
    const status = Number(f.status.trim());
    if (!f.status.trim() || !Number.isInteger(status) || status < 0 || status > 599) return setError("Type a status such as 429, or 0 for no response.");
    const body: FailureInput = { status };
    if (f.body.trim()) body.body = f.body;
    const headers = parseHeaders(f.headers);
    if (headers) body.headers = headers;
    if (f.endpoint) body.endpoint = f.endpoint;
    setPending(true);
    setError(undefined);
    try {
      onResult(await calls.classify(handle, body));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  const n = result?.rule ? rules.findIndex((r) => r.name === result.rule) + 1 || undefined : undefined;
  const choices = endpoints && endpoints.length > 1 ? endpoints.map((e) => ({ value: e.name, label: `${e.name} (${hostOf(e.url)})` })) : undefined;

  return (
    <section aria-label="Try a failure" className="mb-4 rounded-xl border border-border bg-bg p-4 shadow-sm md:p-5">
      <div className="mb-3 flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold">Try a failure</h3>
        <p className="text-[14px] text-fg-muted">Type what {handle} answered, or start from an example, to see which rule catches it. Nothing is sent or saved.</p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {EXAMPLES.map((x) => (
          <Button key={x.label} size="sm" onClick={() => edit({ status: x.status, body: x.body, headers: x.headers ?? "" })}>
            {x.label}
          </Button>
        ))}
      </div>
      <form
        className="grid gap-4 md:grid-cols-[160px_minmax(0,1fr)]"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="flex flex-col gap-4">
          <Field label="Status" hint="0: no response.">
            {(p) => <Input {...p} mono inputMode="numeric" placeholder="429" value={f.status} onChange={(e) => edit({ status: e.target.value })} />}
          </Field>
          {choices && (
            <Field label="Endpoint" hint="Rules for a host match on its host.">
              {() => <Select value={f.endpoint || choices[0].value} onValueChange={(v) => edit({ endpoint: v })} items={choices} />}
            </Field>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Field label="Body" hint="As the Provider sent it: JSON, text or a stream (data: lines).">
            {() => <CodeField value={f.body} onChange={(body) => edit({ body })} placeholder='{"error": {"message": "…"}}' />}
          </Field>
          <Field label="Headers" hint="Optional, one per line, such as Retry-After: 30.">
            {() => (
              <Textarea
                rows={2}
                spellCheck={false}
                value={f.headers}
                onValueChange={(headers: string) => edit({ headers })}
                placeholder="Retry-After: 30"
                className={cn(fieldFrame, codeText, "resize-y px-3 py-2")}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-3 md:col-span-2 md:flex-row md:items-start">
          <Button type="submit" loading={pending} className="self-start">
            Try this failure
          </Button>
          {error && <p role="alert" className={cn("text-[13px] text-danger-text md:pt-2", appearClass)}>{error}</p>}
          {result && (
            <div role="status" className={cn("min-w-0 flex-1 rounded-lg bg-info-tint px-3 py-2", appearClass)}>
              <p className="text-[15px] font-medium text-fg">{sayResult(result, n)}</p>
              {result.reason && (
                <p className="mt-0.5 text-[13px] text-fg-muted">
                  Read as <span className="font-mono [overflow-wrap:anywhere]">{result.reason}</span>
                  {result.endpoint ? ` on ${result.endpoint}` : ""}
                </p>
              )}
            </div>
          )}
        </div>
      </form>
    </section>
  );
}

const fieldFrame =
  "w-full rounded-lg border border-border-strong bg-bg text-fg outline-none transition-[border-color,box-shadow] focus:border-info focus:ring-2 focus:ring-info/20 placeholder:text-fg-subtle";
// 16 px on phones so focusing does not zoom; the code size from md up.
const codeText = "font-mono text-base leading-6 md:text-[13px] md:leading-5";

/**
 * A code field (ticket 23's highlighting): the text is drawn coloured in a `<pre>` under a
 * transparent textarea with the same box and type, so the caret and selection are the textarea's.
 * The pre sets the height (the textarea fills it), so neither scrolls on its own; the frame scrolls both.
 */
function CodeField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const text = cn(codeText, "m-0 whitespace-pre-wrap px-3 py-2 [overflow-wrap:anywhere] [tab-size:2]");
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border-strong bg-bg transition-[border-color,box-shadow] focus-within:border-info focus-within:ring-2 focus-within:ring-info/20">
      <div className="relative min-h-24">
        <pre aria-hidden className={cn(text, "pointer-events-none min-h-24 text-fg")}>
          <Code text={value} lang={langOf(value)} />
          {/* A trailing newline needs a line of its own to keep the heights equal. */}
          {"\n"}
        </pre>
        <Textarea
          spellCheck={false}
          value={value}
          onValueChange={(v: string) => onChange(v)}
          placeholder={placeholder}
          className={cn(
            text,
            "absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-fg outline-none placeholder:text-fg-subtle selection:bg-info/25",
          )}
        />
      </div>
    </div>
  );
}
