import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { logoPreview } from "@/api/logos";
import { PageBody } from "@/app/PageBody";
import { copyText } from "@/pages/settings/format";
import { Button } from "@/ui/Button";
import { Mono } from "@/ui/bits";
import { ConfirmDialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { LogoTile } from "@/ui/LogoTile";
import { notify, notifyChange } from "@/ui/toast";
import type { Provider } from "./api";
import { calls, errorText, useRefresh } from "./api";
import { SettingsCard, SettingsRow, Switch } from "./controls";

/** Debounced value, for previews that fetch. */
export function useDebounced<T>(v: T, ms = 400): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** The Settings tab (C14): name, logo, on/off, the Provider route, and archiving. */
export function ProviderSettingsTab({ provider: p }: { provider: Provider }) {
  const refresh = useRefresh();
  const [name, setName] = useState(p.name);
  const [logo, setLogo] = useState(p.logo_domain_guessed ? "" : p.logo_domain);
  const [errors, setErrors] = useState<{ name?: string; logo?: string }>({});
  const [archiving, setArchiving] = useState(false);
  const domain = useDebounced(logo.trim() || p.logo_domain);

  useEffect(() => {
    setName(p.name);
    setLogo(p.logo_domain_guessed ? "" : p.logo_domain);
  }, [p.name, p.logo_domain, p.logo_domain_guessed]);

  const save = async (body: Parameters<typeof calls.updateProvider>[1], what: string, field?: "name" | "logo") => {
    setErrors({});
    try {
      const res = await calls.updateProvider(p.handle, body);
      refresh();
      notifyChange(what, res, { onUndone: refresh });
    } catch (e) {
      if (field) setErrors({ [field]: errorText(e) });
      else notify.failure(`Couldn't change ${p.handle}`, e);
    }
  };

  const logoChanged = logo.trim() !== (p.logo_domain_guessed ? "" : p.logo_domain);
  const base = `${window.location.origin}${p.caller_path}`;
  return (
    <PageBody width="readable">
      <SettingsCard title="General">
        <SettingsRow title="Name" hint="Shown in lists. Callers use the handle, which never changes.">
          <form
            className="flex w-full gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== p.name) void save({ name: name.trim() }, `Renamed to ${name.trim()}`, "name");
            }}
          >
            <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
            {name.trim() !== p.name && (
              <Button type="submit" variant="primary">
                Save
              </Button>
            )}
          </form>
        </SettingsRow>
        {errors.name && <p className="px-6 pb-3 text-[13px] text-danger-text">{errors.name}</p>}
        <SettingsRow
          title="Logo"
          hint={
            p.logo_domain_guessed
              ? `Iroha looks up the logo for this domain; ${p.logo_domain ? `${p.logo_domain} is guessed from the first Endpoint` : "none could be guessed"}. "none" shows a letter.`
              : 'Iroha looks up the logo for this domain. Empty guesses it from the first Endpoint; "none" shows a letter.'
          }
        >
          <form
            className="flex w-full gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (logoChanged) void save({ logo_domain: logo.trim() }, logo.trim() ? `Logo domain set to ${logo.trim()}` : "Logo domain guessed again", "logo");
            }}
          >
            <div className="relative w-full">
              <span className="absolute left-2 top-1/2 -translate-y-1/2">
                <LogoTile name={p.handle} src={domain && domain !== "none" ? logoPreview({ domain }) : undefined} size={22} />
              </span>
              <Input
                aria-label="Logo domain"
                mono
                className="pl-10"
                spellCheck={false}
                placeholder={p.logo_domain_guessed ? p.logo_domain || "example.com" : "example.com"}
                value={logo}
                onChange={(e) => setLogo(e.target.value)}
                aria-invalid={!!errors.logo}
              />
            </div>
            {logoChanged && (
              <Button type="submit" variant="primary">
                Save
              </Button>
            )}
          </form>
        </SettingsRow>
        {errors.logo && <p className="px-6 pb-3 text-[13px] text-danger-text">{errors.logo}</p>}
        <SettingsRow title="Enabled" hint={`When off, Iroha sends nothing to ${p.handle} and Pools skip it.`}>
          <Switch
            checked={p.enabled}
            label={`${p.handle} enabled`}
            onChange={(on) => void save({ enabled: on }, `${p.handle} switched ${on ? "on" : "off"}`)}
            disabled={p.archived}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Provider route">
        <SettingsRow title="Base URL" hint={`Callers send bare model names here, without the ${p.handle}/ prefix.`}>
          <Mono className="min-w-0 truncate text-fg-muted">{p.caller_path}</Mono>
          <Button size="sm" icon={Copy} onClick={() => void copyText(base, "Base URL")}>
            Copy
          </Button>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Danger zone" danger>
        {p.archived ? (
          <SettingsRow title="Restore Provider" hint={`${p.handle} is archived: it refuses Callers and Pools skip it. Restoring brings it back as it was.`}>
            <Button onClick={() => void save({ archived: false }, `${p.handle} restored`)}>Restore</Button>
          </SettingsRow>
        ) : (
          <SettingsRow
            title="Archive Provider"
            hint={`${p.handle} stops serving with its ${p.upstream_key_count} Upstream Keys and ${p.endpoints.length} Endpoints, and Pools skip it. Its handle stays reserved; nothing is deleted.`}
          >
            <Button variant="secondary" className="border-danger text-danger-text" onClick={() => setArchiving(true)}>
              Archive
            </Button>
          </SettingsRow>
        )}
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
          notifyChange(`${p.handle} archived`, res, { onUndone: refresh });
        }}
      />
    </PageBody>
  );
}
