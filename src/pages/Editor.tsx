import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import YAML from "yaml";
import type { AgentComputerSpec, FleetSpec, PutFleetResponse } from "@coltonkirsten/a12s";
import { errText, useSnapshot } from "../store";
import type { ChangeWithDiff, CredentialRow } from "../types";
import { Link, Pill, Spinner, navigate, useApp } from "../ui";
import { cls, short } from "../util";

type Kind = "defaults" | "ac" | "svc";
type Spec = Record<string, unknown>;

interface Sel {
  kind: Kind;
  name: string;
  isNew: boolean;
}

const dns = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

function parseSel(sel: string[]): Sel | null {
  if (sel[0] === "defaults") return { kind: "defaults", name: "defaults", isNew: false };
  if (sel[0] === "new") return { kind: "ac", name: "", isNew: true };
  if (sel[0] === "new-service") return { kind: "svc", name: "", isNew: true };
  if (sel[0] === "ac" && sel[1]) return { kind: "ac", name: sel[1], isNew: false };
  if (sel[0] === "svc" && sel[1]) return { kind: "svc", name: sel[1], isNew: false };
  return null;
}

interface Preview {
  loading: boolean;
  changes: ChangeWithDiff[];
  errors: string[];
  warnings: string[];
}

export function Editor({ sel: selPath }: { sel: string[] }) {
  const { store, base, toast, confirm } = useApp();
  const snap = useSnapshot(store);
  const [fleet, setFleet] = useState<{ version: number; spec: FleetSpec } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const sel = parseSel(selPath);
  const [creds, setCreds] = useState<CredentialRow[]>([]);

  const load = useCallback(async () => {
    try {
      const f = await store.fleet.get();
      setFleet({ version: f.version, spec: f.spec });
      setLoadErr(null);
    } catch (err) {
      setLoadErr(errText(err));
    }
  }, [store]);
  useEffect(() => {
    void load();
    store.fleet.credentials.list().then(setCreds).catch(() => {});
  }, [load, store]);

  useEffect(() => {
    if (!sel && fleet) {
      const first = Object.keys(fleet.spec.agent_computers ?? {})[0];
      navigate(first ? `${base}/editor/ac/${encodeURIComponent(first)}` : `${base}/editor/defaults`, true);
    }
  }, [sel, fleet, base]);

  if (loadErr) return <div className="page"><div className="banner err">Can't read the Fleet: {loadErr}</div></div>;
  if (!fleet || !sel) return <div className="page faint">Loading…</div>;

  const acs = Object.keys(fleet.spec.agent_computers ?? {}).sort();
  const svcs = Object.keys(fleet.spec.services ?? {}).sort();
  const drives = Object.entries(fleet.spec.drives ?? {});
  const on = (k: Kind, n: string) => sel.kind === k && sel.name === n && !sel.isNew;
  const phase = (n: string) => snap.status?.agentComputers?.find((c) => c.name === n)?.phase;

  return (
    <div className="editor">
      <nav className="tree" aria-label="Fleet">
        <div className="grp">FLEET {fleet.spec.metadata?.name} · v{fleet.version}</div>
        <Link to={`${base}/editor/defaults`} className={cls(on("defaults", "defaults") && "on")}>
          ⚙ Defaults
        </Link>
        <div className="grp">AGENT COMPUTERS</div>
        {acs.map((n) => (
          <Link key={n} to={`${base}/editor/ac/${encodeURIComponent(n)}`} className={cls(on("ac", n) && "on")}>
            <span className={cls("dot", phase(n) === "Ready" ? "ok" : phase(n) === "Busy" ? "busy" : phase(n) === "Error" ? "err" : "muted")} />
            <span className="ellipsis">{n}</span>
          </Link>
        ))}
        {sel.isNew && sel.kind === "ac" && <a className="on">＋ new agent computer</a>}
        <Link to={`${base}/editor/new`} className="add">
          + Add agent computer
        </Link>
        <div className="grp">SERVICES</div>
        {svcs.map((n) => (
          <Link key={n} to={`${base}/editor/svc/${encodeURIComponent(n)}`} className={cls(on("svc", n) && "on")}>
            ◆ <span className="ellipsis">{n}</span>
          </Link>
        ))}
        {sel.isNew && sel.kind === "svc" && <a className="on">＋ new Service</a>}
        <Link to={`${base}/editor/new-service`} className="add">
          + Add Service
        </Link>
        {drives.length > 0 && (
          <>
            <div className="grp">DRIVES</div>
            {drives.map(([n, d]) => (
              <a key={n} title={`${d.access} · ${d.size ?? ""} (change drives in fleet.yaml)`}>
                ▤ <span className="ellipsis">{n}</span> <span className="faint">{d.access}</span>
              </a>
            ))}
          </>
        )}
      </nav>
      <ItemEditor
        key={`${sel.kind}/${sel.name}/${sel.isNew}/${fleet.version}`}
        sel={sel}
        fleet={fleet}
        creds={creds}
        reload={load}
        onSaved={(name) => {
          void load();
          store.refreshSoon(0);
          if (sel.isNew) navigate(`${base}/editor/${sel.kind}/${encodeURIComponent(name)}`, true);
        }}
        onRemoved={() => {
          void load();
          store.refreshSoon(0);
          navigate(`${base}/editor`, true);
        }}
        toast={toast}
        confirm={confirm}
      />
    </div>
  );
}

