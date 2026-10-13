// Folding a Turn's events into what the chat and the Turn panel show, and replaying a past Turn's events.
import type { A12sEvent, Fleet, TokenUsage, Turn } from "@coltonkirsten/a12s";

export type ChatItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input?: unknown; output?: unknown; isError?: boolean; done: boolean; startedAt?: number; finishedAt?: number }
  | { kind: "denied"; host: string; port: number; reason?: string };

export interface ChatMsg {
  id: string;
  sender: string;
  via: string;
  createdAt: string;
  body?: string;
}

export interface ChatTurn {
  id: string;
  messages: ChatMsg[];
  items: ChatItem[];
  status?: "completed" | "failed" | "interrupted";
  error?: string;
  tokens?: TokenUsage;
  startedAt?: string;
  finishedAt?: string;
  /** Folded from the Turn's events (exact order), or only from its summary (tools, then text). */
  exact: boolean;
  fresh?: boolean;
}

/** A finished Turn from history, before (or without) its events. */
export function fromSummary(t: Turn): ChatTurn {
  const items: ChatItem[] = t.tools.map((x) => ({ kind: "tool", id: x.id, name: x.name, input: x.input, output: x.output, isError: x.isError, done: true }));
  if (t.text) items.push({ kind: "text", text: t.text });
  return {
    id: t.id,
    messages: t.messages.map((m) => ({ id: m.id, sender: m.sender, via: m.via, createdAt: m.createdAt })),
    items,
    status: t.status,
    error: t.error,
    tokens: t.tokens,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    exact: false,
  };
}

/** Folds one more event of a Turn into it (mutates and returns it). */
export function foldEvent(t: ChatTurn, ev: A12sEvent): ChatTurn {
  const at = Date.parse(ev.ts);
  switch (ev.type) {
    case "turn.started":
      t.startedAt = ev.ts;
      if (ev.data.inbox?.messages?.length) {
        const known = new Map(t.messages.map((m) => [m.id, m]));
        t.messages = ev.data.inbox.messages.map((m) => ({ ...known.get(m.id), id: m.id, sender: m.sender, via: m.via, createdAt: m.createdAt }));
      }
      break;
    case "text.delta": {
      const last = t.items[t.items.length - 1];
      if (last?.kind === "text") last.text += ev.data.text;
      else t.items.push({ kind: "text", text: ev.data.text });
      break;
    }
    case "tool.started":
      t.items.push({ kind: "tool", id: ev.data.id, name: ev.data.name, input: ev.data.input, done: false, startedAt: at });
      break;
    case "tool.finished": {
      const tool = t.items.find((x): x is Extract<ChatItem, { kind: "tool" }> => x.kind === "tool" && x.id === ev.data.id);
      if (tool) Object.assign(tool, { output: ev.data.output, isError: ev.data.isError, done: true, finishedAt: at });
      else t.items.push({ kind: "tool", id: ev.data.id, name: ev.data.name, output: ev.data.output, isError: ev.data.isError, done: true, finishedAt: at });
      break;
    }
    case "egress.denied":
      t.items.push({ kind: "denied", host: ev.data.host, port: ev.data.port, reason: ev.data.reason });
      break;
    case "turn.finished":
      t.status = ev.data.status;
      t.error = ev.data.error;
      t.tokens = ev.data.tokens;
      t.finishedAt = ev.ts;
      for (const x of t.items) if (x.kind === "tool" && !x.done) x.done = true;
      break;
  }
  return t;
}

export function emptyTurn(id: string): ChatTurn {
  return { id, messages: [], items: [], exact: true };
}

const replays = new Map<string, A12sEvent[]>();

/** Every event of a Turn, from the agent computer's journal; a finished Turn's are cached. */
export async function replayTurn(fleet: Fleet, name: string, turn: string, onEvent?: (ev: A12sEvent) => void, signal?: AbortSignal): Promise<A12sEvent[]> {
  const key = `${name}/${turn}`;
  const cached = replays.get(key);
  if (cached) {
    cached.forEach((e) => onEvent?.(e));
    return cached;
  }
  const out: A12sEvent[] = [];
  const ac = await fleet.agentComputers.get(name);
  const stream = ac.events({ turn, signal });
  let finished = false;
  // a Turn that has no turn.finished in its journal (cut off by a restart) would follow forever: give up after a while
  const timer = setTimeout(() => stream.close(), 15_000);
  try {
    for await (const ev of stream) {
      if (ev.turn !== turn) continue;
      out.push(ev);
      onEvent?.(ev);
      if (ev.type === "turn.finished") {
        finished = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    stream.close();
  }
  if (finished) replays.set(key, out);
  return out;
}

/** Where a finished Turn's time went, from its events: waiting in the inbox, thinking, in tools, answering. */
export function timing(events: A12sEvent[], firstMessageAt?: string) {
  const start = events.find((e) => e.type === "turn.started");
  const end = events.find((e) => e.type === "turn.finished");
  if (!start || !end) return null;
  const t0 = Date.parse(start.ts);
  const t1 = Date.parse(end.ts);
  const queue = firstMessageAt ? Math.max(0, t0 - Date.parse(firstMessageAt)) : 0;
  let tools = 0;
  const open = new Map<string, number>();
  for (const e of events) {
    if (e.type === "tool.started") open.set(e.data.id, Date.parse(e.ts));
    if (e.type === "tool.finished" && open.has(e.data.id)) tools += Date.parse(e.ts) - open.get(e.data.id)!;
  }
  const firstText = events.find((e) => e.type === "text.delta");
  const lastTool = [...events].reverse().find((e) => e.type === "tool.finished");
  const answerFrom = firstText ? Math.max(Date.parse(firstText.ts), lastTool ? Date.parse(lastTool.ts) : 0) : t1;
  const answer = Math.max(0, t1 - answerFrom);
  const think = Math.max(0, t1 - t0 - tools - answer);
  return { queue, think, tools, answer, total: t1 - t0 };
}
