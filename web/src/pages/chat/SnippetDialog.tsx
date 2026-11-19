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

/** curl, Python and TypeScript sending the current settings to the Gateway as a Caller (GET /api/test/snippets). */
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
        // All of it: the dialog scrolls as a page (UI ticket 28); long lines still scroll sideways.
        <CodeBlock maxHeight={false} nowrap>{code ?? "…"}</CodeBlock>
      )}
      {sn.data?.note && <p className="mt-3 text-[13.5px] text-fg-muted">{sn.data.note}</p>}
      {lang !== "curl" && (
        <p className="mt-2 text-[13px] text-fg-muted">
          {settings.shape === "gemini"
            ? "Needs nothing beyond the standard library (Node 18+ for TypeScript)."
            : settings.shape === "anthropic-messages"
              ? lang === "python"
                ? "pip install anthropic"
                : "npm install @anthropic-ai/sdk, then run as an ES module."
              : lang === "python"
                ? "pip install openai"
                : "npm install openai, then run as an ES module."}
        </p>
      )}
    </Dialog>
  );
}
