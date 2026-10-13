import { Fragment, useEffect, useState } from "react";
import type { ComputerStatus, Message } from "@coltonkirsten/a12s";
import { errText, useSnapshot } from "../store";
import { Empty, Link, Pill, useApp, useNow } from "../ui";
import { ago, bytes, cls, dur, short } from "../util";

export function Inboxes() {
  const { store } = useApp();
  const snap = useSnapshot(store);
  const [open, setOpen] = useState<string | null>(null);
  const acs = snap.status?.agentComputers ?? [];
  const orphaned = snap.status?.orphanedInboxes ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <h1>Inboxes</h1>
        <span className="sub">every queue in one place · Messages wait here until the agent computer's next idle moment</span>
      </div>
      {acs.length === 0 ? (
        <Empty title="No agent computers" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Agent computer</th>
              <th className="num">Pending</th>
              <th>Oldest</th>
              <th>Usage</th>
              <th>State</th>
              <th className="num">Ended 24h</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {acs.map((c) => (
              <Fragment key={c.name}>
                <InboxRow c={c} open={open === c.name} toggle={() => setOpen(open === c.name ? null : c.name)} />
                {open === c.name && (
                  <tr className="sub">
                    <td colSpan={7} style={{ padding: 0 }}>
                      <PendingList name={c.name} rev={snap.rev} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {orphaned.length > 0 && (
        <>
          <h2>Orphaned inboxes</h2>
          <div className="banner warn">
            {orphaned.map((o) => `${o.computer} (${o.pending} pending)`).join(", ")}: their agent computers are gone. Clear them, or add the agent computer back.
          </div>
        </>
      )}
    </div>
  );
}

function stateOf(c: ComputerStatus): { label: string; tone: "ok" | "warn" | "busy" | "muted" | "err" } {
  const i = c.inbox;
  if (i?.held) return { label: `held${i.holdReason ? `: ${i.holdReason}` : ""}`, tone: "warn" };
  if (c.phase === "Asleep") return { label: (i?.pending ?? 0) > 0 && c.power?.autoWake ? "asleep · will wake" : "asleep", tone: "muted" };
  if (c.phase === "Busy" || (i?.claimed ?? 0) > 0) return { label: "delivering", tone: "busy" };
  if (c.phase === "Error") return { label: "agent computer in error", tone: "err" };
  return { label: (i?.pending ?? 0) > 0 ? "waiting for idle" : "idle", tone: (i?.pending ?? 0) > 0 ? "busy" : "ok" };
}

function InboxRow({ c, open, toggle }: { c: ComputerStatus; open: boolean; toggle: () => void }) {
  const { store, base, toast, confirm } = useApp();
  const [oldest, setOldest] = useState<string | undefined>();
  const now = useNow(5000);
  const i = c.inbox;
  const pending = i?.pending ?? 0;
  useEffect(() => {
    if (!pending) {
      setOldest(undefined);
      return;
    }
    store.fleet.client
      .inbox(c.name, {})
      .then((r) => setOldest(r.messages[0]?.createdAt))
      .catch(() => {});
  }, [pending, c.name, store]);

  const act = async (what: "hold" | "resume" | "resume-new" | "clear") => {
    try {
      if (what === "clear") {
        const ok = await confirm({ title: `Clear ${c.name}'s inbox?`, body: `${pending} pending Message${pending === 1 ? "" : "s"} will be discarded (their bodies stay in the journal as inbox.discarded).`, ok: "Clear inbox", danger: true });
        if (!ok) return;
        await store.fleet.client.request("POST", `/v1/agent-computers/${encodeURIComponent(c.name)}/inbox/clear`, {});
      } else if (what === "hold") {
        await store.fleet.client.request("POST", `/v1/agent-computers/${encodeURIComponent(c.name)}/inbox/hold`, { reason: "held from the console" });
      } else {
        await store.fleet.client.request("POST", `/v1/agent-computers/${encodeURIComponent(c.name)}/inbox/resume`, what === "resume-new" ? { session: "new" } : {});
      }
      toast(`${c.name}: inbox ${what === "resume-new" ? "resumed in a new session" : what === "clear" ? "cleared" : what === "hold" ? "held" : "resumed"}`);
      store.refreshSoon(0);
    } catch (err) {
      toast(errText(err), "err");
    }
  };
  const st = stateOf(c);
  const ended = i?.ended24h;
  const endedN = ended ? ended.expired + ended.replaced + ended.withdrawn + ended.discarded : 0;
  return (
    <tr className={cls("click", open && "sel")} onClick={toggle}>
      <td>
        <span className="faint" style={{ display: "inline-block", width: 14 }}>{open ? "▾" : "▸"}</span>
        <Link to={`${base}/ac/${encodeURIComponent(c.name)}/inbox`} className="" >
          <b style={{ color: "var(--text)" }}>{c.name}</b>
        </Link>
      </td>
      <td className="num">{pending || <span className="faint">0</span>}</td>
      <td className="faint">{oldest ? dur(now - Date.parse(oldest)) : "–"}</td>
      <td className="faint">
        {i ? `${i.usage.messages}/${i.limits.maxMessages.value} · ${bytes(i.usage.bytes)}` : "–"}
        {i?.overLimit && <Pill tone="err">over limit</Pill>}
      </td>
      <td>
        <Pill tone={st.tone} dot>
          {st.label}
        </Pill>
      </td>
      <td className="num faint" title={ended ? `expired ${ended.expired} · replaced ${ended.replaced} · withdrawn ${ended.withdrawn} · discarded ${ended.discarded}` : ""}>
        {endedN || "–"}
      </td>
      <td className="actions" onClick={(e) => e.stopPropagation()}>
        {i?.held ? (
          <>
            <button className="btn sm" onClick={() => act("resume")}>Resume</button>
            <button className="btn sm" onClick={() => act("resume-new")}>Resume new session</button>
          </>
        ) : (
          <button className="btn sm" onClick={() => act("hold")}>Hold</button>
        )}
        <button className="btn sm danger" disabled={!pending} onClick={() => act("clear")}>
          Clear
        </button>
      </td>
    </tr>
  );
}

export function PendingList({ name, rev }: { name: string; rev: number }) {
  const { store, toast } = useApp();
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const now = useNow(5000);
  useEffect(() => {
    let live = true;
    store.fleet.client
      .inbox(name, { bodies: true })
      .then((r) => live && setMsgs(r.messages))
      .catch(() => live && setMsgs([]));
    return () => {
      live = false;
    };
    // rev: refresh when the store sees a change
  }, [name, store, Math.floor(rev / 3)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!msgs) return <div className="faint" style={{ padding: 12 }}>Loading…</div>;
  if (!msgs.length) return <div className="faint" style={{ padding: "10px 14px" }}>Nothing pending.</div>;
  const withdraw = async (m: Message) => {
    try {
      await store.fleet.client.withdraw(name, m.id);
      setMsgs((x) => x?.filter((y) => y.id !== m.id) ?? null);
      toast(`Withdrew #${m.seq}`);
      store.refreshSoon(0);
    } catch (err) {
      toast(errText(err), "err");
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {msgs.map((m) => (
        <div key={m.id} style={{ display: "flex", gap: 12, padding: "9px 14px 9px 34px", borderTop: "1px solid var(--border)", alignItems: "flex-start" }}>
          <div className="grow">
            <div className="row" style={{ fontSize: 12, gap: 6 }}>
              <span className="mono">#{m.seq}</span>
              <span className="muted">
                from {m.sender} <span className="faint">({m.via})</span>
              </span>
              <span className="faint">· {ago(m.createdAt, now)} · {bytes(m.bytes)}</span>
              {m.replaceKey && <span className="faint">· key {m.replaceKey}</span>}
              {m.expiresAt && <span className="faint">· expires in {dur(Date.parse(m.expiresAt) - now)}</span>}
              {m.fresh && <Pill tone="info">fresh session</Pill>}
              <Pill tone={m.state === "claimed" ? "busy" : "muted"}>{m.state}</Pill>
            </div>
            <div style={{ marginTop: 3 }} className="ellipsis">
              "{short(m.body ?? "", 220)}"
            </div>
          </div>
          <button className="btn sm" disabled={m.state !== "pending"} onClick={() => withdraw(m)}>
            Withdraw
          </button>
        </div>
      ))}
    </div>
  );
}
