import { useCallback, useEffect, useState } from "react";
import { errText, useSnapshot } from "../store";
import type { CredentialRow } from "../types";
import { Empty, Link, Modal, Pill, useApp, useNow } from "../ui";
import { ago } from "../util";

const known: Record<string, string> = {
  anthropic: "Claude Code: a claude setup-token token or an Anthropic API key",
  openai: "Codex: an OpenAI API key",
  github: "GH_TOKEN / GITHUB_TOKEN in the agent computer",
};

export function Credentials() {
  const { store, base, toast, confirm } = useApp();
  const snap = useSnapshot(store);
  const [rows, setRows] = useState<CredentialRow[] | null>(null);
  const [editing, setEditing] = useState<{ name: string; isNew: boolean } | null>(null);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    try {
      setRows((await store.fleet.credentials.list()) as CredentialRow[]);
    } catch (err) {
      toast(errText(err), "err");
      setRows([]);
    }
  }, [store, toast]);
  useEffect(() => {
    void load();
  }, [load, snap.version]);

  const remove = async (r: CredentialRow) => {
    const ok = await confirm({ title: `Remove credential ${r.name}?`, body: "Its value is deleted from the Controller. Agent computers that name it can't start a Turn until it is set again.", ok: "Remove", danger: true });
    if (!ok) return;
    try {
      await store.fleet.credentials.remove(r.name);
      toast(`Removed ${r.name}`);
      void load();
    } catch (err) {
      toast(errText(err), "err");
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>Credentials</h1>
        <span className="sub">names only · set or replace a value; no one can read one back</span>
        <div className="grow" />
        <button className="btn primary" onClick={() => setEditing({ name: "", isNew: true })}>
          + Set credential
        </button>
      </div>
      {!rows ? (
        <div className="faint">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty title="No credentials">Set one by name (anthropic, openai, github, or your own), then name it in an agent computer's credentials.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Used by</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>
                  <b className="mono">{r.name}</b>
                  {known[r.name] && <div className="faint" style={{ fontSize: 11.5 }}>{known[r.name]}</div>}
                </td>
                <td>{r.set ? <Pill tone="ok">●●●●●●●● set</Pill> : <Pill tone="err">not set</Pill>}</td>
                <td>
                  {r.usedBy?.length ? (
                    r.usedBy.map((u, i) => (
                      <span key={u}>
                        {i > 0 && ", "}
                        <Link to={`${base}/ac/${encodeURIComponent(u)}`}>{u}</Link>
                      </span>
                    ))
                  ) : (
                    <span className="faint">nobody</span>
                  )}
                </td>
                <td className="faint">{r.updatedAt ? ago(r.updatedAt, now) : "–"}</td>
                <td className="actions">
                  <button className="btn sm" onClick={() => setEditing({ name: r.name, isNew: false })}>
                    {r.set ? "Replace" : "Set"}
                  </button>
                  <button className="btn sm danger" disabled={!!r.usedBy?.length} title={r.usedBy?.length ? "in use: remove it from those agent computers first" : ""} onClick={() => void remove(r)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="faint" style={{ fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
        Values are stored 0600 in the Controller's state volume and reach agent computers as files or environment, never on a drive. Setting one updates every agent computer that uses it at once. From a terminal: <code>a12s creds set &lt;name&gt;</code>.
      </p>
      {editing && <SetCredential init={editing} onClose={() => setEditing(null)} onDone={() => void load()} />}
    </div>
  );
}

function SetCredential({ init, onClose, onDone }: { init: { name: string; isNew: boolean }; onClose: () => void; onDone: () => void }) {
  const { store, toast } = useApp();
  const [name, setName] = useState(init.name);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^[a-z0-9]([-a-z0-9_]*[a-z0-9])?$/.test(name) && value.length > 0;
  const save = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      // tokens pasted from a terminal are often wrapped: one line, no spaces
      await store.fleet.credentials.set(name, /^sk-ant-/.test(value.trim()) ? value.replace(/\s+/g, "") : value.trim());
      setValue("");
      toast(`${name} set`);
      onDone();
      onClose();
    } catch (err) {
      toast(errText(err), "err");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={init.isNew ? "Set a credential" : `Replace ${init.name}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={() => void save()}>
            {init.isNew ? "Set" : "Replace"}
          </button>
        </>
      }
    >
      <label className="faint" style={{ fontSize: 12 }}>
        Name
      </label>
      <input className="input mono" autoFocus={init.isNew} disabled={!init.isNew} value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="anthropic" list="cred-names" />
      <datalist id="cred-names">
        {Object.keys(known).map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {known[name] && <span className="faint" style={{ fontSize: 12 }}>{known[name]}</span>}
      <label className="faint" style={{ fontSize: 12 }}>
        Value
      </label>
      <input
        className="input mono"
        type="password"
        autoFocus={!init.isNew}
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void save()}
        placeholder="paste it; it is sent once and never shown again"
      />
      <span className="faint" style={{ fontSize: 11.5 }}>Sent straight to the Controller over this machine's loopback; the console keeps no copy.</span>
    </Modal>
  );
}
