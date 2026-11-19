import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, ChevronUp, Copy, Route as RouteIcon, X } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { CHAT_WIDTH } from "@/app/Shell";
import { seg } from "@/api/client";
import { useIsPhone } from "@/lib/media";
import { IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Skeleton } from "@/ui/Skeleton";
import { ErrorState } from "@/ui/States";
import { notify } from "@/ui/toast";
import type { RequestRecord } from "./api";
import { useCopy, useRequest } from "./api";
import { AttemptList } from "./Attempts";
import { ProviderLogo, StatusPill, when } from "./bits";
import { CapturedView } from "./Captured";
import { RequestDetails } from "./Details";
import { SAMPLE_REQUEST } from "./samples";

export const DRAWER_WIDTH = 540;

type Tab = "details" | "attempts" | "captured";

/** True when a key press belongs to a text field, a menu or a dialog. */
function busyTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return true;
  return !!document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]');
}

/**
 * The Request drawer (C04, C21, C26): Details, Attempts and Captured tabs.
 * Up and down (or k and j) step through the feed, Escape closes. It sits
 * beside the chat sheet when that is open, and fills the screen on phones.
 */
export function RequestDrawer({
  id,
  seed,
  rows,
  onSelect,
  onClose,
}: {
  id: string;
  seed?: RequestRecord;
  rows: RequestRecord[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const phone = useIsPhone();
  const chat = useChatPanel();
  const navigate = useNavigate();
  const copy = useCopy();
  const [tab, setTab] = useState<Tab>("details");
  const req = useRequest(id, seed);
  const r = req.data;
  const index = rows.findIndex((x) => x.id === id);
  const prev = index > 0 ? rows[index - 1] : undefined;
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || busyTarget(e)) return;
      if (e.key === "Escape") onClose();
      else if ((e.key === "ArrowUp" || e.key === "k") && prev) onSelect(prev.id);
      else if ((e.key === "ArrowDown" || e.key === "j") && next) onSelect(next.id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prev, next, onSelect, onClose]);

  const openRoute = () => navigate(`/requests/${seg(id)}/route`);

  return (
    <aside
      aria-label={`Request ${id}`}
      style={phone ? undefined : { width: DRAWER_WIDTH, right: chat.isOpen ? CHAT_WIDTH : 0 }}
      className={cn(
        "fixed inset-y-0 z-30 flex flex-col border-l border-border bg-bg shadow-elevated",
        phone ? "inset-x-0 z-40" : "max-w-full",
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <IconButton icon={ChevronUp} label="Newer Request (↑)" bordered size="sm" className="size-8" disabled={!prev} onClick={() => prev && onSelect(prev.id)} />
        <IconButton icon={ChevronDown} label="Older Request (↓)" bordered size="sm" className="size-8" disabled={!next} onClick={() => next && onSelect(next.id)} />
        <span className="ml-1 min-w-0 flex-1 truncate font-mono text-[13.5px] text-fg-muted">{id}</span>
        <IconButton
          icon={Copy}
          label="Copy Request ID"
          onClick={async () => (await copy(id)) && notify.copied("Request ID")}
        />
        <IconButton icon={RouteIcon} label="Open the Route view" onClick={openRoute} />
        <IconButton icon={X} label="Close (Esc)" onClick={onClose} />
      </div>

      {req.isError && !r ? (
        <ErrorState title="Couldn't load this Request" error={req.error} onRetry={() => void req.refetch()} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
          {/* Opened from the feed, the row seeds it and no skeleton shows; from a link, the Details tab is measured. */}
          <Skeleton data={r} sample={SAMPLE_REQUEST} id="request-drawer" label="Loading Request">
            {(r) => (
          <>
          <header className="flex items-start gap-3.5 pb-5 pt-6">
            {r.provider ? <ProviderLogo handle={r.provider} size={44} /> : null}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[20px] font-semibold leading-tight">{r.model || "No model"}</h2>
              <p className="mt-1 text-[14.5px] text-fg-muted">{when(r.started_at)}</p>
            </div>
            <StatusPill r={r} />
          </header>
          <nav className="mb-6 flex gap-7 border-b border-border" aria-label="Request tabs">
            {(
              [
                ["details", "Details"],
                ["attempts", "Attempts"],
                ["captured", "Captured"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                type="button"
                aria-current={tab === t ? "page" : undefined}
                onClick={() => setTab(t)}
                className={cn(
                  "-mb-px whitespace-nowrap border-b-2 pb-2.5 text-[15.5px] transition-colors",
                  tab === t ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {label}
                {t === "attempts" && <span className="ml-2 tabular text-fg-muted">{r.attempt_count}</span>}
              </button>
            ))}
          </nav>
          {tab === "details" && <RequestDetails r={r} onShowCaptured={() => setTab("captured")} />}
          {tab === "attempts" && <AttemptList r={r} loading={!r.attempts && req.isFetching} onOpenRoute={openRoute} />}
          {tab === "captured" && <CapturedView r={r} onReplay={() => chat.open({ kind: "request", request: r.id })} />}
          </>
            )}
          </Skeleton>
        </div>
      )}
    </aside>
  );
}
