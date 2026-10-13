import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FleetStore, useSnapshot, type FleetInfo } from "./store";
import { AppCtx, Link, Modal, Toasts, navigate, useKeys, usePath, type Ctx, type ToastItem, Pill } from "./ui";
import { cls } from "./util";
import { Overview } from "./pages/Overview";
import { Detail } from "./pages/Detail";
import { Timeline } from "./pages/Timeline";
import { Inboxes } from "./pages/Inboxes";
import { Editor } from "./pages/Editor";
import { Credentials } from "./pages/Credentials";
import { Tokens } from "./pages/Tokens";
import logoDark from "./logo-dark.svg";
import logoLight from "./logo-light.svg";

interface FleetsResponse {
  version: string;
  default?: string;
  fleets: FleetInfo[];
}

type Theme = "system" | "dark" | "light";

function applyTheme(t: Theme) {
  localStorage.setItem("a12s-console-theme", t);
  const eff = t === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : t;
  document.documentElement.dataset.theme = eff;
}

export function App() {
  const [fleets, setFleets] = useState<FleetsResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const path = usePath();

  const loadFleets = useCallback(async () => {
    try {
      const r = await fetch("/console/fleets");
      if (r.status === 401) {
        setLoadErr("locked");
        return;
      }
      setFleets(await r.json());
      setLoadErr(null);
    } catch (err) {
      setLoadErr(String(err));
    }
  }, []);

  useEffect(() => {
    void loadFleets();
    const t = setInterval(loadFleets, 10_000);
    return () => clearInterval(t);
  }, [loadFleets]);

  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
  const fleetName = seg[0];

  useEffect(() => {
    if (!fleets) return;
    if (!fleetName) {
      const def = fleets.fleets.find((f) => f.name === fleets.default)?.name ?? fleets.fleets[0]?.name;
      if (def) navigate(`/${encodeURIComponent(def)}`, true);
    }
  }, [fleets, fleetName]);

  if (loadErr === "locked") return <Centered>This console is locked. Open the link it printed in your terminal.</Centered>;
  if (!fleets) return <Centered>{loadErr ? `Can't reach the console: ${loadErr}` : "Loading…"}</Centered>;
  if (!fleets.fleets.length)
    return (
      <Centered>
        <b>No running Fleet.</b>
        <br />
        Run <code>a12s up</code> in a Fleet's directory; it shows up here within seconds.
      </Centered>
    );
  const info = fleets.fleets.find((f) => f.name === fleetName);
  if (!fleetName) return <Centered>Loading…</Centered>;
  if (!info)
    return (
      <Centered>
        <b>Fleet {fleetName} isn't running.</b>
        <br />
        Run <code>a12s up</code> in its directory, or open{" "}
        {fleets.fleets.map((f) => (
          <Link key={f.name} to={`/${f.name}`}>
            {f.name}{" "}
          </Link>
        ))}
      </Centered>
    );
  return <FleetApp key={info.name} info={info} fleets={fleets} seg={seg} />;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--dim)", textAlign: "center", lineHeight: 1.7 }}>
      <div>{children}</div>
    </div>
  );
}

const pages = [
  { id: "", label: "Overview", key: "o" },
  { id: "timeline", label: "Timeline", key: "t" },
  { id: "inboxes", label: "Inboxes", key: "i" },
  { id: "editor", label: "Fleet editor", key: "e" },
  { id: "credentials", label: "Credentials", key: "c" },
  { id: "tokens", label: "Tokens", key: "k" },
];

