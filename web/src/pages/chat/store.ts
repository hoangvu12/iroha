import { useSyncExternalStore } from "react";
import type { LegacySettings, Message, Settings, Shape, StreamEvent, ToolCall, ToolCheck } from "./api";
import { DEFAULT_SETTINGS, migrateLegacySettings, sendBody, streamTurn } from "./api";

export type Part =
  | { kind: "text" | "reasoning"; text: string }
  | { kind: "tool"; index: number; id?: string; name: string; args: string };

export type Round = {
  requestId?: string;
  parts: Part[];
  status: "streaming" | "done" | "failed" | "stopped";
  error?: string;
  toolCheck?: ToolCheck;
};

export type UserTurn = { id: string; role: "user"; text: string };
export type AssistantTurn = { id: string; role: "assistant"; model: string; shape: Shape; rounds: Round[]; replayed?: boolean };
export type Turn = UserTurn | AssistantTurn;

export type Chat = {
  id: string;
  title: string;
  origin?: string;
  createdAt: number;
  updatedAt: number;
  settings: Settings;
  system?: string;
  turns: Turn[];
  draft?: string;
};

type StoredChat = Omit<Chat, "settings"> & { settings: LegacySettings };

type State = { chats: Chat[]; currentId?: string; running: number };

const KEY = "iroha.chats.v1";
const RECENT_KEY = "iroha.chat.recent-models";
const MAX_CHATS = 30;

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as { chats: StoredChat[]; currentId?: string };
      const chats = s.chats.map((c): Chat => ({ ...c, settings: migrateLegacySettings(c.settings) }));
      for (const c of chats) for (const t of c.turns) if (t.role === "assistant") for (const r of t.rounds) if (r.status === "streaming") r.status = "stopped";
      return { chats, currentId: s.currentId, running: 0 };
    }
  } catch {}
  return { chats: [], running: 0 };
}

let state: State = load();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      const chats = state.chats.filter((c) => c.turns.length > 0 || c.id === state.currentId).slice(0, MAX_CHATS);
      localStorage.setItem(KEY, JSON.stringify({ chats, currentId: state.currentId }));
    } catch {}
  }, 400);
}

function set(fn: (s: State) => State) {
  state = fn(state);
  save();
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useChatState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function currentChat(s: State): Chat | undefined {
  return s.chats.find((c) => c.id === s.currentId);
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function updateChat(id: string, fn: (c: Chat) => Chat) {
  set((s) => ({ ...s, chats: s.chats.map((c) => (c.id === id ? { ...fn(c), updatedAt: Date.now() } : c)) }));
}

export function newChat(init: Partial<Pick<Chat, "title" | "origin" | "settings" | "system" | "turns" | "draft">> = {}): string {
  const id = newId();
  const now = Date.now();
  const prev = currentChat(state);
  const settings = init.settings ?? { ...DEFAULT_SETTINGS, ...(prev ? { model: prev.settings.model, shape: prev.settings.shape } : {}) };
  const chat: Chat = {
    id,
    title: init.title ?? "New chat",
    origin: init.origin,
    createdAt: now,
    updatedAt: now,
    settings,
    system: init.system,
    turns: init.turns ?? [],
    draft: init.draft,
  };
  set((s) => ({ ...s, chats: [chat, ...s.chats.filter((c) => c.turns.length > 0)].slice(0, MAX_CHATS), currentId: id }));
  return id;
}

export function openChat(id: string) {
  set((s) => ({ ...s, currentId: id }));
}

export function deleteChat(id: string) {
  stop(id);
  set((s) => ({ ...s, chats: s.chats.filter((c) => c.id !== id), currentId: s.currentId === id ? undefined : s.currentId }));
}

export function setSettings(id: string, patch: Partial<Settings>) {
  updateChat(id, (c) => ({ ...c, settings: { ...c.settings, ...patch } }));
  if (patch.model) rememberModel(patch.model);
}

export function recentModels(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function rememberModel(model: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([model, ...recentModels().filter((m) => m !== model)].slice(0, 12)));
  } catch {}
}

let lastStartedTestSeq = 0;

export function claimTestStart(seq: number): boolean {
  if (seq <= lastStartedTestSeq) return false;
  lastStartedTestSeq = seq;
  return true;
}

const running = new Map<string, AbortController>();

export function isRunning(id: string): boolean {
  return running.has(id);
}

export function stop(id: string) {
  running.get(id)?.abort();
}

export function roundText(r: Round): string {
  return r.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
}

export function roundCalls(r: Round): ToolCall[] {
  return r.parts.flatMap((p) => (p.kind === "tool" ? [{ id: p.id, name: p.name, arguments: p.args }] : []));
}

export function messagesOf(turns: Turn[]): Message[] {
  const out: Message[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      out.push({ role: "user", content: t.text });
      continue;
    }
    for (const r of t.rounds) {
      const content = roundText(r);
      const calls = roundCalls(r);
      if (!content && calls.length === 0) continue;
      out.push({ role: "assistant", content, tool_calls: calls.length ? calls : undefined });
    }
  }
  return out;
}

