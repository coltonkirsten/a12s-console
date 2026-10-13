import type { ComputerStatus, ServiceStatus } from "@coltonkirsten/a12s";
import { useSnapshot, errText } from "../store";
import { Empty, Link, PhaseBadge, Pill, navigate, useApp, useNow } from "../ui";
import { EventLog } from "./Timeline";
import { ago, cls, dur, phaseTone, tok, tokensToday, wakeText } from "../util";

export function Overview() {
  const { store, base } = useApp();
  const snap = useSnapshot(store);
  const now = useNow(1000);
  const s = snap.status;
  if (!s && snap.statusError) return <div className="page"><div className="banner err">Can't read the Fleet: {snap.statusError}</div></div>;
  if (!s) return <div className="page faint">Loading…</div>;
  const acs = s.agentComputers ?? [];
  const services = s.services ?? [];
  const busy = acs.filter((c) => c.phase === "Busy").length;
  const today = acs.reduce((sum, c) => sum + tokensToday(snap.turns[c.name]), 0);
  const feed = snap.events.filter((e) => e.type !== "text.delta" && e.type !== "turn.dispatched" && e.type !== "inbox.changed");

  return (
    <div className="page">
      <div className="page-head">
        <h1>Agent computers</h1>
        <span className="sub">
          {acs.length} · {busy} busy · {tok(today)} tokens today
        </span>
        <div className="grow" />
        <Link to={`${base}/editor/new`} className="btn">
          + New agent computer
        </Link>
      </div>
      {acs.length === 0 ? (
        <Empty title="No agent computers yet">
          Add one in the <Link to={`${base}/editor/new`}>fleet editor</Link>, from code (<code>fleet.agentComputers.create</code>), or in fleet.yaml and <code>a12s up</code>.
        </Empty>
      ) : (
        <div className="cards">
          {acs.map((c) => (
            <ComputerCard key={c.name} c={c} now={now} />
          ))}
        </div>
      )}

      <div className="grid2" style={{ marginTop: 6 }}>
        <div>
          <h2>
            Live activity <span className="n">{feed.length ? `latest of ${feed.length}` : ""}</span>
          </h2>
          <EventLog events={feed.slice(-14).reverse()} empty="Waiting for events. Send an agent computer a message to see its Turn here." compact />
        </div>
        <div>
          <h2>
            Services <span className="n">{services.length}</span>
            <div className="grow" />
            <Link to={`${base}/editor/new-service`} className="btn sm ghost">
              + Add
            </Link>
          </h2>
          {services.length === 0 ? (
            <Empty title="No Services">Services are containers next to your agent computers: a clock, a webhook bridge, an MCP server.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {services.map((v) => (
                  <ServiceRow key={v.name} v={v} />
                ))}
              </tbody>
            </table>
          )}
          <h2>Recent Turns</h2>
          <RecentTurns />
        </div>
      </div>
    </div>
  );
}

