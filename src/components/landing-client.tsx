"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FormField } from "@/lib/landing";

type Utm = { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
const KEY = "sp_utm";

/** Lit les UTM de l'URL et les conserve pour la session (première touche) afin qu'ils suivent le visiteur jusqu'au formulaire. */
function readUtm(): Utm {
  const out: Utm = {};
  try {
    const q = new URLSearchParams(window.location.search);
    for (const k of ["source", "medium", "campaign", "term", "content"] as const) { const v = q.get(`utm_${k}`); if (v) out[k] = v.slice(0, 200); }
    if (Object.keys(out).length) { sessionStorage.setItem(KEY, JSON.stringify(out)); return out; }
    const saved = sessionStorage.getItem(KEY);
    if (saved) return JSON.parse(saved) as Utm;
  } catch { /* stockage indisponible : on continue sans */ }
  return out;
}

function sessionId(): string | undefined {
  try {
    let s = sessionStorage.getItem("sp_sid");
    if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem("sp_sid", s); }
    return s;
  } catch { return undefined; }
}

function send(pageId: string, type: "page_view" | "cta_click") {
  const body = JSON.stringify({ pageId, type, sessionId: sessionId(), path: window.location.pathname, referrer: document.referrer || undefined, utm: readUtm() });
  try { fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => undefined); } catch { /* mesure non bloquante */ }
}

export function TrackView({ pageId, enabled }: { pageId: string; enabled: boolean }) {
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current) return;
    done.current = true;
    send(pageId, "page_view");
  }, [pageId, enabled]);
  return null;
}

export function CtaLink({ pageId, href, className, children, enabled }: { pageId: string; href: string; className?: string; children: ReactNode; enabled: boolean }) {
  return <a href={href} className={className} onClick={() => enabled && send(pageId, "cta_click")}>{children}</a>;
}

export function LeadForm({ formId, fields, consentText, primary, preview }: { formId: string; fields: FormField[]; consentText: string; primary: string; preview?: boolean }) {
  const [state, setState] = useState<{ status: "idle" | "sending" | "done" | "error"; message?: string; errors?: Record<string, string> }>({ status: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (preview) { setState({ status: "error", message: "Aperçu : l'envoi est désactivé." }); return; }
    const fd = new FormData(e.currentTarget);
    const values: Record<string, string> = {};
    for (const f of fields) values[f.key] = String(fd.get(f.key) ?? "");
    setState({ status: "sending" });
    try {
      const res = await fetch("/api/public/leads", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ formId, values, consent: fd.get("consent") === "on", hp: String(fd.get("website") ?? ""), utm: readUtm(), referrer: document.referrer || undefined, landingUrl: window.location.href.split("?")[0] }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string; fieldErrors?: Record<string, string>; redirectUrl?: string };
      if (res.ok && j.ok) {
        setState({ status: "done", message: j.message });
        if (j.redirectUrl && /^https?:\/\//.test(j.redirectUrl)) window.location.href = j.redirectUrl;
      } else setState({ status: "error", message: j.error ?? "Une erreur est survenue.", errors: j.fieldErrors });
    } catch { setState({ status: "error", message: "Connexion impossible. Vérifiez votre réseau et réessayez." }); }
  }

  if (state.status === "done") return <div role="status" className="rounded-xl bg-emerald-50 p-5 text-center text-emerald-900"><p className="text-lg font-semibold">Merci !</p><p className="mt-1 text-sm">{state.message}</p></div>;

  const cls = "block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 aria-[invalid=true]:border-red-500";
  return (
    <form onSubmit={onSubmit} className="space-y-4 text-left" noValidate={false}>
      {state.status === "error" && state.message && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">{state.message}</p>}
      {fields.map((f) => {
        const err = state.errors?.[f.key];
        const id = `f-${f.key}`;
        return (
          <div key={f.key}>
            <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-800">{f.label}{f.required && <span aria-hidden="true"> *</span>}</label>
            {f.type === "textarea" ? <textarea id={id} name={f.key} rows={4} required={f.required} maxLength={4000} aria-invalid={!!err} className={cls} />
              : f.type === "select" ? <select id={id} name={f.key} required={f.required} aria-invalid={!!err} className={cls} defaultValue=""><option value="">—</option>{f.options?.map((o) => <option key={o} value={o}>{o}</option>)}</select>
              : <input id={id} name={f.key} type={f.type} required={f.required} maxLength={300} aria-invalid={!!err} autoComplete={f.key === "email" ? "email" : f.key === "phone" ? "tel" : f.key === "name" ? "name" : f.key === "company" ? "organization" : undefined} className={cls} />}
            {err && <p role="alert" className="mt-1 text-xs font-medium text-red-700">{err}</p>}
          </div>
        );
      })}
      {/* piège à robots : invisible pour les humains */}
      <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", height: 0, overflow: "hidden" }}><label>Site web<input type="text" name="website" tabIndex={-1} autoComplete="off" /></label></div>
      <div className="flex items-start gap-2"><input id="f-consent" type="checkbox" name="consent" className="mt-1 size-4 shrink-0" /><label htmlFor="f-consent" className="text-xs text-slate-600">{consentText}</label></div>
      <button type="submit" disabled={state.status === "sending"} style={{ background: primary }} className="min-h-12 w-full rounded-lg px-5 text-base font-semibold text-white disabled:opacity-60">{state.status === "sending" ? "Envoi…" : "Envoyer"}</button>
      <p className="text-xs text-slate-500">Vos données servent à traiter votre demande et ne sont pas revendues. Voir la <a href="/privacy" className="underline">politique de confidentialité</a>.</p>
    </form>
  );
}
