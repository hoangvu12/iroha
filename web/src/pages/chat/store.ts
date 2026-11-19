import { useSyncExternalStore } from "react";
import type { Message, Settings, Shape, StreamEvent, ToolCall, ToolCheck } from "./api";
import { DEFAULT_SETTINGS, sendBody, streamTurn } from "./api";

// The chats (ticket 23). Kept in this browser's localStorage, so they
// survive a reload; nothing about them is configuration, and every turn is
// also a test Request in Requests (captured), which is the durable record.
// The store lives outside React so a reply keeps streaming while the panel
// is closed or the page changes.

export type Part =
  | { kind: "text" | "reasoning"; text: string }
  | { kind: "tool"; index: number; id?: string; name: string; args: string };

/** One Request of an assistant turn: the answer, or the follow-up after a tool call. */
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
  /** "Opened from dashscope": what the Test button was on. */
  origin?: string;
  createdAt: number;
  updatedAt: number;
  settings: Settings;
  system?: string;
  turns: Turn[];
  /** Text waiting in the composer (a replayed prompt). */
  draft?: string;
};

type State = { chats: Chat[]; currentId?: string; running: number };

const KEY = "iroha.chats.v1";
const RECENT_KEY = "iroha.chat.recent-models";
const MAX_CHATS = 30;

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as { chats: Chat[]; currentId?: string };
      // A reply cut by a reload is not streaming any more.
      for (const c of s.chats)
        for (const t of c.turns) if (t.role === "assistant") for (const r of t.rounds) if (r.status === "streaming") r.status = "stopped";
      return { chats: s.chats, currentId: s.currentId, running: 0 };
    }
  } catch {
    /* storage blocked or corrupt: start empty */
  }
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
      // Only chats with turns are worth keeping, newest first.
      const chats = state.chats.filter((c) => c.turns.length > 0 || c.id === state.currentId).slice(0, MAX_CHATS);
      localStorage.setItem(KEY, JSON.stringify({ chats, currentId: state.currentId }));
    } catch {
      /* full or blocked: the chats live until the tab closes */
    }
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

/** Start a new chat and make it current. Empty chats are dropped rather than kept in the history. */
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

// ---- Recently used models ---------------------------------------------------

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
  } catch {
    /* not kept */
  }
}

// ---- Sending ------------------------------------------------------------------

const running = new Map<string, AbortController>();

export function isRunning(id: string): boolean {
  return running.has(id);
}

export function stop(id: string) {
  running.get(id)?.abort();
}

/** The text of a round, without reasoning. */
export function roundText(r: Round): string {
  return r.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
}

export function roundCalls(r: Round): ToolCall[] {
  return r.parts.flatMap((p) => (p.kind === "tool" ? [{ id: p.id, name: p.name, arguments: p.args }] : []));
}

/** The conversation as POST /api/test takes it. */
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

/**
 * Send text as the next user turn and stream the reply. With the tool
 * check on, a reply that calls the tool is followed by one more Request
 * carrying the made-up result, whose answer joins the same reply.
 */
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
    for (let round = 0; round < 2; round++) {
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
      if (!done || res.error || !settings.toolCheck || roundCalls(done).length === 0) break;
    }
  } catch {
    // Stopped: keep what arrived.
    patchReply(chatId, reply.id, (t) => ({ ...t, rounds: t.rounds.map((r) => (r.status === "streaming" ? { ...r, status: "stopped" } : r)) }));
  } finally {
    running.delete(chatId);
    set((s) => ({ ...s, running: running.size }));
  }
}
