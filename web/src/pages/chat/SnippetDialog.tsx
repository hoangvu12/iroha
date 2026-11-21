import { useState } from "react";
import { CodeBlock } from "@/pages/requests/bits";
import { Segmented } from "@/pages/providers/controls";
import { CopyButton } from "@/ui/CopyButton";
import { Dialog } from "@/ui/Dialog";
import { ErrorState } from "@/ui/States";
import type { Settings } from "./api";
import { useSnippets } from "./api";

type Lang = "curl" | "python" | "typescript";
const LABEL: Record<Lang, string> = { curl: "curl", python: "Python", typescript: "TypeScript" };
const LEXER = { curl: "shell", python: "python", typescript: "typescript" } as const;

export function SnippetDialog({ open, onOpenChange, settings, prompt }: { open: boolean; onOpenChange: (o: boolean) => void; settings: Settings; prompt: string }) {
  const [lang, setLang] = useState<Lang>("curl");
  const sn = useSnippets(settings, prompt, open);
  const code = sn.data?.[lang];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={720}
      title="Use this from code"
      description={
        settings.as
          ? `Sends the same request to Iroha as ${settings.as}, with its key.`
          : "Sends the same request to Iroha as a Caller. Set IROHA_KEY to a Gateway Key first."
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <Segmented<Lang> label="Language" value={lang} onChange={setLang} items={(Object.keys(LABEL) as Lang[]).map((l) => ({ value: l, label: LABEL[l] }))} />
        <div className="flex-1" />
        <CopyButton size="md" value={code ?? ""} what={`${LABEL[lang]} snippet`} disabled={!code} />
      </div>
      {sn.isError ? (
        <ErrorState title="Couldn't write the snippet" error={sn.error} onRetry={() => void sn.refetch()} />
      ) : (
        <CodeBlock maxHeight={false} nowrap lang={code ? LEXER[lang] : "text"}>
          {code ?? "…"}
        </CodeBlock>
      )}
    </Dialog>
  );
}