function specOf(fleet: { spec: FleetSpec }, sel: Sel): Spec {
  if (sel.isNew) return sel.kind === "ac" ? { instructions: "" } : { image: "" };
  if (sel.kind === "defaults") return (fleet.spec.defaults ?? {}) as Spec;
  if (sel.kind === "ac") return (fleet.spec.agent_computers?.[sel.name] ?? {}) as Spec;
  return (fleet.spec.services?.[sel.name] ?? {}) as Spec;
}

function ItemEditor(props: {
  sel: Sel;
  fleet: { version: number; spec: FleetSpec };
  creds: CredentialRow[];
  reload: () => Promise<void>;
  onSaved: (name: string) => void;
  onRemoved: () => void;
  toast: (m: string, t?: "ok" | "err") => void;
  confirm: ReturnType<typeof useApp>["confirm"];
}) {
  const { sel, fleet, creds } = props;
  const { store } = useApp();
  const orig = useMemo(() => structuredClone(specOf(fleet, sel)), [fleet, sel]);
  const [draft, setDraft] = useState<Spec>(() => structuredClone(orig));
  const [name, setName] = useState(sel.name);
  const [mode, setMode] = useState<"form" | "yaml">(sel.kind === "svc" ? "yaml" : "form");
  const [preview, setPreview] = useState<Preview>({ loading: false, changes: [], errors: [], warnings: [] });
  const [saving, setSaving] = useState(false);
  const [elsewhere, setElsewhere] = useState<string | null>(null);
  const baseVersion = useRef(fleet.version);
  const dirty = sel.isNew || JSON.stringify(draft) !== JSON.stringify(orig);

  // Someone else wrote this one while you edit: say so before you save (last save wins).
  useEffect(() => {
    return store.onEvent((ev) => {
      if (ev.type !== "fleet.changed") return;
      const names = ev.data.names ?? [];
      if (sel.kind === "defaults" || names.includes(sel.name)) {
        if (ev.data.version <= baseVersion.current) return;
        if (JSON.stringify(draft) === JSON.stringify(orig)) void props.reload();
        else setElsewhere(`${sel.kind === "defaults" ? "The Fleet" : sel.name} was changed by ${ev.data.by} (v${ev.data.version}) while you were editing.`);
      }
    });
  }, [store, sel, draft, orig, props]);

  const request = useCallback(
    async (dryRun: boolean): Promise<PutFleetResponse> => {
      const q = dryRun ? "?dryRun=true" : "";
      const enc = encodeURIComponent;
      const body = clean(draft);
      if (sel.kind === "defaults") {
        const f = structuredClone(fleet.spec);
        f.defaults = body as AgentComputerSpec;
        return store.fleet.client.request<PutFleetResponse>("PUT", `/v1/fleet${q}`, { fleet: f }, { headers: { "if-match": `"${fleet.version}"` } });
      }
      const path = sel.kind === "ac" ? `/v1/agent-computers/${enc(name)}` : `/v1/services/${enc(name)}`;
      return store.fleet.client.request<PutFleetResponse>("PUT", `${path}${q}`, body, { headers: sel.isNew ? { "if-none-match": "*" } : {} });
    },
    [draft, sel, name, fleet, store],
  );

  const nameErr = sel.isNew ? (!name ? "Give it a name" : !dns.test(name) ? "Lowercase letters, digits and -, like sales-2" : (sel.kind === "ac" ? fleet.spec.agent_computers?.[name] : fleet.spec.services?.[name]) ? `${name} exists` : null) : null;

  // dry run as you type
  useEffect(() => {
    if (!dirty || nameErr) {
      setPreview({ loading: false, changes: [], errors: nameErr && name ? [nameErr] : [], warnings: [] });
      return;
    }
    let live = true;
    setPreview((p) => ({ ...p, loading: true }));
    const t = setTimeout(async () => {
      try {
        const r = await request(true);
        if (!live) return;
        setPreview({ loading: false, changes: (r.changes ?? []) as ChangeWithDiff[], errors: Object.entries(r.errors ?? {}).map(([k, v]) => `${k}: ${v}`), warnings: r.warnings ?? [] });
      } catch (err) {
        if (live) setPreview({ loading: false, changes: [], errors: [errText(err)], warnings: [] });
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [draft, name, dirty, nameErr, request]);

  const save = useCallback(async () => {
    if (!dirty || nameErr || preview.errors.length || saving) return;
    setSaving(true);
    try {
      const r = await request(false);
      baseVersion.current = Math.max(baseVersion.current, r.version ?? 0);
      props.toast(sel.isNew ? `Created ${name}` : `Saved ${sel.kind === "defaults" ? "defaults" : name}`);
      setElsewhere(null);
      props.onSaved(name);
    } catch (err) {
      props.toast(errText(err), "err");
    } finally {
      setSaving(false);
    }
  }, [dirty, nameErr, preview.errors.length, saving, request, sel, name, props]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [save]);

  const remove = async () => {
    const what = sel.kind === "ac" ? "agent computer" : "Service";
    const path = sel.kind === "ac" ? `/v1/agent-computers/${encodeURIComponent(name)}` : `/v1/services/${encodeURIComponent(name)}`;
    let changes: ChangeWithDiff[] = [];
    try {
      changes = ((await store.fleet.client.request<PutFleetResponse>("DELETE", `${path}?dryRun=true`)).changes ?? []) as ChangeWithDiff[];
    } catch {
      // show the plain question
    }
    const ok = await props.confirm({
      title: `Remove ${what} ${name}?`,
      body: (
        <div className="col" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="muted">It stops and leaves the Fleet. Its drives are kept; its inbox is orphaned. `a12s up` from fleet.yaml brings back what the file lists.</span>
          {changes.length > 0 && <Changes changes={changes} />}
        </div>
      ),
      ok: `Remove ${name}`,
      danger: true,
    });
    if (!ok) return;
    try {
      await store.fleet.client.request("DELETE", path);
      props.toast(`Removed ${name}`);
      props.onRemoved();
    } catch (err) {
      props.toast(errText(err), "err");
    }
  };

  const inherited = sel.kind === "ac" ? ((fleet.spec.defaults ?? {}) as Spec) : {};
  const acNames = Object.keys(fleet.spec.agent_computers ?? {});
  const svcNames = Object.keys(fleet.spec.services ?? {});

  return (
    <>
      <div className="form">
        <div className="page-head">
          {sel.isNew ? (
            <input autoFocus className="input mono" placeholder={sel.kind === "ac" ? "name, like sales-2" : "service name"} value={name} onChange={(e) => setName(e.target.value.trim())} style={{ width: 240, fontSize: 14 }} />
          ) : (
            <h1>{sel.kind === "defaults" ? "Defaults" : name}</h1>
          )}
          <span className="sub">
            {sel.kind === "defaults" ? "every agent computer gets these unless it sets its own" : sel.kind === "svc" ? "Service" : sel.isNew ? "new agent computer" : "agent computer"}
          </span>
          {dirty && !sel.isNew && <Pill tone="warn">unsaved</Pill>}
          <div className="grow" />
          {sel.kind !== "svc" && (
            <div className="seg">
              <button className={cls(mode === "form" && "on")} onClick={() => setMode("form")}>
                Form
              </button>
              <button className={cls(mode === "yaml" && "on")} onClick={() => setMode("yaml")}>
                YAML
              </button>
            </div>
          )}
        </div>
        {elsewhere && (
          <div className="banner warn" style={{ marginBottom: 12 }}>
            <span>⚠</span>
            <span className="grow">{elsewhere} Saving overwrites it (last save wins).</span>
            <button
              className="btn sm"
              onClick={() => {
                setElsewhere(null);
                void props.reload();
              }}
            >
              Load theirs
            </button>
          </div>
        )}
        {mode === "yaml" ? (
          <YamlField value={draft} onChange={setDraft} />
        ) : (
          <AcForm draft={draft} setDraft={setDraft} inherited={inherited} creds={creds} acNames={acNames.filter((n) => n !== name)} svcNames={svcNames} isDefaults={sel.kind === "defaults"} />
        )}
      </div>
      <aside className="preview" aria-label="Changes">
        <div className="row">
          <b>Changes</b>
          <span className="faint">(dry run)</span>
          <div className="grow" />
          {preview.loading && <Spinner />}
        </div>
        {!dirty ? (
          <div className="faint" style={{ fontSize: 12.5 }}>
            No changes. Edit a field and the Controller checks it here before you save.
          </div>
        ) : (
          <Changes changes={preview.changes} />
        )}
        {preview.errors.length > 0 && (
          <div className="banner err" style={{ flexDirection: "column" }}>
            <b>Errors</b>
            {preview.errors.map((e, i) => (
              <span key={i}>{e}</span>
            ))}
            {preview.errors.some((e) => /credential/i.test(e)) && <Link to={`/${encodeURIComponent(store.info.name)}/credentials`}>→ Set it in Credentials</Link>}
          </div>
        )}
        {preview.warnings.length > 0 && (
          <div className="banner warn" style={{ flexDirection: "column" }}>
            {preview.warnings.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        )}
        <div className="row">
          <button className="btn primary" disabled={!dirty || !!nameErr || preview.errors.length > 0 || preview.loading || saving} onClick={() => void save()}>
            {saving ? <Spinner /> : preview.errors.length ? "Save (fix errors first)" : sel.isNew ? "Create" : "Save"} <kbd style={{ background: "transparent", color: "inherit", borderColor: "rgba(255,255,255,.35)" }}>⌘S</kbd>
          </button>
          {dirty && !sel.isNew && (
            <button className="btn ghost" onClick={() => setDraft(structuredClone(orig))}>
              Discard
            </button>
          )}
          <div className="grow" />
          {!sel.isNew && sel.kind !== "defaults" && (
            <button className="btn danger" onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>
        <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          {sel.kind === "defaults"
            ? "Saving writes the whole Fleet with If-Match: if someone wrote in between you get a conflict, never a silent overwrite."
            : "Saves only this one. If someone else edits it while you're here, a banner shows it before you save. Last save wins. A busy agent computer picks changes up at its next idle moment."}
        </div>
        {!dirty && preview.changes.length === 0 && store.snapshot.driftCount > 0 && (
          <div className="faint" style={{ fontSize: 11.5 }}>
            The live Fleet has {store.snapshot.driftCount} change{store.snapshot.driftCount > 1 ? "s" : ""} since the last <code>a12s up</code>. <code>a12s export</code> writes them back to fleet.yaml.
          </div>
        )}
      </aside>
    </>
  );
}

function Changes({ changes }: { changes: ChangeWithDiff[] }) {
  if (!changes.length) return <div className="faint" style={{ fontSize: 12.5 }}>Nothing would change.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {changes.map((c, i) => (
        <div key={i} className="change">
          <div>
            <span className={cls("op", c.op)}>{c.op === "create" ? "+ create" : c.op === "remove" ? "− remove" : "~ update"}</span> {c.name}{" "}
            <span className="faint">{c.when === "idle" ? "at idle" : "now"}</span>
          </div>
          {c.diff?.length
            ? c.diff.map((d, j) => (
                <div key={j} className="diffline">
                  {d.path}: <span className="b">{fmt(d.before)}</span> → <span className="a">{fmt(d.after)}</span>
                </div>
              ))
            : (c.fields ?? []).map((f) => (
                <div key={f} className="diffline">
                  {f}
                </div>
              ))}
        </div>
      ))}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === undefined) return "∅";
  if (typeof v === "string") return JSON.stringify(short(v, 60));
  return short(JSON.stringify(v), 70);
}

/** Drops empty strings, empty objects and undefined so a cleared field falls back to the default. */
function clean(v: Spec): Spec {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x;
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(x)) {
        const w = walk(val);
        if (w === undefined || w === "" || (w && typeof w === "object" && !Array.isArray(w) && !Object.keys(w).length)) continue;
        o[k] = w;
      }
      return o;
    }
    return x;
  };
  return walk(v) as Spec;
}

function get(o: Spec, path: string): unknown {
  return path.split(".").reduce<unknown>((x, k) => (x && typeof x === "object" ? (x as Spec)[k] : undefined), o);
}

function set(o: Spec, path: string, v: unknown): Spec {
  const out = structuredClone(o);
  const ks = path.split(".");
  let cur: Spec = out;
  for (const k of ks.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Spec;
  }
  const last = ks[ks.length - 1]!;
  if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0 && path !== "egress.allow" && path !== "grants.send")) delete cur[last];
  else cur[last] = v;
  return out;
}

// ---- form ----------------------------------------------------------------------------------------------------------

function AcForm({ draft, setDraft, inherited, creds, acNames, svcNames, isDefaults }: { draft: Spec; setDraft: (s: Spec) => void; inherited: Spec; creds: CredentialRow[]; acNames: string[]; svcNames: string[]; isDefaults: boolean }) {
  const f = (path: string) => get(draft, path);
  const inh = (path: string) => get(inherited, path);
  const put = (path: string, v: unknown) => setDraft(set(draft, path, v));
  const str = (path: string) => (f(path) as string | undefined) ?? "";
  const ph = (path: string, fallback = "") => {
    const v = inh(path);
    return v === undefined ? fallback : `${Array.isArray(v) ? v.join(", ") : String(v)} (default)`;
  };
  const harnessKind = (f("harness.kind") ?? inh("harness.kind") ?? "claude-code") as string;
  const files = (f("files") as Record<string, string> | undefined) ?? {};
  const [openFile, setOpenFile] = useState<string | null>(null);
  const seccomp = f("security.seccomp") as { syscalls?: unknown[] } | undefined;
  const fileInput = useRef<HTMLInputElement>(null);
  const credNames = creds.map((c) => c.name);

  return (
    <div>
      {!isDefaults && (
        <Field label="Instructions" help={`→ ${harnessKind === "codex" ? "AGENTS.md" : "CLAUDE.md"} on the home drive. Edits land at the next idle moment; the session continues.`}>
          <textarea className="textarea mono" rows={9} style={{ width: "100%" }} placeholder="You are … (its standing role and protocol)" value={str("instructions")} onChange={(e) => put("instructions", e.target.value)} />
        </Field>
      )}
      {!isDefaults && (
        <Field label="Files" help="More text files for its home, by path (skills, .mcp.json, scripts). At most 1 MiB with the instructions.">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.keys(files).map((p) => (
              <div key={p}>
                <div className="row">
                  <button className="btn sm ghost mono" onClick={() => setOpenFile(openFile === p ? null : p)}>
                    {openFile === p ? "▾" : "▸"} {p}
                  </button>
                  <span className="faint">{files[p]!.length} chars</span>
                  <div className="grow" />
                  <button
                    className="btn sm ghost danger"
                    onClick={() => {
                      const next = { ...files };
                      delete next[p];
                      put("files", Object.keys(next).length ? next : undefined);
                    }}
                  >
                    remove
                  </button>
                </div>
                {openFile === p && <textarea className="textarea mono" rows={8} style={{ width: "100%", marginTop: 4 }} value={files[p]} onChange={(e) => put("files", { ...files, [p]: e.target.value })} />}
              </div>
            ))}
            <div>
              <button
                className="btn sm"
                onClick={() => {
                  const p = prompt("Path in the home drive, like .claude/skills/crm/SKILL.md");
                  if (p) {
                    put("files", { ...files, [p]: "" });
                    setOpenFile(p);
                  }
                }}
              >
                + add file
              </button>
            </div>
          </div>
        </Field>
      )}
      <Field label="Harness">
        <div className="row wrap">
          <select className="select" value={str("harness.kind")} onChange={(e) => put("harness.kind", e.target.value || undefined)}>
            <option value="">{inh("harness.kind") ? `${inh("harness.kind")} (default)` : "choose…"}</option>
            <option value="claude-code">claude-code</option>
            <option value="codex">codex</option>
          </select>
          <input className="input mono" style={{ width: 150 }} placeholder={ph("harness.version", "version")} value={str("harness.version")} onChange={(e) => put("harness.version", e.target.value || undefined)} />
          <input className="input mono" style={{ width: 170 }} placeholder={ph("harness.model", "model: haiku, sonnet, opus…")} value={str("harness.model")} onChange={(e) => put("harness.model", e.target.value || undefined)} />
        </div>
      </Field>
      <Field label="Image" help="slim, or your image built FROM ghcr.io/coltonkirsten/a12s/slim">
        <input className="input mono" style={{ width: 340 }} placeholder={ph("image", "slim")} value={str("image")} onChange={(e) => put("image", e.target.value || undefined)} />
      </Field>
      <Field label="Credentials" help="By name. Values are set on the Credentials page and never read back.">
        <Chips
          value={f("credentials") as string[] | undefined}
          inherited={inh("credentials") as string[] | undefined}
          onChange={(v) => put("credentials", v)}
          suggest={credNames}
          render={(n) => {
            const c = creds.find((x) => x.name === n);
            return (
              <>
                {n} {c?.set ? <span className="ok-t">✓</span> : <span className="err-t" title="no value set">✕</span>}
              </>
            );
          }}
          placeholder="anthropic"
        />
      </Field>
      <Field label="Egress" help="HTTPS hosts it may reach; the harness's own API and sign-in hosts are always added. &quot;*&quot; allows every public host.">
        <Chips value={f("egress.allow") as string[] | undefined} inherited={inh("egress.allow") as string[] | undefined} onChange={(v) => put("egress", v === undefined ? undefined : { allow: v })} placeholder="github.com" />
      </Field>
      <Field label="Send to" help="Agent computers it may message (adds the mcp__a12s__send tool). One-way.">
          <Chips value={f("grants.send") as string[] | undefined} inherited={inh("grants.send") as string[] | undefined} onChange={(v) => put("grants", v === undefined ? undefined : { ...((f("grants") as Spec) ?? {}), send: v })} suggest={acNames} placeholder="agent computer" />
        </Field>
      <Field label="Uses" help="Services whose ports it may reach; an MCP port becomes a tool.">
        <Chips value={f("uses") as string[] | undefined} inherited={inh("uses") as string[] | undefined} onChange={(v) => put("uses", v)} suggest={svcNames} placeholder="service" />
      </Field>
      <Field label="Power" help="Sleeps after this much idle time; wakes when a Message arrives via one of these.">
        <div className="row wrap">
          <span className="faint">sleep after</span>
          <input className="input mono" style={{ width: 90 }} placeholder={ph("power.sleepAfterIdle", "never")} value={str("power.sleepAfterIdle")} onChange={(e) => put("power.sleepAfterIdle", e.target.value || undefined)} />
          <span className="faint">wake on</span>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Chips value={f("power.wakeOnMessage.from") as string[] | undefined} inherited={inh("power.wakeOnMessage.from") as string[] | undefined} onChange={(v) => put("power.wakeOnMessage.from", v)} placeholder="local, computer:lead, service:clock" />
          </div>
        </div>
      </Field>
      <Field label="Resources">
        <div className="row wrap">
          <span className="faint">cpu</span>
          <input className="input mono" style={{ width: 70 }} placeholder={ph("resources.cpu", "2")} value={String(f("resources.cpu") ?? "")} onChange={(e) => put("resources.cpu", e.target.value || undefined)} />
          <span className="faint">memory</span>
          <input className="input mono" style={{ width: 90 }} placeholder={ph("resources.memory", "4Gi")} value={String(f("resources.memory") ?? "")} onChange={(e) => put("resources.memory", e.target.value || undefined)} />
          <span className="faint">home</span>
          <input className="input mono" style={{ width: 90 }} placeholder={ph("home.size", "10Gi")} value={String(f("home.size") ?? "")} onChange={(e) => put("home.size", e.target.value || undefined)} />
        </div>
      </Field>
      <Field label="Autonomy">
        <select className="select" value={str("autonomy")} onChange={(e) => put("autonomy", e.target.value || undefined)}>
          <option value="">{inh("autonomy") ? `${inh("autonomy")} (default)` : "full (default)"}</option>
          <option value="full">full: runs any command on its own computer</option>
          <option value="restricted">restricted: every permission request is denied</option>
        </select>
      </Field>
      <Field label="Seccomp" help="A Docker-format profile replacing Docker's default, for software that needs blocked syscalls (Chromium's sandbox).">
        <div className="row">
          {seccomp ? (
            <span>
              custom profile <span className="faint">({Array.isArray(seccomp.syscalls) ? `${seccomp.syscalls.length} syscall rules` : "JSON"})</span>
            </span>
          ) : (
            <span className="muted">{inh("security.seccomp") ? "custom (default)" : "Docker default"}</span>
          )}
          <button className="btn sm" onClick={() => fileInput.current?.click()}>
            Upload JSON
          </button>
          {seccomp && (
            <button className="btn sm ghost danger" onClick={() => put("security", undefined)}>
              Clear
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                put("security", { seccomp: JSON.parse(await file.text()) });
              } catch {
                alert(`${file.name} isn't JSON`);
              }
              e.target.value = "";
            }}
          />
        </div>
      </Field>
      <Field label="Inbox" help="Limits for queued Messages; intro is prepended to each delivery.">
        <div className="row wrap">
          <span className="faint">max messages</span>
          <input className="input mono" style={{ width: 70 }} placeholder={ph("inbox.maxMessages", "200")} value={String(f("inbox.maxMessages") ?? "")} onChange={(e) => put("inbox.maxMessages", e.target.value ? Number(e.target.value) : undefined)} />
          <span className="faint">max bytes</span>
          <input className="input mono" style={{ width: 80 }} placeholder={ph("inbox.maxBytes", "320Ki")} value={str("inbox.maxBytes")} onChange={(e) => put("inbox.maxBytes", e.target.value || undefined)} />
        </div>
      </Field>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
        {isDefaults ? "Maps merge and lists replace when an agent computer sets its own." : "Grey = filled in from Defaults. Type to override; clear to inherit again."}
      </div>
    </div>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div>
        {children}
        {help && <div className="help">{help}</div>}
      </div>
    </div>
  );
}

