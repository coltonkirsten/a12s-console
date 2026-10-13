// Small shared pieces: a router, toasts, modals, badges, a JSON view and keyboard shortcuts.
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type MouseEvent } from "react";
import type { FleetStore } from "./store";
import { cls, phaseTone, type Tone } from "./util";

// ---- router --------------------------------------------------------------------------------------------------------

const routeEvent = "a12s-route";

export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(routeEvent));
}

function subscribeRoute(fn: () => void): () => void {
  window.addEventListener("popstate", fn);
  window.addEventListener(routeEvent, fn);
  return () => {
    window.removeEventListener("popstate", fn);
    window.removeEventListener(routeEvent, fn);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribeRoute, () => location.pathname);
}

export function Link(props: { to: string; className?: string; children: ReactNode; title?: string; onClick?: () => void }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    props.onClick?.();
    navigate(props.to);
  };
  return (
    <a href={props.to} className={props.className} onClick={onClick} title={props.title}>
      {props.children}
    </a>
  );
}

// ---- app context ---------------------------------------------------------------------------------------------------

export interface Ctx {
  store: FleetStore;
  fleet: string;
  base: string;
  toast: (msg: string, tone?: "ok" | "err") => void;
  confirm: (opts: { title: string; body?: ReactNode; ok: string; danger?: boolean }) => Promise<boolean>;
}

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("no app context");
  return c;
}

// ---- toasts --------------------------------------------------------------------------------------------------------

export interface ToastItem {
  id: number;
  msg: string;
  tone: "ok" | "err";
}

export function Toasts({ items }: { items: ToastItem[] }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={cls("toast", t.tone === "err" && "err")}>
          <span className={t.tone === "err" ? "err-t" : "ok-t"}>{t.tone === "err" ? "✕" : "✓"}</span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ---- modal ---------------------------------------------------------------------------------------------------------

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [props.onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={cls("modal", props.className)} role="dialog" aria-modal="true">
        {props.title && <div className="modal-head">{props.title}</div>}
        <div className="modal-body">{props.children}</div>
        {props.foot && <div className="modal-foot">{props.foot}</div>}
      </div>
    </div>
  );
}

// ---- badges --------------------------------------------------------------------------------------------------------

export function Pill({ tone, children, title, dot }: { tone?: Tone; children: ReactNode; title?: string; dot?: boolean }) {
  return (
    <span className={cls("pill", tone && tone !== "muted" && tone)} title={title}>
      {dot && <span className={cls("dot", tone)} />}
      {children}
    </span>
  );
}

export function PhaseBadge({ phase }: { phase?: string }) {
  const tone = phaseTone(phase);
  return (
    <span className={cls("pill", tone !== "muted" && tone)}>
      <span className={cls("dot", tone)} />
      {phase ?? "Unknown"}
    </span>
  );
}

// ---- JSON ----------------------------------------------------------------------------------------------------------

export function Json({ value, className }: { value: unknown; className?: string }) {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<span key={i++} className={m[2] ? "j-key" : "j-str"}>{m[1]}</span>, m[2] ?? "");
    else if (m[3]) parts.push(<span key={i++} className="j-lit">{m[3]}</span>);
    else parts.push(<span key={i++} className="j-num">{m[4]}</span>);
    last = re.lastIndex;
  }
  parts.push(text.slice(last));
  return <pre className={cls("json mono", className)}>{parts}</pre>;
}

/** Tool output is usually text; show it as text, anything else as JSON. */
export function Output({ value }: { value: unknown }) {
  if (typeof value === "string") return <pre className="json mono">{value || "(empty)"}</pre>;
  if (Array.isArray(value) && value.every((x) => x && typeof x === "object" && (x as { type?: string }).type === "text")) {
    return <pre className="json mono">{value.map((x) => (x as { text: string }).text).join("\n")}</pre>;
  }
  return <Json value={value} />;
}

// ---- keyboard ------------------------------------------------------------------------------------------------------

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/** Single keys and "g x" chords, ignored while typing in a field. */
export function useKeys(map: Record<string, () => void>, deps: unknown[] = []): void {
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      const k = e.key;
      if (pending.current) {
        const fn = map[`${pending.current} ${k}`];
        pending.current = null;
        if (fn) {
          e.preventDefault();
          fn();
        }
        return;
      }
      if (Object.keys(map).some((x) => x.startsWith(k + " "))) {
        pending.current = k;
        setTimeout(() => (pending.current = null), 1200);
        return;
      }
      const fn = map[k];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Re-renders every `ms` so "4m ago" and elapsed times stay true. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spin" aria-label="loading" />;
}
