import { useState } from "react";
import { Check } from "lucide-react";
import { isApiError } from "@/api/client";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { notifyChange } from "@/ui/toast";
import { type GatewayKey, useCreateKey, useInvalidateKeys } from "./api";
import { baseUrls, CopyBox } from "./bits";
import { emptyDraft, toScope } from "./scope";
import { ScopeEditor } from "./ScopeEditor";

/** New Gateway Key (C02, C24), then the key and base URLs with Copy (C12). */
export function CreateDialog({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (o: boolean) => void; existing: GatewayKey[] }) {
  const create = useCreateKey();
  const invalidate = useInvalidateKeys();
  const [name, setName] = useState("");
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState<string>();
  const [scopeError, setScopeError] = useState<string>();
  const [made, setMade] = useState<GatewayKey>();

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setName("");
      setDraft(emptyDraft());
      setError(undefined);
      setScopeError(undefined);
      setMade(undefined);
      create.reset();
    }
  };

  const submit = () => {
    const n = name.trim();
    if (!n) return setError("Give the key a name, usually the Caller who will hold it. Requests show this name.");
    const taken = existing.find((k) => k.name === n);
    if (taken)
      return setError(
        taken.revoked ? `${n} was revoked and its name stays on record. Pick another name.` : `A Gateway Key is already named ${n}. Pick another name.`,
      );
    setError(undefined);
    if (!draft.all && draft.providers.size === 0 && draft.pools.size === 0)
      return setScopeError("Tick at least one Provider or Model Pool, or choose Everything.");
    setScopeError(undefined);
    create.mutate(
      { name: n, scope: toScope(draft) },
      {
        onSuccess: (res) => {
          setMade(res.gateway_key);
          notifyChange(`Gateway Key ${res.gateway_key.name} created`, res, {
            undoneMessage: `${res.gateway_key.name} deleted`,
            onUndone: invalidate,
          });
        },
        onError: (e) => setError(isApiError(e) ? `${e.message} ${e.hint}`.trim() : String(e)),
      },
    );
  };

  if (made) {
    const urls = baseUrls();
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        width={560}
        closeButton={false}
        title={
          <span className="flex flex-col items-start gap-4">
            <span className="inline-flex size-11 items-center justify-center rounded-full bg-success-tint text-success">
              <Check size={20} />
            </span>
            Gateway Key created
          </span>
        }
        description="Copy it now and give it to the Caller. You can copy it again later from the key's page."
        footer={
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="mb-2 text-sm font-medium text-fg">Key for {made.name}</p>
            <CopyBox value={made.secret} what="Gateway Key" />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-fg">Base URL</p>
            <CopyBox value={urls.openai} what="Base URL" />
            <p className="mt-2 text-[13px] text-fg-muted">For OpenAI clients. Models are named provider/model, or a Model Pool's name.</p>
          </div>
          <details className="group text-[13px] text-fg-muted">
            <summary className="cursor-pointer select-none hover:text-fg">Anthropic and Gemini clients</summary>
            <div className="mt-3 flex flex-col gap-3">
              <div>
                <p className="mb-1.5 text-fg">Anthropic</p>
                <CopyBox value={urls.anthropic} what="Anthropic base URL" />
              </div>
              <div>
                <p className="mb-1.5 text-fg">Gemini</p>
                <CopyBox value={urls.gemini} what="Gemini base URL" />
              </div>
            </div>
          </details>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      width={560}
      title="New Gateway Key"
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-gateway-key" loading={create.isPending}>
            Create key
          </Button>
        </>
      }
    >
      <form
        id="new-gateway-key"
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" error={error}>
          {(p) => (
            <Input {...p} autoFocus autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} placeholder="linh" />
          )}
        </Field>
        <div>
          <ScopeEditor
            draft={draft}
            onChange={(d) => {
              setDraft(d);
              setScopeError(undefined);
            }}
          />
          {scopeError && (
            <p role="alert" className="mt-2 text-[13px] text-danger-text">
              {scopeError}
            </p>
          )}
        </div>
      </form>
    </Dialog>
  );
}
