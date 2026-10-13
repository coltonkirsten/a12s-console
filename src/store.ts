// One store per open Fleet: its status, version, recent events and Turn history, fed by ONE fleet-wide event
// connection (fleet.events()) plus a status refresh when something changes. Components read it with useFleet().
import { useSyncExternalStore } from "react";
import { A12sError, Fleet, type A12sEvent, type ComputerStatus, type StatusResponse, type Turn } from "@coltonkirsten/a12s";
import type { ConsoleEvent } from "./types";
import { replayTurn } from "./turns";

export interface FleetInfo {
  name: string;
  url: string;
}

const maxEvents = 4000;

export interface ActiveTurn {
  id: string;
  startedAt: number;
}

export interface Snapshot {
  name: string;
  status: StatusResponse | null;
  statusError: string | null;
  /** Controller reachable, last time we asked. */
  healthy: boolean | null;
  version: number | null;
  /** Newest last. */
  events: ConsoleEvent[];
  live: boolean;
  activeTurns: Record<string, ActiveTurn>;
  /** Finished Turns we know, per agent computer, newest first. */
  turns: Record<string, Turn[]>;
  rev: number;
}

let nextId = 1;

export class FleetStore {
  readonly fleet: Fleet;
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(ev: ConsoleEvent) => void>();
  private abort = new AbortController();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private historyLoaded = new Set<string>();

  constructor(readonly info: FleetInfo) {
    this.fleet = new Fleet({ url: `${location.origin}/f/${encodeURIComponent(info.name)}` });
    this.snap = {
      name: info.name,
      status: null,
      statusError: null,
      healthy: null,
      version: null,
      events: [],
      live: false,
      activeTurns: {},
      turns: {},
      rev: 0,
    };
  }

  start(): void {
    void this.refresh();
    void this.loadVersion();
    void this.follow();
    // Belt and braces: a Controller from before inbox.changed / service.phase still shows inbox and health changes.
    this.pollTimer = setInterval(() => void this.refresh(), 5000);
  }

  stop(): void {
    this.abort.abort();
    clearInterval(this.pollTimer);
    clearTimeout(this.refreshTimer);
  }

