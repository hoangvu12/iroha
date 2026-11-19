import { useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import { revertEntry } from "@/api/audit";
import { isApiError } from "@/api/client";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { riseIn } from "@/ui/Reveal";
import { Dialog } from "@/ui/Dialog";
import { Disclosure } from "@/ui/Disclosure";
import { Field, Input } from "@/ui/Input";
import { SaveError, useSave } from "@/ui/SaveStatus";
import { notify } from "@/ui/toast";
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
  const [made, setMade] = useState<{ key: GatewayKey; entry?: string }>();
  const undo = useSave({ refresh: invalidate });

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setName("");
      setDraft(emptyDraft());
      setError(undefined);
      setScopeError(undefined);
      setMade(undefined);
      undo.clear();
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
        // The dialog stays open on the new key, which says it was created; Undo is in its footer.
        onSuccess: (res) => setMade({ key: res.gateway_key, entry: res.audit_entry }),
        onError: (e) => setError(isApiError(e) ? `${e.message} ${e.hint}`.trim() : String(e)),
      },
    );
  };

  if (made) {
    const urls = baseUrls();
    const { key, entry } = made;
    // Undo deletes the key again and closes the dialog; with the dialog gone, a toast says so.
    const undoCreate = async () => {
      if (entry && (await undo.run(() => revertEntry(entry)))) {
        close(false);
        notify.success(`Gateway Key ${key.name} deleted`);
      }
    };
    return (
      <Dialog
        open={open}
        onOpenChange={close}
        width={560}
        closeButton={false}
        // Shown once, in place of the form: title, text and key rise into place on one frame and the badge grows in with them (UI ticket 20).
        title={
          <span className={cn("flex flex-col items-start gap-4", riseIn)}>
            <span
              data-badge=""
              className="inline-flex size-11 items-center justify-center rounded-full bg-success-tint text-success transition-[opacity,scale] duration-dialog-in ease-out starting:scale-(--motion-scale-popup) starting:opacity-0"
            >
              <Check size={20} aria-hidden />
            </span>
            Gateway Key created
          </span>
        }
        description={<span className={cn("block", riseIn)}>Copy it now and give it to the Caller. You can copy it again later from the key's page.</span>}
        footer={
          <>
            {entry && (
              <Button variant="ghost" icon={RotateCcw} className="mr-auto" aria-label={`Undo: delete ${key.name}`} loading={undo.pending} onClick={() => void undoCreate()}>
                Undo
              </Button>
            )}
            <Button variant="primary" onClick={() => close(false)}>
              Done
            </Button>
          </>
        }
      >
        <div className={cn("flex flex-col gap-4", riseIn)}>
          <div>
            <p className="mb-2 text-sm font-medium text-fg">Key for {key.name}</p>
            <CopyBox value={key.secret} what="Gateway Key" />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-fg">Base URL</p>
            <CopyBox value={urls.openai} what="Base URL" />
            <p className="mt-2 text-[13px] text-fg-muted">For OpenAI clients. Models are named provider/model, or a Model Pool's name.</p>
          </div>
          <Disclosure summary="Anthropic and Gemini clients" className="text-[13px] text-fg-muted">
            <div className="flex flex-col gap-3 pt-3">
              <div>
                <p className="mb-1.5 text-fg">Anthropic</p>
                <CopyBox value={urls.anthropic} what="Anthropic base URL" />
              </div>
              <div>
                <p className="mb-1.5 text-fg">Gemini</p>
                <CopyBox value={urls.gemini} what="Gemini base URL" />
              </div>
            </div>
          </Disclosure>
          <SaveError save={undo} />
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
      <div className="flex flex-col gap-6">
        <form
          id="new-gateway-key"
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
        </form>
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
      </div>
    </Dialog>
  );
}
