import { useEffect } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import { DialogTitle } from "@ui-sdk/react/dialog";
import { useChatActions } from "@/app/chat-panel";
import { seg } from "@/api/client";
import type { RequestTab } from "@/sheets/records";
import { CopyIconButton, SheetBar, SheetBody, SheetProblem, SheetTitle } from "@/sheets/Sheet";
import type { SheetBodyProps } from "@/sheets/SheetStack";
import { useSheets } from "@/sheets/stack";
import { IconButton } from "@/ui/Button";
import { popupOpen } from "@/ui/popup";
import { Skeleton } from "@/ui/Skeleton";
import { Tab as UITab, TabList, TabPanel, Tabs } from "@/ui/Tabs";
import { usePrefetchRequests, useRequest } from "./api";
import { AttemptList } from "./Attempts";
import { ProviderLogo, StatusPill, when } from "./bits";
import { CapturedView } from "./Captured";
import { RequestDetails } from "./Details";
import { SAMPLE_REQUEST } from "./samples";

function busyTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return true;
  return popupOpen();
}

export function RequestSheet({ record, index, top }: SheetBodyProps<"request">) {
  const { id } = record;
  const tab: RequestTab = record.tab ?? "details";
  const sheets = useSheets();
  const chat = useChatActions();
  const navigate = useNavigate();
  const rows = sheets.requestRows;
  const req = useRequest(id, rows.find((x) => x.id === id));
  const r = req.data;
  const at = index === 0 ? rows.findIndex((x) => x.id === id) : -1;
  const prev = at > 0 ? rows[at - 1] : undefined;
  const next = at >= 0 && at < rows.length - 1 ? rows[at + 1] : undefined;
  usePrefetchRequests(top ? [prev, next] : [], { captures: tab === "captured" });
  const step = (to: string) => sheets.replace(index, { kind: "request", id: to, tab: record.tab });
  const setTab = (t: RequestTab) => sheets.replace(index, { ...record, tab: t === "details" ? undefined : t });

  useEffect(() => {
    if (!top || at < 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || busyTarget(e)) return;
      if ((e.key === "ArrowUp" || e.key === "k") && prev) sheets.replace(0, { kind: "request", id: prev.id, tab: record.tab });
      else if ((e.key === "ArrowDown" || e.key === "j") && next) sheets.replace(0, { kind: "request", id: next.id, tab: record.tab });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top, at, prev, next, sheets, record.tab]);

  const page = `/requests/${seg(id)}/route`;
  const bar = (
    <SheetBar
      kind={<span className="font-mono text-fg-muted">{id}</span>}
      page={page}
      start={
        at >= 0 && (
          <>
            <IconButton icon={ChevronUp} label="Newer Request (↑)" bordered size="sm" className="size-8" disabled={!prev} focusableWhenDisabled onClick={() => prev && step(prev.id)} />
            <IconButton icon={ChevronDown} label="Older Request (↓)" bordered size="sm" className="mr-1 size-8" disabled={!next} focusableWhenDisabled onClick={() => next && step(next.id)} />
          </>
        )
      }
    >
      <CopyIconButton text={id} what="Request ID" />
    </SheetBar>
  );

  if (!r && req.isError)
    return (
      <>
        {bar}
        <SheetProblem kind="Request" name={id} error={req.error} onRetry={() => void req.refetch()} />
      </>
    );

  return (
    <>
      {bar}
      <SheetBody>
        {!r && <DialogTitle className="sr-only">{`Request ${id}`}</DialogTitle>}
        <Skeleton data={r} sample={SAMPLE_REQUEST} id="request-drawer" label="Loading Request">
          {(r) => (
            <>
              <SheetTitle
                kind="Request"
                logo={r.provider ? <ProviderLogo handle={r.provider} size={44} /> : undefined}
                title={r.model || "No model"}
                subtitle={when(r.started_at)}
                state={<StatusPill r={r} />}
              />
              <Tabs value={tab} onValueChange={(t) => t && setTab(t as RequestTab)}>
                <TabList label="Request tabs" className="mb-6">
                  {(
                    [
                      ["details", "Details"],
                      ["attempts", "Attempts"],
                      ["captured", "Captured"],
                    ] as const
                  ).map(([t, label]) => (
                    <UITab key={t} value={t}>
                      {label}
                      {t === "attempts" && <span className="ml-2 tabular text-fg-muted">{r.attempt_count}</span>}
                    </UITab>
                  ))}
                </TabList>
                <TabPanel value="details">
                  <RequestDetails r={r} onShowCaptured={() => setTab("captured")} />
                </TabPanel>
                <TabPanel value="attempts">
                  <AttemptList r={r} loading={!r.attempts && req.isFetching} onOpenRoute={() => navigate(page)} />
                </TabPanel>
                <TabPanel value="captured">
                  <CapturedView r={r} onReplay={() => chat.open({ kind: "request", request: r.id })} />
                </TabPanel>
              </Tabs>
            </>
          )}
        </Skeleton>
      </SheetBody>
    </>
  );
}