function ComputerCard({ c, now }: { c: ComputerStatus; now: number }) {
  const { store, base, toast } = useApp();
  const snap = useSnapshot(store);
  const active = snap.activeTurns[c.name];
  const last = snap.turns[c.name]?.[0];
  const pending = c.inbox?.pending ?? 0;
  const held = c.inbox?.held;
  const tone = phaseTone(c.phase);
  const href = `${base}/ac/${encodeURIComponent(c.name)}`;
  const missingCred = (c.warnings ?? []).find((w) => /credential/i.test(w));

  const wake = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await (await store.fleet.agentComputers.get(c.name)).wake();
      toast(`Waking ${c.name}`);
      store.refreshSoon(0);
    } catch (err) {
      toast(errText(err), "err");
    }
  };

  let line: React.ReactNode;
  if (c.phase === "Busy" && (active || c.activeTurn)) {
    line = (
      <span className="busy-t mono">
        turn {(active?.id ?? c.activeTurn ?? "").slice(0, 10)} · {active ? dur(now - active.startedAt) : "running"}
      </span>
    );
  } else if (c.phase === "Asleep") {
    line = <span className="muted">{wakeText(c.power)}</span>;
  } else if (last) {
    line = (
      <span className="muted">
        last turn {ago(last.finishedAt, now)} ·{" "}
        <span className={last.status === "completed" ? "ok-t" : last.status === "failed" ? "err-t" : "warn-t"}>{last.status}</span>
      </span>
    );
  } else {
    line = <span className="faint">no Turns yet</span>;
  }

  return (
    <a
      href={href}
      className={cls("card", tone === "err" && "err", tone === "busy" && c.phase === "Busy" && "busy")}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      <div className="card-title">
        <span className="grow ellipsis">{c.name}</span>
        <PhaseBadge phase={c.phase} />
      </div>
      <div style={{ fontSize: 12.5 }}>{line}</div>
      <div className="card-meta">
        <div className="kv">
          <span className="k">inbox</span>
          <span className={cls("v", held ? "warn-t" : pending ? "" : "faint")}>{held ? `held · ${pending}` : pending ? `${pending} pending` : "empty"}</span>
        </div>
        <div className="kv">
          <span className="k">tokens today</span>
          <span className="v">{tok(tokensToday(snap.turns[c.name]))}</span>
        </div>
        <div className="kv">
          <span className="k">model</span>
          <span className="v mono" style={{ fontSize: 11.5 }}>{c.harness?.model ?? c.harness?.kind ?? "–"}</span>
        </div>
      </div>
      {c.error && <div className="errline">{c.error.reason}</div>}
      {missingCred && <div className="warnline">⚠ {missingCred}</div>}
      <div className="card-foot">
        <span className="mono ellipsis grow">
          {c.harness?.kind} {c.harness?.version} · {c.image?.replace(/^ghcr\.io\/coltonkirsten\/a12s\//, "")}
        </span>
        {c.phase === "Asleep" && (
          <button className="btn sm" onClick={wake}>
            Wake
          </button>
        )}
        {missingCred && (
          <button
            className="btn sm"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              navigate(`${base}/credentials`);
            }}
          >
            Set credential
          </button>
        )}
      </div>
    </a>
  );
}

function ServiceRow({ v }: { v: ServiceStatus }) {
  const { base } = useApp();
  return (
    <tr className="click" onClick={() => navigate(`${base}/editor/svc/${encodeURIComponent(v.name)}`)}>
      <td style={{ fontWeight: 600 }}>{v.name}</td>
      <td>
        <PhaseBadge phase={v.phase === "Ready" ? "Running" : v.phase} />
        {v.health && v.health !== "ok" && v.health !== "healthy" && (
          <Pill tone="warn">{v.health}</Pill>
        )}
      </td>
      <td className="mono faint ellipsis" style={{ maxWidth: 220 }} title={v.pin ?? v.image}>
        {v.image}
      </td>
      <td className="faint">{v.usedBy?.length ? `used by ${v.usedBy.join(", ")}` : ""}</td>
      <td className="num faint">restarts {v.restarts}</td>
    </tr>
  );
}

function RecentTurns() {
  const { store, base } = useApp();
  const snap = useSnapshot(store);
  const now = useNow(5000);
  const all = Object.values(snap.turns)
    .flat()
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
    .slice(0, 6);
  if (!all.length) return <div className="faint" style={{ fontSize: 12.5 }}>No finished Turns yet.</div>;
  return (
    <table className="table">
      <tbody>
        {all.map((t) => (
          <tr key={t.id} className="click" onClick={() => navigate(`${base}/ac/${encodeURIComponent(t.agentComputer)}/turns/${t.id}`)}>
            <td style={{ fontWeight: 600 }}>{t.agentComputer}</td>
            <td>
              <span className={t.status === "completed" ? "ok-t" : t.status === "failed" ? "err-t" : "warn-t"}>{t.status}</span>
            </td>
            <td className="num faint">{t.startedAt ? dur(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : "–"}</td>
            <td className="num faint">{t.tokens ? `${tok(t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite)} tok` : ""}</td>
            <td className="num faint">{ago(t.finishedAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
