import { api, seg } from "@/api/client";
import type { ChatTarget } from "@/app/chat-panel";
import type { Capture, RequestRecord } from "@/pages/requests/api";
import { parseRequest } from "@/pages/requests/messages";
import type { Settings } from "./api";
import { DEFAULT_SETTINGS, firstModelFor, suggestedModelOf } from "./api";
import type { Turn } from "./store";
import { newChat } from "./store";

async function providerModel(handle: string): Promise<string> {
  try {
    return (await suggestedModelOf(handle)) ?? "";
  } catch {
    return "";
  }
}

export async function startFor(target: ChatTarget): Promise<void> {
  const base: Settings = { ...DEFAULT_SETTINGS };
  switch (target.kind) {
    case "provider":
      newChat({ title: `${target.provider} test`, origin: target.provider, settings: { ...base, model: await providerModel(target.provider) } });
      return;
    case "pool":
      newChat({ title: `${target.pool} test`, origin: `Model Pool ${target.pool}`, settings: { ...base, model: target.pool } });
      return;
    case "upstream_key":
      newChat({
        title: `${target.key} test`,
        origin: `${target.provider} / ${target.key}`,
        settings: { ...base, model: await providerModel(target.provider), upstreamKey: target.key },
      });
      return;
    case "model":
      newChat({ title: `${target.model} test`, origin: target.provider, settings: { ...base, model: `${target.provider}/${target.model}` } });
      return;
    case "gateway_key": {
      let model = "";
      try {
        model = (await firstModelFor(target.gatewayKey)) ?? "";
      } catch {}
      newChat({ title: `${target.gatewayKey} test`, settings: { ...base, model, as: target.gatewayKey } });
      return;
    }
    case "request":
      await startReplay(target.request);
  }
}

export function modelOfRequest(r: RequestRecord): string {
  if (r.pool) return r.pool;
  if (r.route.startsWith("/providers/") && r.provider) return `${r.provider}/${r.model}`;
  return r.model;
}

async function startReplay(id: string) {
  const r = await api.get<RequestRecord>(`/api/requests/${seg(id)}`);
  const settings: Settings = { ...DEFAULT_SETTINGS, model: modelOfRequest(r), shape: r.shape_in };
  const short = id.replace(/^req_/, "").slice(0, 6);
  let turns: Turn[] = [];
  let system: string | undefined;
  let draft = "";
  if (r.captured) {
    try {
      const cap = await api.get<Capture>(`/api/requests/${seg(id)}/capture`);
      const parsed = parseRequest(r.shape_in, cap.request.body);
      const blocks = parsed?.blocks.filter((b) => !b.note) ?? [];
      system = blocks.filter((b) => b.role === "System").map((b) => b.text).join("\n\n") || undefined;
      const convo = blocks.filter((b) => b.role === "User" || b.role === "Assistant");
      const last = convo.length - 1;
      if (last >= 0 && convo[last].role === "User") draft = convo[last].text;
      turns = convo.slice(0, draft ? last : convo.length).map((b, i) =>
        b.role === "User"
          ? { id: `r${i}`, role: "user", text: b.text }
          : { id: `r${i}`, role: "assistant", model: settings.model, shape: settings.shape, replayed: true, rounds: [{ parts: [{ kind: "text", text: b.text }], status: "done" }] },
      );
      settings.tools = [];
    } catch {}
  }
  newChat({ title: `Replay of ${short}`, origin: `Request ${id}`, settings, system, turns, draft });
}
