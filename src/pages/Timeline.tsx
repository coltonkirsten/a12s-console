import { useMemo, useRef, useState } from "react";
import { useSnapshot } from "../store";
import type { ConsoleEvent } from "../types";
import { Json, navigate, useApp, useKeys } from "../ui";
import { clock, cls, eventTone, nameOf, summary } from "../util";

const groups: Record<string, (t: string) => boolean> = {
  all: () => true,
  turns: (t) => t.startsWith("turn.") || t === "text.delta",
  tools: (t) => t.startsWith("tool.") || t === "permission",
  egress: (t) => t === "egress.denied",
  fleet: (t) => t === "fleet.changed" || t.endsWith(".phase") || t === "inbox.changed" || t === "session.changed" || t === "lifecycle",
  problems: (t) => t === "egress.denied" || t === "diagnostic" || t === "resume.failed" || t === "gap" || t === "turn.refused",
};

export function Timeline() {
  const { store } = useApp();
  const snap = useSnapshot(store);
  const [group, setGroup] = useState("all");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState<ConsoleEvent[] | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  useKeys({ "/": () => filterRef.current?.focus() }, []);

  const source = paused ?? snap.events;
  const shown = useMemo(() => {
    const ql = q.toLowerCase();
    return source
      .filter((e) => groups[group]!(e.type) && (!ql || `${nameOf(e)} ${e.type} ${summary(e)}`.toLowerCase().includes(ql)))
      .slice(-800)
      .reverse();
  }, [source, group, q]);

  return (
    <div className="page" style={{ maxWidth: "none" }}>
      <div className="page-head">
        <h1>Timeline</h1>
        <span className="sub">every agent computer and the Fleet itself, on one connection · newest first</span>
      </div>
      <div className="toolbar">
        <div className="seg">
          {Object.keys(groups).map((g) => (
            <button key={g} className={cls(group === g && "on")} onClick={() => setGroup(g)}>
              {g}
            </button>
          ))}
        </div>
        <input ref={filterRef} className="input" placeholder="Filter (agent computer, type, text)   /" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <div className="grow" />
        <span className="faint">{shown.length} shown</span>
        <button className="btn" onClick={() => setPaused(paused ? null : snap.events)}>
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
      </div>
      <EventLog events={shown} empty="No events yet. They appear here as they happen; Turn history is on each agent computer's Turns tab." />
    </div>
  );
}

/** A dense, monospace event list; click a row for its JSON. */
export function EventLog({ events, empty, hideName, onPick, picked }: { events: ConsoleEvent[]; empty: string; compact?: boolean; hideName?: boolean; onPick?: (e: ConsoleEvent) => void; picked?: number }) {
  const { base } = useApp();
  const [open, setOpen] = useState<number | null>(null);
  if (!events.length) return <div className="log"><div className="log-empty">{empty}</div></div>;
  return (
    <div className="log">
      {events.map((e) => {
        const tone = eventTone(e.type, e);
        const n = nameOf(e);
        return (
          <div key={e._id}>
            <div
              className={cls("log-row", "click", hideName && "nocomp", (open === e._id || picked === e._id) && "sel")}
              onClick={() => (onPick ? onPick(e) : setOpen(open === e._id ? null : e._id))}
            >
              <span className="t">{clock(e.ts)}</span>
              {!hideName && (
                <span
                  className="c"
                  onClick={(ev) => {
                    if (n === "fleet" || e.type === "service.phase") return;
                    ev.stopPropagation();
                    navigate(`${base}/ac/${encodeURIComponent(n)}/timeline`);
                  }}
                >
                  {n}
                </span>
              )}
              <span className={cls("ty", tone)}>
                {e.type}
                {e._count && e._count > 1 ? <span className="faint"> ×{e._count}</span> : null}
              </span>
              <span className="s">{summary(e)}</span>
            </div>
            {!onPick && open === e._id && (
              <div className="log-detail">
                <Json value={stripLocal(e)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function stripLocal(e: ConsoleEvent): unknown {
  const { _id, _at, _count, ...rest } = e as ConsoleEvent & Record<string, unknown>;
  void _id;
  void _at;
  void _count;
  return rest;
}
