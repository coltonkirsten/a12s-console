import { useCallback, useEffect, useState } from "react";
import type { Token, TokenAction } from "@coltonkirsten/a12s";
import { errText, useSnapshot } from "../store";
import type { TokenRow } from "../types";
import { Empty, Modal, Pill, useApp, useNow } from "../ui";
import { ago, cls, copy } from "../util";

const actions: TokenAction[] = ["status", "events", "send", "inbox", "power", "stop"];

export function Tokens() {
  const { store, toast, confirm } = useApp();
  const [rows, setRows] = useState<TokenRow[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<Token | null>(null);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    try {
      setRows((await store.fleet.tokens.list()) as TokenRow[]);
    } catch (err) {
      toast(errText(err), "err");
      setRows([]);
    }
  }, [store, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (t: TokenRow) => {
    const ok = await confirm({ title: `Revoke token ${t.name}?`, body: "Programs using it get 401 from their next request.", ok: "Revoke", danger: true });
    if (!ok) return;
    try {
      await store.fleet.tokens.remove(t.name);
      toast(`Revoked ${t.name}`);
      void load();
    } catch (err) {
      toast(errText(err), "err");
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <h1>Tokens</h1>
        <span className="sub">for other programs: a prefix lane (everything on names like biz-*) or narrow actions</span>
        <div className="grow" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          + Create token
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>Scope</th>
            <th>Created</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <b>owner</b>
            </td>
            <td>
              <Pill tone="info">owner</Pill>
            </td>
            <td className="muted">everything (the CLI, this console)</td>
            <td className="faint">a12s up</td>
            <td className="faint">now</td>
            <td className="actions faint" style={{ fontSize: 11.5 }}>
              in controller.json
            </td>
          </tr>
          {rows?.map((t) => (
            <tr key={t.name}>
              <td>
                <b className="mono">{t.name}</b>
              </td>
              <td>{t.prefix ? <Pill tone="busy">prefix</Pill> : <Pill>narrow</Pill>}</td>
              <td>
                {t.prefix ? (
                  <span>
                    everything on <span className="mono">{t.prefix}*</span>
                  </span>
                ) : (
                  <span>
                    <span className="mono">{t.actions.join(", ")}</span> <span className="faint">on</span>{" "}
                    <span className="mono">{t.computers.join(", ")}</span>
                  </span>
                )}
              </td>
              <td className="faint">{ago(t.createdAt, now)}</td>
              <td className="faint">{t.lastUsedAt ? ago(t.lastUsedAt, now) : "never"}</td>
              <td className="actions">
                <button className="btn sm danger" onClick={() => void revoke(t)}>
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows && rows.length === 0 && (
        <div style={{ marginTop: 12 }}>
          <Empty title="No tokens yet">Give an app its own lane: a prefix token like biz- can create and run biz-* agent computers and nothing else.</Empty>
        </div>
      )}
      {creating && (
        <CreateToken
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setSecret(t);
            void load();
          }}
        />
      )}
      {secret && (
        <Modal
          title={`Token ${secret.name} created`}
          onClose={() => setSecret(null)}
          foot={
            <>
              <button className="btn" onClick={() => copy(secret.secret ?? "")}>
                Copy
              </button>
              <button className="btn primary" onClick={() => setSecret(null)}>
                Done
              </button>
            </>
          }
        >
          <div className="banner warn">Copy it now. It is shown once; the Controller keeps only its hash.</div>
          <div className="secret">{secret.secret}</div>
          <span className="faint" style={{ fontSize: 12 }}>
            Use it as <code>Authorization: Bearer …</code>, or <code>Fleet.connect({"{ url, token }"})</code>.
          </span>
        </Modal>
      )}
    </div>
  );
}

function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: (t: Token) => void }) {
  const { store, toast } = useApp();
  const snap = useSnapshot(store);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"prefix" | "narrow">("prefix");
  const [prefix, setPrefix] = useState("");
  const [acts, setActs] = useState<TokenAction[]>(["status", "events"]);
  const [on, setOn] = useState<string[]>(["*"]);
  const names = (snap.status?.agentComputers ?? []).map((c) => c.name);
  const valid = /^[a-z0-9][-a-z0-9_]*$/.test(name) && (kind === "prefix" ? /^[a-z0-9][-a-z0-9]*$/.test(prefix) : acts.length > 0 && on.length > 0);
  const create = async () => {
    try {
      const t = await store.fleet.tokens.create(name, kind === "prefix" ? { prefix } : { actions: acts, agentComputers: on });
      onCreated(t);
    } catch (err) {
      toast(errText(err), "err");
    }
  };
  const covered = kind === "prefix" && prefix ? names.filter((n) => n.startsWith(prefix)) : [];
  return (
    <Modal
      title="Create a token"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <label className="faint" style={{ fontSize: 12 }}>
        Name (messages it sends arrive via token:{name || "<name>"})
      </label>
      <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="bizapp" />
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={cls(kind === "prefix" && "on")} onClick={() => setKind("prefix")}>
          Prefix lane
        </button>
        <button className={cls(kind === "narrow" && "on")} onClick={() => setKind("narrow")}>
          Narrow actions
        </button>
      </div>
      {kind === "prefix" ? (
        <>
          <input className="input mono" value={prefix} onChange={(e) => setPrefix(e.target.value.trim())} placeholder="biz-" />
          <span className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
            Owner powers on agent computers, Services and credentials named {prefix || "<prefix>"}*: create, change, remove, send, watch. Nothing outside it; no minting tokens; no defaults.
            {covered.length > 0 && <> Today that covers {covered.join(", ")}.</>}
          </span>
        </>
      ) : (
        <>
          <div className="chips">
            {actions.map((a) => (
              <label key={a} className="chip" style={{ paddingRight: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={acts.includes(a)} onChange={(e) => setActs(e.target.checked ? [...acts, a] : acts.filter((x) => x !== a))} /> {a}
              </label>
            ))}
          </div>
          <span className="faint" style={{ fontSize: 12 }}>on</span>
          <div className="chips">
            {["*", ...names].map((n) => (
              <label key={n} className="chip" style={{ paddingRight: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={on.includes(n)}
                  onChange={(e) => {
                    if (n === "*") setOn(e.target.checked ? ["*"] : []);
                    else setOn(e.target.checked ? [...on.filter((x) => x !== "*"), n] : on.filter((x) => x !== n));
                  }}
                />{" "}
                {n === "*" ? "every agent computer" : n}
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
