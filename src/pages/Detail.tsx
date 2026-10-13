import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { A12sEvent, AgentComputerData, Message, Turn } from "@coltonkirsten/a12s";
import { errText, useSnapshot } from "../store";
import type { ConsoleEvent } from "../types";
import { Empty, Json, Link, Output, PhaseBadge, Pill, Spinner, navigate, useApp, useKeys, useNow } from "../ui";
import { EventLog } from "./Timeline";
import { PendingList } from "./Inboxes";
import { emptyTurn, foldEvent, fromSummary, replayTurn, timing, type ChatItem, type ChatTurn } from "../turns";
import { ago, clock, cls, copy, dateTime, dur, num, tok, toolArg, totalTokens, wakeText } from "../util";

const tabs = ["chat", "timeline", "inbox", "turns", "config"] as const;

export function Detail({ name, tab, turn }: { name: string; tab: string; turn?: string }) {
  const { store, base, toast } = useApp();
  const snap = useSnapshot(store);
  const c = snap.status?.agentComputers?.find((x) => x.name === name);
  const here = `${base}/ac/${encodeURIComponent(name)}`;
  const [fresh, setFresh] = useState(false);
  useKeys(
    Object.fromEntries([
      ...tabs.map((t, i) => [String(i + 1), () => navigate(`${here}/${t}`)]),
      ["Escape", () => turn && navigate(`${here}/${tab}`)],
    ]),
    [here, tab, turn],
  );

  if (!snap.status) return <div className="page faint">Loading…</div>;
  if (!c)
    return (
      <div className="page">
        <Empty title={`No agent computer named ${name}`}>
          It may have been removed. <Link to={base}>Back to the overview</Link>
        </Empty>
      </div>
    );

  const power = async (what: "sleep" | "wake" | "stop") => {
    try {
      const ac = await store.fleet.agentComputers.get(name);
      if (what === "stop") await ac.stop();
      else if (what === "sleep") await ac.sleep();
      else await ac.wake();
      toast(what === "stop" ? `Stopped ${name}'s Turn` : what === "sleep" ? `${name} is going to sleep` : `Waking ${name}`);
      store.refreshSoon(0);
    } catch (err) {
      toast(errText(err), "err");
    }
  };

  const egress = c.egressMode ? c.egressMode : "";
  return (
    <div className="page full">
      <div className="detail-head">
        <div className="crumbs">
          <Link to={base}>Overview</Link> / {name}
        </div>
        <div className="detail-title">
          <h1>{name}</h1>
          <PhaseBadge phase={c.phase} />
          {c.inbox?.held && <Pill tone="warn">inbox held</Pill>}
          <div className="grow" />
          {c.phase === "Busy" && (
            <button className="btn" onClick={() => power("stop")}>
              ■ Stop turn
            </button>
          )}
          {c.phase === "Asleep" ? (
            <button className="btn" onClick={() => power("wake")}>
              Wake
            </button>
          ) : (
            <button className="btn" onClick={() => power("sleep")} disabled={c.phase === "Error" || c.phase === "Provisioning"}>
              Sleep
            </button>
          )}
          <button
            className={cls("btn", fresh && "primary")}
            title="Your next message starts a new session"
            onClick={() => {
              setFresh(!fresh);
              navigate(`${here}/chat`);
            }}
          >
            New session
          </button>
          <Link to={`${base}/editor/ac/${encodeURIComponent(name)}`} className="btn">
            Edit
          </Link>
        </div>
        <div className="detail-meta">
          <span className="mono">
            {c.harness?.kind} {c.harness?.version}
          </span>
          <span className="sep">·</span>
          <span className="mono">{c.harness?.model ?? "default model"}</span>
          <span className="sep">·</span>
          <span>
            session <span className="mono">{c.session ? c.session.slice(0, 8) : "–"}</span>
          </span>
          <span className="sep">·</span>
          <span className="mono">{c.image?.replace(/^ghcr\.io\/coltonkirsten\/a12s\//, "")}</span>
          <span className="sep">·</span>
          <span>egress {egress || "–"}</span>
          {c.seccomp && (
            <>
              <span className="sep">·</span>
              <span>seccomp {c.seccomp}</span>
            </>
          )}
          {c.error && (
            <>
              <span className="sep">·</span>
              <span className="err-t">{c.error.reason}</span>
            </>
          )}
          {c.waiting && (
            <>
              <span className="sep">·</span>
              <span className="warn-t">waiting for {c.waiting.credentials.join(", ")}: {c.waiting.fix}</span>
            </>
          )}
        </div>
        <div className="tabs" role="tablist">
          {tabs.map((t, i) => (
            <button key={t} role="tab" className={cls(tab === t && "on")} onClick={() => navigate(`${here}/${t}`)} title={`${i + 1}`}>
              {t === "inbox" ? `Inbox${c.inbox?.pending ? ` (${c.inbox.pending})` : ""}` : t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className={cls("split", !turn && "nopanel")}>
        <div className="left">
          {tab === "chat" && <Chat name={name} here={here} fresh={fresh} setFresh={setFresh} selected={turn} />}
          {tab === "timeline" && <AcTimeline name={name} />}
          {tab === "inbox" && <InboxTab name={name} />}
          {tab === "turns" && <TurnsTab name={name} here={here} selected={turn} />}
          {tab === "config" && <ConfigTab name={name} />}
        </div>
        {turn && <TurnPanel name={name} id={turn} onClose={() => navigate(`${here}/${tab}`)} />}
      </div>
    </div>
  );
}

// ---- chat ----------------------------------------------------------------------------------------------------------

function Chat({ name, here, fresh, setFresh, selected }: { name: string; here: string; fresh: boolean; setFresh: (v: boolean) => void; selected?: string }) {
  const { store, toast } = useApp();
  const snap = useSnapshot(store);
  const [turns, setTurns] = useState<Map<string, ChatTurn>>(new Map());
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [queued, setQueued] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const history = snap.turns[name];
  const c = snap.status?.agentComputers?.find((x) => x.name === name);
  useKeys({ "/": () => box.current?.focus(), c: () => box.current?.focus() }, []);

  // history: summaries at once, then the last few replayed from their events for the exact order
  useEffect(() => {
    if (!history) return;
    setTurns((prev) => {
      const next = new Map(prev);
      for (const t of [...history].reverse().slice(-30)) if (!next.has(t.id)) next.set(t.id, fromSummary(t));
      return sortTurns(next);
    });
  }, [history]);

  const replayed = useRef(new Set<string>());
  useEffect(() => {
    if (!history?.length) return;
    const ac = new AbortController();
    void (async () => {
      for (const t of history.slice(0, 8)) {
        if (ac.signal.aborted) return;
        if (replayed.current.has(t.id)) continue;
        replayed.current.add(t.id);
        try {
          const evs = await replayTurn(store.fleet, name, t.id, undefined, ac.signal);
          if (!evs.some((e) => e.type === "turn.finished")) continue;
          const ct = evs.reduce((acc, e) => foldEvent(acc, e), emptyTurn(t.id));
          ct.exact = true;
          setTurns((prev) => {
            const cur = prev.get(t.id);
            if (cur?.exact) return prev;
            const next = new Map(prev);
            ct.messages = ct.messages.length ? ct.messages : (cur?.messages ?? []);
            next.set(t.id, ct);
            return sortTurns(next);
          });
        } catch {
          // keep the summary
        }
      }
    })();
    return () => ac.abort();
  }, [history?.[0]?.id, name, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // live: fold this agent computer's events as they arrive
  useEffect(() => {
    return store.onEvent((ev: ConsoleEvent) => {
      if (ev.agentComputer !== name || !ev.turn) return;
      if (!["turn.started", "text.delta", "tool.started", "tool.finished", "egress.denied", "turn.finished"].includes(ev.type)) return;
      setTurns((prev) => {
        const next = new Map(prev);
        const cur = next.get(ev.turn);
        const t = cur ? structuredClone(cur) : emptyTurn(ev.turn);
        if (cur && !cur.exact && ev.type !== "turn.finished") return prev; // a summary we can't extend in order
        foldEvent(t, ev as A12sEvent);
        next.set(ev.turn, t);
        return sortTurns(next);
      });
      if (ev.type === "turn.started" || ev.type === "turn.finished") void loadQueued();
    });
  }, [name, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // message bodies: what you (and others) sent
  const ids = useMemo(() => [...turns.values()].flatMap((t) => t.messages.map((m) => m.id)), [turns]);
  useEffect(() => {
    const missing = ids.filter((id) => !bodies.has(id));
    if (!missing.length) return;
    let live = true;
    void (async () => {
      const got = new Map<string, string>();
      try {
        const all = await store.fleet.client.request<{ messages: Message[] }>("GET", `/v1/agent-computers/${encodeURIComponent(name)}/inbox?state=all&bodies=true`);
        for (const m of all.messages) if (m.body !== undefined) got.set(m.id, m.body);
      } catch {
        // fall through to one by one
      }
      for (const id of missing.filter((x) => !got.has(x)).slice(0, 10)) {
        try {
          const m = await store.fleet.client.request<Message>("GET", `/v1/agent-computers/${encodeURIComponent(name)}/inbox/${encodeURIComponent(id)}`);
          got.set(id, m.body ?? "");
        } catch {
          got.set(id, "");
        }
      }
      if (live) setBodies((b) => new Map([...b, ...got]));
    })();
    return () => {
      live = false;
    };
  }, [ids.join(","), name, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadQueued = async () => {
    try {
      const r = await store.fleet.client.request<{ messages: Message[] }>("GET", `/v1/agent-computers/${encodeURIComponent(name)}/inbox?bodies=true`);
      setQueued(r.messages);
    } catch {
      // keep what we have
    }
  };
  useEffect(() => {
    void loadQueued();
  }, [name, c?.inbox?.pending, c?.inbox?.claimed]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the view at the bottom while new things arrive, unless you scrolled up
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const ac = await store.fleet.agentComputers.get(name);
      const m = await ac.send(body, { sender: "console", ...(fresh ? { fresh: true } : {}) });
      setText("");
      setFresh(false);
      stick.current = true;
      setBodies((b) => new Map(b).set(m.id, body));
      void loadQueued();
      if (c?.phase === "Asleep") toast(`${name} is asleep: the Message waits (${wakeText(c.power)})`);
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") box.current?.blur();
  };

  const list = [...turns.values()];
  const inTurn = new Set(list.flatMap((t) => t.messages.map((m) => m.id)));
  const waiting = queued.filter((m) => !inTurn.has(m.id));
  let lastDay = "";

  return (
    <>
      <div
        className="chat"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="chat-inner">
          {!list.length && !waiting.length && (
            <Empty title={`Say something to ${name}`}>
              Messages go to its inbox and are delivered at its next idle moment. Tool calls show up inline as they run.
            </Empty>
          )}
          {list.map((t) => {
            const day = t.startedAt ? new Date(t.startedAt).toDateString() : "";
            const showDay = day && day !== lastDay;
            lastDay = day || lastDay;
            return (
              <div key={t.id} style={{ display: "contents" }}>
                {showDay && <div className="day">{new Date(t.startedAt!).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}</div>}
                {t.messages.map((m) => (
                  <Bubble key={m.id} who={m.via === "local" ? "you" : m.sender} via={m.via} at={m.createdAt} body={bodies.get(m.id)} you={m.via === "local"} />
                ))}
                <AgentTurn t={t} name={name} selected={selected === t.id} onDetails={() => navigate(`${here}/chat/${t.id}`)} />
              </div>
            );
          })}
          {waiting.map((m) => (
            <Bubble key={m.id} who={m.via === "local" ? "you" : m.sender} via={m.via} at={m.createdAt} body={m.body} you={m.via === "local"} queued={m.state} />
          ))}
        </div>
      </div>
      <div className="composer">
        <div className="composer-inner">
          <div className="composer-box">
            <textarea
              ref={box}
              rows={Math.min(8, Math.max(1, text.split("\n").length))}
              placeholder={`Message ${name}…`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              aria-label={`Message ${name}`}
            />
            <button className="btn primary" disabled={!text.trim() || sending} onClick={() => void send()}>
              {sending ? <Spinner /> : "Send"}
            </button>
          </div>
          <div className="hint">
            <span>
              sender <span className="mono">console</span> · via <span className="mono">local</span>
            </span>
            <label>
              <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} /> new session
            </label>
            {c?.phase === "Busy" && <span className="busy-t">busy: your message is delivered when this Turn ends</span>}
            {c?.phase === "Asleep" && <span className="warn-t">asleep: {c.power?.autoWake === "on" ? wakeText(c.power) : "wake it to deliver"}</span>}
            <span className="grow" />
            <span>
              <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function sortTurns(m: Map<string, ChatTurn>): Map<string, ChatTurn> {
  const key = (t: ChatTurn) => Date.parse(t.startedAt ?? t.finishedAt ?? "") || Number.MAX_SAFE_INTEGER;
  return new Map([...m.entries()].sort((a, b) => key(a[1]) - key(b[1])));
}

function Bubble({ who, via, at, body, you, queued }: { who: string; via: string; at: string; body?: string; you: boolean; queued?: string }) {
  return (
    <div className={cls("msg", "you", !you && "other")}>
      <div className="bubble">{body === undefined ? <span className="faint">…</span> : body || <span className="faint">(empty)</span>}</div>
      <div className="who">
        {you ? "you" : who} · <span className="mono">{via}</span> · {clock(at)}
        {queued && <span className={queued === "claimed" ? "busy-t" : "warn-t"}> · {queued === "claimed" ? "delivering" : "queued"}</span>}
      </div>
    </div>
  );
}

function AgentTurn({ t, name, selected, onDetails }: { t: ChatTurn; name: string; selected: boolean; onDetails: () => void }) {
  const now = useNow(t.status ? 60_000 : 500);
  const streaming = !t.status;
  const tools = t.items.filter((x) => x.kind === "tool").length;
  const denials = t.items.filter((x) => x.kind === "denied").length;
  const lastText = t.items.map((x, i) => (x.kind === "text" ? i : -1)).filter((i) => i >= 0).pop();
  const ms = t.startedAt ? (t.finishedAt ? Date.parse(t.finishedAt) : now) - Date.parse(t.startedAt) : undefined;
  return (
    <div className="agent" style={selected ? { outline: "1px solid var(--accent)", outlineOffset: 6, borderRadius: 4 } : undefined}>
      {t.items.map((x, i) => (
        <Item key={i} x={x} streaming={streaming && i === lastText && i === t.items.length - 1} />
      ))}
      {streaming && !t.items.length && (
        <div className="row faint">
          <Spinner /> {name} is working…
        </div>
      )}
      {t.error && <div className="banner err">{t.error}</div>}
      <div className="turn-foot">
        <span className="mono">turn {t.id.slice(0, 12)}</span>
        <span>·</span>
        {t.status ? (
          <span className={t.status === "completed" ? "ok-t" : t.status === "failed" ? "err-t" : "warn-t"}>{t.status}</span>
        ) : (
          <span className="busy-t">{name} · streaming…</span>
        )}
        {ms !== undefined && <span>· {dur(ms)}</span>}
        {t.tokens && (
          <span>
            · in {tok(t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite)} / out {tok(t.tokens.output)}
          </span>
        )}
        {tools > 0 && <span>· {tools} tool{tools > 1 ? "s" : ""}</span>}
        {denials > 0 && <span className="err-t">· {denials} egress denial{denials > 1 ? "s" : ""}</span>}
        <button onClick={onDetails}>details →</button>
      </div>
    </div>
  );
}

function Item({ x, streaming }: { x: ChatItem; streaming: boolean }) {
  if (x.kind === "text") return <div className={cls("text", streaming && "streaming")}>{x.text.trim()}</div>;
  if (x.kind === "denied")
    return (
      <div className="tool denied">
        <div style={{ display: "flex", gap: 8, padding: "5px 9px", alignItems: "center" }}>
          <span className="err-t">✕</span>
          <span className="name mono" style={{ fontWeight: 600 }}>egress</span>
          <span className="mono muted ellipsis grow">
            {x.host}:{x.port}
          </span>
          <span className="err-t" style={{ fontSize: 11.5 }}>denied</span>
        </div>
      </div>
    );
  const ms = x.startedAt && x.finishedAt ? x.finishedAt - x.startedAt : undefined;
  return (
    <details className={cls("tool", x.isError && "denied")}>
      <summary>
        <span className="caret">▶</span>
        <span className="name">{x.name.replace(/^mcp__a12s__/, "a12s.")}</span>
        <span className="arg">{toolArg(x.input)}</span>
        {!x.done ? <Spinner /> : x.isError ? <span className="err-t">✕ error</span> : <span className="ok-t">✓</span>}
        {ms !== undefined && <span className="faint">{dur(ms)}</span>}
      </summary>
      <div className="body">
        <span className="lbl">input</span>
        <Json value={x.input ?? null} />
        {x.done && (
          <>
            <span className="lbl">output</span>
            <Output value={x.output ?? null} />
          </>
        )}
      </div>
    </details>
  );
}

// ---- timeline ------------------------------------------------------------------------------------------------------

function AcTimeline({ name }: { name: string }) {
  const { store } = useApp();
  const snap = useSnapshot(store);
  const [past, setPast] = useState<ConsoleEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const history = snap.turns[name];
  useEffect(() => {
    if (!history?.length) return;
    const ac = new AbortController();
    setLoading(true);
    void (async () => {
      const out: ConsoleEvent[] = [];
      let id = -1;
      for (const t of history.slice(0, 5).reverse()) {
        try {
          const evs = await replayTurn(store.fleet, name, t.id, undefined, ac.signal);
          for (const e of evs) out.push({ ...(e as object), _id: id--, _at: Date.parse(e.ts) } as ConsoleEvent);
        } catch {
          // skip it
        }
      }
      if (!ac.signal.aborted) {
        setPast(foldDeltas(out));
        setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [history?.[0]?.id, name, store]); // eslint-disable-line react-hooks/exhaustive-deps
  const liveEvents = snap.events.filter((e) => e.agentComputer === name);
  const seen = new Set(liveEvents.map((e) => `${e.seq}/${e.type}`));
  const merged = [...past.filter((e) => !seen.has(`${e.seq}/${e.type}`) || e.seq === 0), ...liveEvents].reverse();
  return (
    <div style={{ padding: "14px 20px" }}>
      <div className="toolbar">
        <span className="faint">
          its last {Math.min(5, history?.length ?? 0)} Turns from the journal, then live · newest first
        </span>
        {loading && <Spinner />}
      </div>
      <EventLog events={merged} hideName empty="No events yet." />
    </div>
  );
}

function foldDeltas(evs: ConsoleEvent[]): ConsoleEvent[] {
  const out: ConsoleEvent[] = [];
  for (const e of evs) {
    const prev = out[out.length - 1];
    if (e.type === "text.delta" && prev?.type === "text.delta" && prev.turn === e.turn) {
      out[out.length - 1] = { ...prev, data: { text: prev.data.text + e.data.text }, _count: (prev._count ?? 1) + 1 } as ConsoleEvent;
    } else out.push(e);
  }
  return out;
}

// ---- inbox tab -----------------------------------------------------------------------------------------------------

function InboxTab({ name }: { name: string }) {
  const { store } = useApp();
  const snap = useSnapshot(store);
  const c = snap.status?.agentComputers?.find((x) => x.name === name);
  const i = c?.inbox;
  return (
    <div style={{ padding: "14px 20px" }}>
      <div className="row" style={{ marginBottom: 10, gap: 14 }}>
        <span>
          <b>{i?.pending ?? 0}</b> <span className="muted">pending</span>
        </span>
        <span>
          <b>{i?.claimed ?? 0}</b> <span className="muted">being delivered</span>
        </span>
        <span className="muted">
          limit {i?.limits.maxMessages.value ?? "–"} messages · {i ? Math.round(i.limits.maxBytes.value / 1024) : "–"} KB
        </span>
        {i?.held && <Pill tone="warn">held{i.holdReason ? `: ${i.holdReason}` : ""}</Pill>}
        {i?.diagnostic && <span className="warn-t">{i.diagnostic}</span>}
        <div className="grow" />
        <Link to={`/${encodeURIComponent(store.info.name)}/inboxes`} className="btn sm ghost">
          All inboxes →
        </Link>
      </div>
      <div className="table" style={{ display: "block" }}>
        <PendingList name={name} rev={snap.rev} />
      </div>
    </div>
  );
}

// ---- turns tab -----------------------------------------------------------------------------------------------------

function TurnsTab({ name, here, selected }: { name: string; here: string; selected?: string }) {
  const { store } = useApp();
  const snap = useSnapshot(store);
  const turns = snap.turns[name];
  const active = snap.activeTurns[name];
  const now = useNow(1000);
  useEffect(() => {
    void store.loadHistory(name, 100);
  }, [name, store]);
  if (!turns) return <div style={{ padding: 20 }} className="faint">Loading…</div>;
  return (
    <div style={{ padding: "14px 20px" }}>
      {active && (
        <div className="banner info" style={{ marginBottom: 10, cursor: "pointer" }} onClick={() => navigate(`${here}/turns/${active.id}`)}>
          <Spinner /> Turn <span className="mono">{active.id}</span> running for {dur(now - active.startedAt)}
        </div>
      )}
      {!turns.length ? (
        <Empty title="No finished Turns">The Controller keeps the last 200 per agent computer.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Turn</th>
              <th>Status</th>
              <th>Started</th>
              <th className="num">Duration</th>
              <th className="num">In</th>
              <th className="num">Out</th>
              <th className="num">Cache read</th>
              <th className="num">Tools</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t) => (
              <tr key={t.id} className={cls("click", selected === t.id && "sel")} onClick={() => navigate(`${here}/turns/${t.id}`)}>
                <td className="mono">{t.id.slice(0, 14)}</td>
                <td>
                  <span className={t.status === "completed" ? "ok-t" : t.status === "failed" ? "err-t" : "warn-t"}>{t.status}</span>
                  {t.error && <span className="faint ellipsis" style={{ maxWidth: 200, display: "inline-block", verticalAlign: "bottom", marginLeft: 6 }}>{t.error}</span>}
                </td>
                <td className="faint" title={t.startedAt}>
                  {dateTime(t.startedAt ?? t.finishedAt)}
                </td>
                <td className="num">{t.startedAt ? dur(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : "–"}</td>
                <td className="num">{tok(t.tokens?.input)}</td>
                <td className="num">{tok(t.tokens?.output)}</td>
                <td className="num faint">{tok(t.tokens?.cacheRead)}</td>
                <td className="num">{t.tools.length || <span className="faint">0</span>}</td>
                <td className="faint">{[...new Set(t.messages.map((m) => m.via))].join(", ") || "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- config tab ----------------------------------------------------------------------------------------------------

function ConfigTab({ name }: { name: string }) {
  const { store, base } = useApp();
  const snap = useSnapshot(store);
  const [data, setData] = useState<AgentComputerData | null>(null);
  const [view, setView] = useState<"spec" | "effective" | "status">("effective");
  useEffect(() => {
    store.fleet.client
      .request<AgentComputerData>("GET", `/v1/agent-computers/${encodeURIComponent(name)}`)
      .then(setData)
      .catch(() => {});
  }, [name, store, snap.version]);
  if (!data) return <div style={{ padding: 20 }} className="faint">Loading…</div>;
  const value = view === "spec" ? data.spec : view === "effective" ? data.effective : data.status;
  return (
    <div style={{ padding: "14px 20px" }}>
      <div className="toolbar">
        <div className="seg">
          {(["effective", "spec", "status"] as const).map((v) => (
            <button key={v} className={cls(view === v && "on")} onClick={() => setView(v)}>
              {v === "spec" ? "as written" : v === "effective" ? "with defaults" : "status"}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button className="btn" onClick={() => copy(JSON.stringify(value, null, 2))}>
          Copy JSON
        </button>
        <Link to={`${base}/editor/ac/${encodeURIComponent(name)}`} className="btn primary">
          Edit in fleet editor
        </Link>
      </div>
      <Json value={value} />
    </div>
  );
}

// ---- turn panel ----------------------------------------------------------------------------------------------------

function TurnPanel({ name, id, onClose }: { name: string; id: string; onClose: () => void }) {
  const { store } = useApp();
  const snap = useSnapshot(store);
  const [events, setEvents] = useState<A12sEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [raw, setRaw] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const summary: Turn | undefined = snap.turns[name]?.find((t) => t.id === id);
  const live = snap.activeTurns[name]?.id === id;

  useEffect(() => {
    const ac = new AbortController();
    setEvents([]);
    setLoading(true);
    const got: A12sEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      setEvents([...got]);
    };
    replayTurn(store.fleet, name, id, (e) => {
      got.push(e);
      timer ??= setTimeout(flush, 100);
    }, ac.signal)
      .then(() => !ac.signal.aborted && (setEvents([...got]), setLoading(false)))
      .catch(() => !ac.signal.aborted && setLoading(false));
    return () => {
      ac.abort();
      clearTimeout(timer);
    };
  }, [name, id, store, summary?.finishedAt]);

  const ct = useMemo(() => events.reduce((acc, e) => foldEvent(acc, e), emptyTurn(id)), [events, id]);
  const started = events.find((e) => e.type === "turn.started");
  const startedData = started?.type === "turn.started" ? started.data : undefined;
  const firstMsg = startedData?.inbox?.messages?.[0]?.createdAt ?? summary?.messages?.[0]?.createdAt;
  const tm = timing(events, firstMsg);
  const tokens = ct.tokens ?? summary?.tokens;
  const status = ct.status ?? summary?.status;
  const denials = ct.items.filter((x): x is Extract<ChatItem, { kind: "denied" }> => x.kind === "denied");
  const tools = ct.items.filter((x): x is Extract<ChatItem, { kind: "tool" }> => x.kind === "tool");
  const startedAt = ct.startedAt ?? summary?.startedAt;
  const finishedAt = ct.finishedAt ?? summary?.finishedAt;
  const consoleEvents = useMemo(() => events.map((e, i) => ({ ...(e as object), _id: i + 1, _at: 0 }) as ConsoleEvent), [events]);
  const folded = useMemo(() => foldDeltas(consoleEvents), [consoleEvents]);
  const curl = `curl -N -H "Authorization: Bearer $A12S_TOKEN" "$A12S_URL/v1/agent-computers/${name}/events?turn=${id}"`;
  const pickedEv = consoleEvents.find((e) => e._id === picked);
  const seg = (ms: number, color: string) => (tm && tm.total + tm.queue > 0 ? <span style={{ width: `${(100 * ms) / (tm.total + tm.queue)}%`, background: color }} /> : null);

  return (
    <aside className="side" aria-label={`Turn ${id}`}>
      <div className="side-head">
        <b>Turn</b>
        <span className="mono muted ellipsis grow">{id}</span>
        <button className="btn sm ghost" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>
      <div className="side-body">
        <dl className="dl">
          <dt>status</dt>
          <dd>
            {live ? (
              <span className="busy-t">running</span>
            ) : (
              <span className={status === "completed" ? "ok-t" : status === "failed" ? "err-t" : "warn-t"}>{status ?? (loading ? "…" : "unknown")}</span>
            )}
          </dd>
          <dt>started</dt>
          <dd>{startedAt ? `${clock(startedAt)} · ${ago(startedAt)}` : "–"}</dd>
          <dt>duration</dt>
          <dd>{startedAt && finishedAt ? dur(Date.parse(finishedAt) - Date.parse(startedAt)) : live ? "running" : "–"}</dd>
          <dt>tokens in</dt>
          <dd>
            {num(tokens?.input)} <span className="faint">uncached</span>
          </dd>
          <dt>tokens out</dt>
          <dd>{num(tokens?.output)}</dd>
          <dt>cache read</dt>
          <dd>{num(tokens?.cacheRead)}</dd>
          <dt>cache write</dt>
          <dd>{num(tokens?.cacheWrite)}</dd>
          <dt>total</dt>
          <dd>{tokens ? num(totalTokens({ tokens })) : "–"}</dd>
          <dt>model</dt>
          <dd className="mono">{startedData?.model ?? startedData?.harness?.model ?? "–"}</dd>
          <dt>messages</dt>
          <dd>
            {(startedData?.inbox?.messages ?? summary?.messages ?? []).length}{" "}
            <span className="faint">({[...new Set((startedData?.inbox?.messages ?? summary?.messages ?? []).map((m) => m.via))].join(", ") || "continuation"})</span>
          </dd>
          <dt>session</dt>
          <dd className="mono">{(started?.session || summary?.session || "–").slice(0, 18)}</dd>
        </dl>

        {tm && (
          <>
            <h3>Timing</h3>
            <div className="timing">
              {seg(tm.queue, "var(--faint)")}
              {seg(tm.think, "var(--info)")}
              {seg(tm.tools, "var(--warn)")}
              {seg(tm.answer, "var(--ok)")}
            </div>
            <div className="legend">
              <span><i style={{ background: "var(--faint)" }} />queue {dur(tm.queue)}</span>
              <span><i style={{ background: "var(--info)" }} />think {dur(tm.think)}</span>
              <span><i style={{ background: "var(--warn)" }} />tools {dur(tm.tools)}</span>
              <span><i style={{ background: "var(--ok)" }} />answer {dur(tm.answer)}</span>
            </div>
          </>
        )}

        {(ct.error ?? summary?.error) && (
          <>
            <h3>Error</h3>
            <div className="banner err">{ct.error ?? summary?.error}</div>
          </>
        )}

        {denials.length > 0 && (
          <>
            <h3>Egress denials ({denials.length})</h3>
            {denials.map((d, i) => (
              <div key={i} className="mono err-t" style={{ fontSize: 12 }}>
                ✕ {d.host}:{d.port} <span className="faint">{d.reason}</span>
              </div>
            ))}
          </>
        )}

        {tools.length > 0 && (
          <>
            <h3>Tools ({tools.length})</h3>
            {tools.map((t) => (
              <div key={t.id} className="row mono" style={{ fontSize: 12, padding: "2px 0" }}>
                <span className={t.isError ? "err-t" : "ok-t"}>{t.isError ? "✕" : "✓"}</span>
                <b>{t.name}</b>
                <span className="faint ellipsis grow">{toolArg(t.input)}</span>
                <span className="faint">{t.startedAt && t.finishedAt ? dur(t.finishedAt - t.startedAt) : ""}</span>
              </div>
            ))}
          </>
        )}

        <h3 className="row">
          Events ({events.length}) {loading && <Spinner />}
        </h3>
        <EventLog events={folded} hideName empty={loading ? "Loading…" : "No events in the journal for this Turn."} onPick={(e) => setPicked(picked === e._id ? null : e._id)} picked={picked ?? undefined} />
        {pickedEv && (
          <div style={{ marginTop: 8 }}>
            <Json value={(({ _id, _at, _count, ...rest }) => (void _id, void _at, void _count, rest))(pickedEv as ConsoleEvent & { _count?: number })} />
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={() => setRaw(!raw)}>
            {raw ? "Hide" : "Raw JSON"}
          </button>
          <button className="btn sm" onClick={() => copy(curl)} title={curl}>
            Copy as curl
          </button>
        </div>
        {raw && (
          <div style={{ marginTop: 8 }}>
            <Json value={summary ?? events} />
          </div>
        )}
      </div>
    </aside>
  );
}
