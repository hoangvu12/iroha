import { useEffect, useState } from "react";
import { logoPreview } from "@/api/logos";
import { PageBody } from "@/app/PageBody";
import { Button } from "@/ui/Button";
import { Mono } from "@/ui/bits";
import { CopyButton } from "@/ui/CopyButton";
import { ConfirmDialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import type { Provider, ProviderResult } from "./api";
import { calls, errorText, useRefresh } from "./api";
import { SettingsCard, SettingsRow, Switch } from "./controls";
import { LogoInput } from "./LogoField";

/** The Settings tab (C14): name, logo, on/off, the Provider route, and archiving. */
export function ProviderSettingsTab({ provider: p }: { provider: Provider }) {
  const refresh = useRefresh();
  const [name, setName] = useState(p.name);
  const [logo, setLogo] = useState(p.logo_domain_guessed ? "" : p.logo_domain);
  const [archiving, setArchiving] = useState(false);
  // Each setting shows its result where it was changed: beside its field or switch, a failure under the row.
  const naming = useSave({ refresh, describe: errorText });
  const logoSave = useSave({ refresh, describe: errorText });
  const enabling = useSave({ refresh, describe: errorText });
  const restoring = useSave({ refresh, describe: errorText });

  useEffect(() => {
    setName(p.name);
    setLogo(p.logo_domain_guessed ? "" : p.logo_domain);
  }, [p.name, p.logo_domain, p.logo_domain_guessed]);

  const update = (body: Parameters<typeof calls.updateProvider>[1]) => () => calls.updateProvider(p.handle, body);
  const restore = async () => {
    let res: ProviderResult | undefined;
    // Toast: the Restore row is replaced by Archive once it works, so its place is gone.
    if (await restoring.run(async () => (res = await update({ archived: false })()), { quiet: true }) && res)
      notifyChange(`${p.handle} restored`, res, { onUndone: refresh });
  };

  const logoChanged = logo.trim() !== (p.logo_domain_guessed ? "" : p.logo_domain);
  const base = `${window.location.origin}${p.caller_path}`;
  return (
    <PageBody width="readable">
      <SettingsCard title="General">
        <SettingsRow title="Name" hint="Shown in lists. Callers use the handle, which never changes.">
          <form
            className="flex w-full flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== p.name) void naming.run(update({ name: name.trim() }), { message: `Renamed to ${name.trim()}` });
            }}
          >
            {/* The field keeps its width; a long result wraps under it. */}
            <Input aria-label="Name" className="min-w-48 flex-1" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!naming.error} />
            {name.trim() !== p.name ? (
              <Button type="submit" variant="primary" loading={naming.pending}>
                Save
              </Button>
            ) : (
              <SaveStatus save={naming} className="shrink-0" />
            )}
          </form>
        </SettingsRow>
        <SaveError save={naming} className="px-6 pb-3" />
        <SettingsRow
          title="Logo"
          hint={
            p.logo_domain_guessed
              ? `Iroha looks up the logo for this domain; ${p.logo_domain ? `${p.logo_domain} is guessed from the first Endpoint` : "none could be guessed"}. "none" shows a letter.`
              : 'Iroha looks up the logo for this domain. Empty guesses it from the first Endpoint; "none" shows a letter.'
          }
        >
          <form
            className="flex w-full flex-wrap items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (logoChanged)
                void logoSave.run(update({ logo_domain: logo.trim() }), { message: logo.trim() ? `Logo domain set to ${logo.trim()}` : "Logo domain guessed again" });
            }}
          >
            <div className="min-w-48 flex-1">
              <LogoInput
                label="Logo domain"
                name={p.handle}
                value={logo}
                fallback={p.logo_domain}
                previewUrl={(domain) => (domain.toLowerCase() === "none" ? undefined : logoPreview({ domain }))}
                onChange={setLogo}
                placeholder={p.logo_domain_guessed ? p.logo_domain || "example.com" : "example.com"}
                invalid={!!logoSave.error}
              />
            </div>
            {logoChanged ? (
              <Button type="submit" variant="primary" loading={logoSave.pending}>
                Save
              </Button>
            ) : (
              <SaveStatus save={logoSave} className="mt-2 shrink-0" />
            )}
          </form>
        </SettingsRow>
        <SaveError save={logoSave} className="px-6 pb-3" />
        <SettingsRow title="Enabled" hint={`When off, Iroha sends nothing to ${p.handle} and Pools skip it.`}>
          <SaveStatus save={enabling} saving={false} />
          <Switch
            checked={p.enabled}
            label={`${p.handle} enabled`}
            pending={enabling.pending}
            onChange={(on) => void enabling.run(update({ enabled: on }), { message: on ? "Switched on" : "Switched off", undoable: false })}
            disabled={p.archived}
          />
        </SettingsRow>
        <SaveError save={enabling} className="px-6 pb-3" />
      </SettingsCard>

      <SettingsCard title="Provider route">
        <SettingsRow title="Base URL" hint={`Callers send bare model names here, without the ${p.handle}/ prefix.`}>
          <Mono className="min-w-0 truncate text-fg-muted">{p.caller_path}</Mono>
          <CopyButton value={base} what="Base URL" />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Danger zone" danger>
        {p.archived ? (
          <SettingsRow title="Restore Provider" hint={`${p.handle} is archived: it refuses Callers and Pools skip it. Restoring brings it back as it was.`}>
            <Button loading={restoring.pending} onClick={() => void restore()}>
              Restore
            </Button>
          </SettingsRow>
        ) : (
          <SettingsRow
            title="Archive Provider"
            hint={`${p.handle} stops serving with its ${p.upstream_key_count} Upstream Keys and ${p.endpoints.length} Endpoints, and Pools skip it. Its handle stays reserved; nothing is deleted.`}
          >
            <Button danger onClick={() => setArchiving(true)}>
              Archive
            </Button>
          </SettingsRow>
        )}
        <SaveError save={restoring} className="px-6 pb-3" />
      </SettingsCard>

      <ConfirmDialog
        open={archiving}
        onOpenChange={setArchiving}
        title={`Archive ${p.handle}?`}
        body={`Callers asking for ${p.handle} are refused and Pools skip it. Keys, Endpoints and models are kept; Undo or Restore brings it back.`}
        confirmLabel="Archive Provider"
        onConfirm={async () => {
          const res = await calls.updateProvider(p.handle, { archived: true });
          refresh();
          // Toast: the confirm dialog has closed (the page shows Restore now); Undo is offered there.
          notifyChange(`${p.handle} archived`, res, { onUndone: refresh });
        }}
      />
    </PageBody>
  );
}
