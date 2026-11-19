import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { seg } from "@/api/client";
import { logoPreview } from "@/api/logos";
import { PageBody } from "@/app/PageBody";
import { Button } from "@/ui/Button";
import { TypeToConfirmDialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import type { Pool } from "./api";
import { calls, errorText, useRefresh } from "./api";
import { SettingsCard, SettingsRow } from "./controls";
import { LogoInput } from "./LogoField";

/** A Pool's settings: name, logo (a maker or a website), budget, and deleting it. */
export function PoolSettingsTab({ pool }: { pool: Pool }) {
  const refresh = useRefresh();
  const navigate = useNavigate();
  const [name, setName] = useState(pool.name);
  const [maker, setMaker] = useState(pool.maker_guessed ? "" : pool.maker);
  const [attempts, setAttempts] = useState(pool.budget.max_attempts ? String(pool.budget.max_attempts) : "");
  const [firstByte, setFirstByte] = useState(pool.budget.first_byte_seconds ? String(pool.budget.first_byte_seconds) : "");
  const [deleting, setDeleting] = useState(false);
  // Each setting shows its result where it was changed, a failure under its row.
  const naming = useSave({ describe: errorText });
  const makerSave = useSave({ refresh, describe: errorText });
  const budgetSave = useSave({ refresh, describe: errorText });

  useEffect(() => {
    setName(pool.name);
    setMaker(pool.maker_guessed ? "" : pool.maker);
    setAttempts(pool.budget.max_attempts ? String(pool.budget.max_attempts) : "");
    setFirstByte(pool.budget.first_byte_seconds ? String(pool.budget.first_byte_seconds) : "");
  }, [pool]);

  const update = (body: Parameters<typeof calls.updatePool>[1]) => () => calls.updatePool(pool.name, body);
  const rename = (to: string) =>
    naming.run(async () => {
      const res = await calls.updatePool(pool.name, { name: to });
      refresh();
      // Toast: the page moves to the Pool's new address and loads it again, so this field is gone.
      notifyChange(`${pool.name} renamed to ${to}`, res, { onUndone: refresh });
      navigate(`/providers/pools/${seg(to)}/settings`, { replace: true });
    }, { quiet: true });
  const budgetChanged = attempts !== (pool.budget.max_attempts ? String(pool.budget.max_attempts) : "") || firstByte !== (pool.budget.first_byte_seconds ? String(pool.budget.first_byte_seconds) : "");

  return (
    <PageBody width="readable">
      <SettingsCard title="General">
        <SettingsRow title="Name" hint="The model Callers ask for. Renaming breaks Callers still using the old name.">
          <form
            className="flex w-full gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== pool.name) void rename(name.trim());
            }}
          >
            <Input aria-label="Name" mono value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!naming.error} />
            {name.trim() !== pool.name && (
              <Button type="submit" variant="primary" loading={naming.pending}>
                Save
              </Button>
            )}
          </form>
        </SettingsRow>
        <SaveError save={naming} className="px-6 pb-3" />
        <SettingsRow
          title="Logo"
          hint={
            pool.maker_guessed
              ? `A model maker (openai) or a website (chatgpt.com). ${pool.maker ? `${pool.maker} is guessed from the name and members.` : "No maker could be guessed."}`
              : "A model maker (openai) or a website (chatgpt.com); empty guesses the maker."
          }
        >
          <form
            className="flex w-full items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void makerSave.run(update({ maker: maker.trim() }), { message: maker.trim() ? `Logo set to ${maker.trim()}` : "Maker guessed again" });
            }}
          >
            <LogoInput
              label="Maker or website"
              name={pool.name}
              shape="square"
              value={maker}
              fallback={pool.maker}
              previewUrl={(v) => logoPreview({ maker: v })}
              onChange={setMaker}
              placeholder={pool.maker || "openai or chatgpt.com"}
              invalid={!!makerSave.error}
            />
            {maker.trim() !== (pool.maker_guessed ? "" : pool.maker) ? (
              <Button type="submit" variant="primary" loading={makerSave.pending}>
                Save
              </Button>
            ) : (
              <SaveStatus save={makerSave} className="mt-2 shrink-0" />
            )}
          </form>
        </SettingsRow>
        <SaveError save={makerSave} className="px-6 pb-3" />
      </SettingsCard>

      <SettingsCard title="Budget">
        <SettingsRow title="Per Request" hint="Attempts (1 to 10) and seconds to the first byte (1 to 95) across all members. Empty: the serving Provider's own.">
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void budgetSave.run(update({ budget: { max_attempts: Number(attempts) || 0, first_byte_seconds: Number(firstByte) || 0 } }), { message: "Budget saved" });
            }}
          >
            <Input aria-label="Attempts at most" inputMode="numeric" placeholder="Attempts" value={attempts} onChange={(e) => setAttempts(e.target.value)} />
            <Input aria-label="Seconds to the first byte" inputMode="numeric" placeholder="Seconds" value={firstByte} onChange={(e) => setFirstByte(e.target.value)} />
            {budgetChanged ? (
              <Button type="submit" variant="primary" loading={budgetSave.pending}>
                Save
              </Button>
            ) : (
              <SaveStatus save={budgetSave} className="shrink-0" />
            )}
          </form>
        </SettingsRow>
        <SaveError save={budgetSave} className="px-6 pb-3" />
      </SettingsCard>

      <SettingsCard title="Danger zone" danger>
        <SettingsRow title="Delete Model Pool" hint={`Callers asking for ${pool.name} are refused. Its Providers and keys are not touched.`}>
          <Button danger onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </SettingsRow>
      </SettingsCard>

      <TypeToConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${pool.name}?`}
        body={`Callers asking for ${pool.name} are refused from now on. Gateway Keys scoped to it must lose it first. Undo brings it back.`}
        name={pool.name}
        confirmLabel="Delete Pool"
        onConfirm={async () => {
          const res = await calls.deletePool(pool.name);
          refresh();
          // Toast: the page navigates to the Providers list; Undo after a delete.
          notifyChange(`${pool.name} deleted`, res, { onUndone: refresh });
          navigate("/providers");
        }}
      />
    </PageBody>
  );
}
