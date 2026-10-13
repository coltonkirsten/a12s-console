import type { Turn } from "@coltonkirsten/a12s";
import type { ConsoleEvent } from "./types";

export function clock(ts: string | number | undefined): string {
  if (ts === undefined) return "";
  const d = new Date(ts);
  if (Number.isNaN(+d)) return "";
  return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts: string | number | undefined): string {
  if (ts === undefined) return "";
  const d = new Date(ts);
  if (Number.isNaN(+d)) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(ts) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ago(ts: string | number | undefined, now = Date.now()): string {
  if (ts === undefined) return "";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return "";
  return dur(Math.max(0, now - t)) + " ago";
}

/** 820ms, 4.2s, 1m12s, 3h04m, 2d */
export function dur(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

export function turnMs(t: Pick<Turn, "startedAt" | "finishedAt">): number | undefined {
  if (!t.startedAt) return undefined;
  return Date.parse(t.finishedAt) - Date.parse(t.startedAt);
}

/** 18,204 -> 18.2k */
export function tok(n: number | undefined): string {
  if (n === undefined) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function num(n: number | undefined): string {
  return n === undefined ? "–" : n.toLocaleString("en-US");
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function totalTokens(t: Pick<Turn, "tokens">): number {
  const k = t.tokens;
  return k ? k.input + k.output + k.cacheRead + k.cacheWrite : 0;
}

export function isToday(ts: string): boolean {
  return new Date(ts).toDateString() === new Date().toDateString();
}

export function tokensToday(turns: Turn[] | undefined): number {
  return (turns ?? []).filter((t) => isToday(t.finishedAt)).reduce((s, t) => s + totalTokens(t), 0);
}

export function short(v: unknown, max = 90): string {
  let s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** The interesting argument of a tool call, for one line: a command, a path, a URL, a query. */
export function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return short(input, 120);
  const o = input as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "url", "pattern", "query", "computer", "description", "prompt"]) {
    if (typeof o[k] === "string") return short(k === "computer" ? `→ ${o[k]}: ${o.body ?? ""}` : o[k], 120);
  }
  return short(input, 120);
}

export function nameOf(ev: { agentComputer?: string; computer?: string; type: string; data?: unknown }): string {
  if (ev.type === "service.phase") return (ev.data as { service?: string })?.service ?? "";
  if (ev.type === "fleet.changed") return "fleet";
  return ev.agentComputer || ev.computer || "fleet";
}

/** One line about an event, for timelines. */
export function summary(ev: ConsoleEvent): string {
  switch (ev.type) {
    case "turn.started": {
      const m = ev.data.inbox?.messages ?? [];
      if (!m.length) return ev.data.continuation ? "continuation" : "";
      const via = [...new Set(m.map((x) => x.via))].join(", ");
      return `${m.length} message${m.length > 1 ? "s" : ""} · via ${via}${ev.data.resumed ? " · resumed" : ""}`;
    }
    case "text.delta":
      return `"${short(ev.data.text, 140)}"`;
    case "tool.started":
      return `${ev.data.name}  ${toolArg(ev.data.input)}`;
    case "tool.finished":
      return `${ev.data.name}  ${ev.data.isError ? "error" : "ok"}${ev.data.output !== undefined ? "  " + short(ev.data.output, 80) : ""}`;
    case "turn.finished": {
      const k = ev.data.tokens;
      return `${ev.data.status}${k ? ` · ${tok(k.input + k.output + k.cacheRead + k.cacheWrite)} tokens` : ""}${ev.data.error ? ` · ${short(ev.data.error, 80)}` : ""}`;
    }
    case "egress.denied":
      return `${ev.data.host}:${ev.data.port}${ev.data.reason ? ` · ${ev.data.reason}` : ""}`;
    case "fleet.changed":
      return `v${ev.data.version} · ${ev.data.by}${ev.data.names?.length ? ` · ${ev.data.names.join(", ")}` : ""}`;
    case "agent_computer.phase":
      return `${ev.data.phase}${ev.data.error ? ` · ${ev.data.error.reason}` : ""}`;
    case "service.phase":
      return `${ev.data.phase}${ev.data.health ? ` · ${ev.data.health}` : ""}${ev.data.restarts ? ` · restarts ${ev.data.restarts}` : ""}`;
    case "inbox.changed":
      return `${ev.data.pending} pending${ev.data.claimed ? ` · ${ev.data.claimed} claimed` : ""}${ev.data.held ? ` · held${ev.data.holdReason ? ": " + ev.data.holdReason : ""}` : ""}`;
    case "session.changed":
      return `${ev.data.from ?? "–"} → ${ev.data.to}`;
    case "diagnostic":
      return short(ev.data.message, 140);
    case "permission":
      return `${ev.data.decision} ${ev.data.kind}${ev.data.tool ? " " + ev.data.tool : ""}`;
    case "lifecycle":
      return ev.data.phase;
    case "gap":
      return "events were lost; resynced";
    default:
      return short((ev as { data?: unknown }).data, 120);
  }
}

export type Tone = "ok" | "busy" | "warn" | "err" | "muted" | "info";

export function eventTone(type: string, ev?: ConsoleEvent): Tone {
  if (type === "egress.denied" || type === "resume.failed" || type === "turn.refused") return "err";
  if (type === "turn.finished") {
    const s = (ev as { data?: { status?: string } })?.data?.status;
    return s === "completed" ? "ok" : s === "interrupted" ? "warn" : "err";
  }
  if (type === "tool.finished") return (ev as { data?: { isError?: boolean } })?.data?.isError ? "err" : "muted";
  if (type.startsWith("turn.")) return "busy";
  if (type.startsWith("tool.")) return "info";
  if (type === "fleet.changed") return "info";
  if (type === "gap" || type === "diagnostic") return "warn";
  return "muted";
}

export function phaseTone(phase: string | undefined): Tone {
  switch (phase) {
    case "Ready":
    case "Running":
      return "ok";
    case "Busy":
    case "Starting":
    case "Provisioning":
      return "busy";
    case "Asleep":
    case "Stopping":
      return "muted";
    case "Error":
    case "Unhealthy":
      return "err";
    default:
      return "muted";
  }
}

/** What wakes an agent computer that is asleep, from its power status. */
export function wakeText(p: { autoWake?: string; wakeOnMessage?: string[]; reason?: string } | undefined): string {
  switch (p?.autoWake) {
    case "on":
      return `wakes on a message via ${(p.wakeOnMessage ?? []).join(", ")}`;
    case "suppressed":
      return "held asleep: stays asleep until woken";
    case "paused":
      return `auto-wake paused${p.reason ? `: ${p.reason}` : ""}`;
    default:
      return "stays asleep until woken";
  }
}

export function copy(text: string): void {
  void navigator.clipboard?.writeText(text);
}

export function cls(...xs: Array<string | false | null | undefined>): string {
  return xs.filter(Boolean).join(" ");
}