function FleetApp({ info, fleets, seg }: { info: FleetInfo; fleets: FleetsResponse; seg: string[] }) {
  const store = useMemo(() => new FleetStore(info), [info.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const snap = useSnapshot(store);
  const base = `/${encodeURIComponent(info.name)}`;
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirm] = useState<null | { title: string; body?: ReactNode; ok: string; danger?: boolean; resolve: (v: boolean) => void }>(null);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [warnOpen, setWarnOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("a12s-console-theme") as Theme) || "system");
  const tid = useRef(1);

  const toast = useCallback((msg: string, tone: "ok" | "err" = "ok") => {
    const id = tid.current++;
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 7000 : 3200);
  }, []);
  const confirm = useCallback<Ctx["confirm"]>((o) => new Promise((resolve) => setConfirm({ ...o, resolve })), []);
  const ctx: Ctx = useMemo(() => ({ store, fleet: info.name, base, toast, confirm }), [store, info.name, base, toast, confirm]);

  const cycleTheme = () => {
    const next: Theme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    setTheme(next);
    applyTheme(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const keymap: Record<string, () => void> = { "?": () => setHelp(true), "T": cycleTheme };
  for (const p of pages) keymap[`g ${p.key}`] = () => navigate(p.id ? `${base}/${p.id}` : base);
  useKeys(keymap, [base, theme]);

  const page = seg[1] ?? "";
  const status = snap.status;
  const warnings = [
    ...(status?.warnings ?? []),
    ...(status?.agentComputers ?? []).flatMap((c) => (c.warnings ?? []).map((w) => `${c.name}: ${w}`)),
    ...(status?.services ?? []).flatMap((s) => (s.warnings ?? []).map((w) => `${s.name}: ${w}`)),
  ];
  const pendingTotal = (status?.agentComputers ?? []).reduce((s, c) => s + (c.inbox?.pending ?? 0), 0);

  let body: ReactNode;
  if (page === "ac" && seg[2]) body = <Detail name={seg[2]} tab={seg[3] ?? "chat"} turn={seg[4]} />;
  else if (page === "timeline") body = <Timeline />;
  else if (page === "inboxes") body = <Inboxes />;
  else if (page === "editor") body = <Editor sel={seg.slice(2)} />;
  else if (page === "credentials") body = <Credentials />;
  else if (page === "tokens") body = <Tokens />;
  else body = <Overview />;

  const healthy = snap.healthy;
  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <Link to={base} className="brand">
            <img src={logoDark} alt="a12s" className="logo-dark" />
            <img src={logoLight} alt="a12s" className="logo-light" />
            <span>console</span>
          </Link>
          <span className="faint">/</span>
          <select
            className="select"
            aria-label="Fleet"
            value={info.name}
            onChange={(e) => navigate(`/${encodeURIComponent(e.target.value)}`)}
            style={{ height: 26, fontWeight: 600 }}
          >
            {fleets.fleets.map((f) => (
              <option key={f.name} value={f.name}>
                fleet: {f.name}
              </option>
            ))}
          </select>
          <div className="pills">
            <Pill tone={healthy === false ? "err" : healthy ? "ok" : "muted"} dot title={snap.statusError ?? info.url}>
              Controller {healthy === false ? "down" : healthy ? "ok" : "…"}
            </Pill>
            {snap.version !== null && (
              <Pill tone="muted" title={snap.driftCount ? `${snap.driftCount} changes since the last a12s up` : "the Fleet's version"}>
                <span className="mono">v{snap.version}</span>
                {snap.driftCount > 0 && <span className="warn-t">· {snap.driftCount} drift</span>}
              </Pill>
            )}
            <Pill tone={snap.live ? "info" : "warn"} title="the one fleet-wide event connection">
              {snap.live ? "● live" : "○ reconnecting"}
            </Pill>
            {status && (
              <Pill tone={status.credentialsLoaded ? "muted" : "warn"} title="credential values on the Controller">
                creds {status.credentialsLoaded ? "loaded" : "missing"}
              </Pill>
            )}
            {status && <Pill tone="muted">egress {status.egressEnforcement || "?"}</Pill>}
            {warnings.length > 0 && (
              <button className="pill warn" onClick={() => setWarnOpen(true)}>
                ⚠ {warnings.length} warning{warnings.length > 1 ? "s" : ""}
              </button>
            )}
          </div>
          <div className="spacer" />
          <button className="btn ghost" onClick={() => setPalette(true)} title="Go to anything">
            Search <kbd>⌘K</kbd>
          </button>
          <button className="btn ghost" onClick={cycleTheme} title="Theme (shift+T)" aria-label="Theme">
            {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
          </button>
          <button className="btn ghost" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)" aria-label="Shortcuts">
            ?
          </button>
        </header>
        <nav className="nav">
          {pages.map((p) => {
            const on = p.id === "" ? page === "" || page === "ac" : page === p.id;
            return (
              <Link key={p.id} to={p.id ? `${base}/${p.id}` : base} className={cls(on && "on")} title={`g ${p.key}`}>
                {p.label}
                {p.id === "" && status && <span className="count">{status.agentComputers?.length ?? 0}</span>}
                {p.id === "inboxes" && pendingTotal > 0 && <span className="count">{pendingTotal}</span>}
              </Link>
            );
          })}
        </nav>
        <main>{body}</main>
      </div>
      <Toasts items={toasts} />
      {palette && <Palette onClose={() => setPalette(false)} base={base} store={store} cycleTheme={cycleTheme} />}
      {help && <Help onClose={() => setHelp(false)} />}
      {warnOpen && (
        <Modal title={`Warnings (${warnings.length})`} onClose={() => setWarnOpen(false)} foot={<button className="btn" onClick={() => setWarnOpen(false)}>Close</button>}>
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Modal>
      )}
      {confirmState && (
        <Modal
          title={confirmState.title}
          onClose={() => {
            confirmState.resolve(false);
            setConfirm(null);
          }}
          foot={
            <>
              <button
                className="btn"
                onClick={() => {
                  confirmState.resolve(false);
                  setConfirm(null);
                }}
              >
                Cancel
              </button>
              <button
                autoFocus
                className={cls("btn", confirmState.danger ? "danger" : "primary")}
                onClick={() => {
                  confirmState.resolve(true);
                  setConfirm(null);
                }}
              >
                {confirmState.ok}
              </button>
            </>
          }
        >
          {confirmState.body}
        </Modal>
      )}
    </AppCtx.Provider>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ["⌘K", "Go to an agent computer, page or action"],
    ["g o", "Overview"],
    ["g t", "Timeline"],
    ["g i", "Inboxes"],
    ["g e", "Fleet editor"],
    ["g c", "Credentials"],
    ["g k", "Tokens"],
    ["1 – 5", "Agent computer tabs: Chat, Timeline, Inbox, Turns, Config"],
    ["/", "Focus the message box or filter"],
    ["Enter", "Send (Shift+Enter: new line)"],
    ["⌘S", "Save in the fleet editor"],
    ["Esc", "Close a panel or dialog"],
    ["Shift T", "Theme: system, dark, light"],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="table" style={{ border: "none", background: "transparent" }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 90 }}>
                {k.split(" ").map((x, i) => (
                  <kbd key={i} style={{ marginRight: 3 }}>
                    {x}
                  </kbd>
                ))}
              </td>
              <td className="muted">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function Palette({ onClose, base, store, cycleTheme }: { onClose: () => void; base: string; store: FleetStore; cycleTheme: () => void }) {
  const snap = useSnapshot(store);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const items: Array<{ label: string; kind: string; go: () => void }> = [
    ...(snap.status?.agentComputers ?? []).map((c) => ({ label: c.name, kind: `agent computer · ${c.phase}`, go: () => navigate(`${base}/ac/${encodeURIComponent(c.name)}`) })),
    ...pages.map((p) => ({ label: p.label, kind: "page", go: () => navigate(p.id ? `${base}/${p.id}` : base) })),
    { label: "New agent computer", kind: "action", go: () => navigate(`${base}/editor/new`) },
    { label: "New Service", kind: "action", go: () => navigate(`${base}/editor/new-service`) },
    { label: "Edit defaults", kind: "action", go: () => navigate(`${base}/editor/defaults`) },
    { label: "Set a credential", kind: "action", go: () => navigate(`${base}/credentials`) },
    { label: "Create a token", kind: "action", go: () => navigate(`${base}/tokens`) },
    ...(snap.status?.services ?? []).map((s) => ({ label: s.name, kind: `Service · ${s.phase}`, go: () => navigate(`${base}/editor/svc/${encodeURIComponent(s.name)}`) })),
    { label: "Toggle theme", kind: "action", go: cycleTheme },
  ];
  const ql = q.toLowerCase();
  const shown = items.filter((x) => !ql || x.label.toLowerCase().includes(ql) || x.kind.toLowerCase().includes(ql));
  const pick = (n: number) => {
    const it = shown[n];
    if (it) {
      it.go();
      onClose();
    }
  };
  return (
    <Modal title={null} onClose={onClose} className="palette">
      <input
        autoFocus
        placeholder="Go to an agent computer, page or action…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setI(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setI((x) => Math.min(x + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setI((x) => Math.max(x - 1, 0));
          } else if (e.key === "Enter") pick(i);
        }}
        style={{ margin: "-6px -16px 0", width: "calc(100% + 32px)" }}
      />
      <ul style={{ margin: "0 -16px -14px" }}>
        {shown.map((x, n) => (
          <li key={x.kind + x.label} className={cls(n === i && "on")} onMouseEnter={() => setI(n)} onClick={() => pick(n)}>
            {x.label}
            <span className="kind">{x.kind}</span>
          </li>
        ))}
        {!shown.length && <li className="faint">Nothing matches</li>}
      </ul>
    </Modal>
  );
}