function apply(parts: Part[], e: StreamEvent): Part[] {
  if (e.kind === "text" || e.kind === "reasoning") {
    const last = parts[parts.length - 1];
    if (last && last.kind === e.kind) return [...parts.slice(0, -1), { ...last, text: last.text + e.text }];
    return [...parts, { kind: e.kind, text: e.text }];
  }
  if (e.kind === "tool") {
    const i = parts.findIndex((p) => p.kind === "tool" && p.index === e.index);
    if (i < 0) return [...parts, { kind: "tool", index: e.index, id: e.id, name: e.name ?? "", args: e.args ?? "" }];
    const p = parts[i] as Extract<Part, { kind: "tool" }>;
    const next = { ...p, id: p.id || e.id, name: p.name || e.name || "", args: e.replace && e.args !== undefined ? e.args : p.args + (e.args ?? "") };
    return parts.map((x, j) => (j === i ? next : x));
  }
  return parts;
}

function findReply(chatId: string, turnId: string): AssistantTurn | undefined {
  const t = state.chats.find((c) => c.id === chatId)?.turns.find((x) => x.id === turnId);
  return t?.role === "assistant" ? t : undefined;
}

function patchReply(chatId: string, turnId: string, fn: (t: AssistantTurn) => AssistantTurn) {
  updateChat(chatId, (c) => ({ ...c, turns: c.turns.map((t) => (t.id === turnId && t.role === "assistant" ? fn(t) : t)) }));
}

function patchRound(chatId: string, turnId: string, index: number, fn: (r: Round) => Round) {
  patchReply(chatId, turnId, (t) => ({ ...t, rounds: t.rounds.map((r, i) => (i === index ? fn(r) : r)) }));
}

export const MAX_ROUNDS = 5;

export async function send(chatId: string, text: string) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat || running.has(chatId) || !chat.settings.model) return;
  const settings = chat.settings;
  const user: UserTurn = { id: newId(), role: "user", text };
  const reply: AssistantTurn = { id: newId(), role: "assistant", model: settings.model, shape: settings.shape, rounds: [] };
  updateChat(chatId, (c) => ({
    ...c,
    title: c.title === "New chat" && c.turns.length === 0 ? text.slice(0, 48) : c.title,
    draft: undefined,
    turns: [...c.turns, user, reply],
  }));
  rememberModel(settings.model);
  const ctrl = new AbortController();
  running.set(chatId, ctrl);
  set((s) => ({ ...s, running: running.size }));
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const current = state.chats.find((c) => c.id === chatId);
      if (!current) return;
      const before = current.turns.filter((t) => t.id !== reply.id);
      const sofar = findReply(chatId, reply.id);
      const messages = messagesOf(sofar && sofar.rounds.length ? [...before, sofar] : before);
      patchReply(chatId, reply.id, (t) => ({ ...t, rounds: [...t.rounds, { parts: [], status: "streaming" }] }));
      const res = await streamTurn(
        sendBody(settings, current.system, messages),
        settings.shape,
        (e) => patchRound(chatId, reply.id, round, (r) => (e.kind === "tool_check" ? { ...r, toolCheck: e.check } : e.kind === "error" ? r : { ...r, parts: apply(r.parts, e) })),
        ctrl.signal,
      );
      patchRound(chatId, reply.id, round, (r) => ({ ...r, requestId: res.requestId, status: res.error ? "failed" : "done", error: res.error }));
      const done = findReply(chatId, reply.id)?.rounds[round];
      if (!done || res.error || settings.tools.length === 0 || roundCalls(done).length === 0) break;
    }
  } catch {
    patchReply(chatId, reply.id, (t) => ({ ...t, rounds: t.rounds.map((r) => (r.status === "streaming" ? { ...r, status: "stopped" } : r)) }));
  } finally {
    running.delete(chatId);
    set((s) => ({ ...s, running: running.size }));
  }
}