function Chips({ value, inherited, onChange, suggest, render, placeholder }: { value?: string[]; inherited?: string[]; onChange: (v: string[] | undefined) => void; suggest?: string[]; render?: (s: string) => ReactNode; placeholder?: string }) {
  const [text, setText] = useState("");
  const id = useMemo(() => `dl-${Math.random().toString(36).slice(2)}`, []);
  const own = value !== undefined;
  const items = value ?? [];
  const add = (s: string) => {
    s = s.trim().replace(/,$/, "");
    if (!s) return;
    if (!items.includes(s)) onChange([...items, s]);
    setText("");
  };
  return (
    <div className="chipbox">
      {!own &&
        (inherited ?? []).map((s) => (
          <span key={s} className="chip inherited" title="from Defaults">
            {render ? render(s) : s}
          </span>
        ))}
      {items.map((s) => (
        <span key={s} className="chip">
          {render ? render(s) : s}
          <button aria-label={`remove ${s}`} onClick={() => onChange(items.filter((x) => x !== s).length || inherited ? items.filter((x) => x !== s) : undefined)}>
            ×
          </button>
        </span>
      ))}
      {own && items.length === 0 && <span className="faint" style={{ fontSize: 12 }}>none (overrides the default)</span>}
      <input
        className="chip-input"
        list={suggest ? id : undefined}
        value={text}
        placeholder={!own && inherited?.length ? "type to override…" : items.length ? "" : placeholder}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && items.length) onChange(items.slice(0, -1));
        }}
        onBlur={() => add(text)}
      />
      {own && inherited && (
        <button className="btn sm ghost" title="Inherit from Defaults again" onClick={() => onChange(undefined)}>
          reset
        </button>
      )}
      {suggest && (
        <datalist id={id}>
          {suggest.filter((s) => !items.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

function YamlField({ value, onChange }: { value: Spec; onChange: (s: Spec) => void }) {
  const [text, setText] = useState(() => YAML.stringify(value, { lineWidth: 0 }));
  const [err, setErr] = useState<string | null>(null);
  const last = useRef(JSON.stringify(value));
  useEffect(() => {
    // the form (or a reload) changed it: show the new YAML unless it is what we just parsed
    if (JSON.stringify(value) !== last.current) {
      setText(YAML.stringify(value, { lineWidth: 0 }));
      last.current = JSON.stringify(value);
    }
  }, [value]);
  return (
    <div>
      <textarea
        className="textarea mono"
        spellCheck={false}
        style={{ width: "100%", minHeight: 460, tabSize: 2 }}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = (YAML.parse(e.target.value) ?? {}) as Spec;
            if (typeof v !== "object" || Array.isArray(v)) throw new Error("the spec is a map of fields");
            setErr(null);
            last.current = JSON.stringify(v);
            onChange(v);
          } catch (x) {
            setErr(x instanceof Error ? x.message.split("\n")[0]! : String(x));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            e.preventDefault();
            const t = e.currentTarget;
            const s = t.selectionStart;
            t.setRangeText("  ", s, t.selectionEnd, "end");
            setText(t.value);
          }
        }}
      />
      {err ? <div className="err-t" style={{ fontSize: 12, marginTop: 4 }}>YAML: {err}</div> : <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>Same fields as fleet.yaml. Checked against the Controller as you type.</div>}
    </div>
  );
}