  get snapshot(): Snapshot {
    return this.snap;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Every event as it arrives (after it is in the snapshot). */
  onEvent(fn: (ev: ConsoleEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch, rev: this.snap.rev + 1 };
    for (const l of this.listeners) l();
  }

  computer(name: string): ComputerStatus | undefined {
    return this.snap.status?.agentComputers?.find((c) => c.name === name);
  }

  async refresh(): Promise<void> {
    try {
      const status = await this.fleet.status();
      const active: Record<string, ActiveTurn> = {};
      for (const c of status.agentComputers ?? []) {
        if (c.activeTurn) active[c.name] = this.snap.activeTurns[c.name]?.id === c.activeTurn ? this.snap.activeTurns[c.name]! : { id: c.activeTurn, startedAt: Date.now() };
      }
      this.set({ status, statusError: null, healthy: true, activeTurns: active });
      const fresh = (status.agentComputers ?? []).filter((c) => !this.historyLoaded.has(c.name));
      if (fresh.length) void Promise.all(fresh.map((c) => this.loadHistory(c.name))).then(() => this.backfill(fresh.map((c) => c.name)));
    } catch (err) {
      this.set({ statusError: errText(err), healthy: false });
    }
  }

  /** Coalesces bursts of changes into one status read. */
  refreshSoon(ms = 250): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), ms);
  }

  async loadVersion(): Promise<void> {
    try {
      const f = await this.fleet.get();
      this.set({ version: f.version });
    } catch {
      // a prefix token can't read /v1/fleet; the console runs as owner, so this is only a down Controller
    }
  }

  async loadHistory(name: string, limit = 50): Promise<Turn[]> {
    this.historyLoaded.add(name);
    try {
      const ac = await this.fleet.agentComputers.get(name);
      const turns = await ac.turns({ limit });
      this.set({ turns: { ...this.snap.turns, [name]: mergeTurns(turns, this.snap.turns[name] ?? []) } });
      return turns;
    } catch {
      return [];
    }
  }

  /**
   * The live stream starts at "now", so the timeline would open empty: fill it with the events of each agent
   * computer's last few Turns from its journal, one short request at a time.
   */
  private async backfill(names: string[], perComputer = 3): Promise<void> {
    const got: A12sEvent[] = [];
    for (const name of names) {
      for (const t of (this.snap.turns[name] ?? []).slice(0, perComputer)) {
        if (this.abort.signal.aborted) return;
        try {
          got.push(...(await replayTurn(this.fleet, name, t.id, undefined, this.abort.signal)));
        } catch {
          // skip that one
        }
      }
    }
    if (!got.length) return;
    const have = new Set(this.snap.events.map((e) => `${e.agentComputer || e.computer}/${e.seq}`));
    const past: ConsoleEvent[] = [];
    for (const raw of got.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
      if (have.has(`${raw.agentComputer || raw.computer}/${raw.seq}`)) continue;
      const ev = { ...(raw as object), _id: nextId++, _at: Date.parse(raw.ts) } as ConsoleEvent;
      const prev = past[past.length - 1];
      if (ev.type === "text.delta" && prev?.type === "text.delta" && prev.turn === ev.turn) {
        past[past.length - 1] = { ...prev, data: { text: prev.data.text + ev.data.text }, _count: (prev._count ?? 1) + 1 } as ConsoleEvent;
      } else past.push(ev);
    }
    const events = [...past, ...this.snap.events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    this.set({ events });
  }

  private async follow(): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      const stream = this.fleet.events(undefined, { signal });
      try {
        void stream.ready().then(() => this.set({ live: true }));
        for await (const ev of stream) this.add(ev);
      } catch {
        // dropped: the SDK reconnects by itself while it can; past that, start over
      }
      this.set({ live: false });
      if (!signal.aborted) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private add(raw: A12sEvent): void {
    const ev = { ...(raw as object), _id: nextId++, _at: Date.now() } as ConsoleEvent;
    const name = ev.agentComputer || ev.computer || "";
    const events = this.snap.events.length >= maxEvents ? this.snap.events.slice(-maxEvents + 500) : this.snap.events.slice();
    // text.delta: fold a run of them into the previous one, so a long answer is one row
    const prev = events[events.length - 1];
    if (ev.type === "text.delta" && prev?.type === "text.delta" && (prev.agentComputer || prev.computer) === name && prev.turn === ev.turn) {
      const merged = { ...prev, data: { text: prev.data.text + ev.data.text }, _count: (prev._count ?? 1) + 1 } as ConsoleEvent;
      events[events.length - 1] = merged;
    } else {
      events.push(ev);
    }
    const patch: Partial<Snapshot> = { events };
    switch (ev.type) {
      case "turn.started":
        patch.activeTurns = { ...this.snap.activeTurns, [name]: { id: ev.turn, startedAt: Date.parse(ev.ts) || Date.now() } };
        this.refreshSoon();
        break;
      case "turn.finished": {
        const a = { ...this.snap.activeTurns };
        delete a[name];
        patch.activeTurns = a;
        this.refreshSoon();
        // the finished Turn, from history (it has text, tools and messages folded by the Controller)
        setTimeout(() => void this.loadHistory(name, 5), 300);
        break;
      }
      case "fleet.changed":
        patch.version = ev.data.version;
        this.refreshSoon();
        void this.loadVersion();
        break;
      case "gap":
        this.refreshSoon(0);
        break;
      default:
        if (ev.type === "agent_computer.phase" || ev.type === "inbox.changed" || ev.type === "service.phase" || ev.type === "session.changed") this.refreshSoon();
    }
    this.set(patch);
    for (const l of this.eventListeners) l(ev);
  }
}

function mergeTurns(a: Turn[], b: Turn[]): Turn[] {
  const seen = new Map<string, Turn>();
  for (const t of [...a, ...b]) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()].sort((x, y) => Date.parse(y.finishedAt) - Date.parse(x.finishedAt)).slice(0, 200);
}

export function errText(err: unknown): string {
  if (err instanceof A12sError) return err.message.replace(/^[a-z_]+: /, "");
  return err instanceof Error ? err.message : String(err);
}

export function useSnapshot(store: FleetStore): Snapshot {
  return useSyncExternalStore(store.subscribe, () => store.snapshot);
}
