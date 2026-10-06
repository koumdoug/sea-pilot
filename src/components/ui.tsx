import Link from "next/link";
import type { ReactNode } from "react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type Variant = "primary" | "secondary" | "danger" | "ghost";
export function buttonClass(variant: Variant = "primary", size: "sm" | "md" = "md") {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const sz = size === "sm" ? "min-h-9 px-3 text-sm" : "min-h-11 px-4 text-sm";
  const v: Record<Variant, string> = {
    primary: "bg-brand-600 text-white hover:bg-brand-700",
    secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50",
    danger: "bg-red-600 text-white hover:bg-red-700",
    ghost: "text-slate-700 hover:bg-slate-100",
  };
  return cx(base, sz, v[variant]);
}

export function LinkButton({ href, children, variant = "primary", size = "md", className, ...rest }: { href: string; children: ReactNode; variant?: Variant; size?: "sm" | "md"; className?: string } & Omit<React.ComponentProps<typeof Link>, "href" | "className">) {
  // Les routes /api (téléchargements, redirections OAuth) sont de simples liens : jamais préchargées ni interceptées par le routeur client.
  if (href.startsWith("/api/")) return <a href={href} className={cx(buttonClass(variant, size), className)}>{children}</a>;
  return <Link href={href} className={cx(buttonClass(variant, size), className)} {...rest}>{children}</Link>;
}

export function Card({ children, className, as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & React.HTMLAttributes<HTMLElement>) {
  return <Tag className={cx("min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5", className)} {...rest}>{children}</Tag>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const TONES = {
  gray: "bg-slate-100 text-slate-700 ring-slate-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  orange: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  blue: "bg-brand-50 text-brand-700 ring-brand-100",
  purple: "bg-violet-50 text-violet-800 ring-violet-200",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ children, tone = "gray", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone], className)}>{children}</span>;
}

export function DemoBadge({ label = "Données de démonstration" }: { label?: string }) {
  return <Badge tone="purple">{label}</Badge>;
}

export function Alert({ children, tone = "info", title, role }: { children: ReactNode; tone?: "info" | "success" | "warning" | "error"; title?: string; role?: "alert" | "status" }) {
  const t = { info: "border-brand-100 bg-brand-50 text-brand-700", success: "border-emerald-200 bg-emerald-50 text-emerald-900", warning: "border-amber-200 bg-amber-50 text-amber-900", error: "border-red-200 bg-red-50 text-red-900" }[tone];
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")} className={cx("rounded-lg border px-4 py-3 text-sm", t)}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? "mt-0.5" : ""}>{children}</div>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      {children && <div className="mx-auto mt-1.5 max-w-xl text-sm text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** État « Configuration requise » : fonctionnalité dépendant d'un service externe non configuré. Jamais de simulation. */
export function ConfigRequired({ title = "Configuration requise", children, env }: { title?: string; children?: ReactNode; env?: string[] }) {
  return (
    <Alert tone="warning" title={title}>
      {children}
      {env && env.length > 0 && <p className="mt-1">Variables serveur à définir : {env.map((e) => <code key={e} className="mx-0.5 rounded bg-white/70 px-1 py-0.5 text-xs">{e}</code>)}</p>}
    </Alert>
  );
}

export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx("mt-1 text-2xl font-bold tabular-nums", tone === "red" && "text-red-700", tone === "green" && "text-emerald-700", tone === "orange" && "text-amber-700")}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

/** Tableau utilisable sur petit écran : défilement horizontal confiné au conteneur (aucun overflow de page). */
export function TableWrap({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="relative overflow-x-auto rounded-xl border border-slate-200 bg-white" tabIndex={0} role="region" aria-label={caption ?? "Tableau de données"}>
      <table className="w-full min-w-[34rem] text-left text-sm">{caption && <caption className="sr-only">{caption}</caption>}{children}</table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => <th scope="col" className={cx("whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500", className)}>{children}</th>;
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => <td className={cx("border-b border-slate-100 px-3 py-2.5 align-top", className)}>{children}</td>;

export function Pagination({ page, pages, hrefFor }: { page: number; pages: number; hrefFor: (p: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
      {page > 1 ? <Link className={buttonClass("secondary", "sm")} href={hrefFor(page - 1)}>← Précédent</Link> : <span />}
      <span className="text-slate-600">Page {page} / {pages}</span>
      {page < pages ? <Link className={buttonClass("secondary", "sm")} href={hrefFor(page + 1)}>Suivant →</Link> : <span />}
    </nav>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0"><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="break-words text-ink">{v ?? "—"}</dd></div>
      ))}
    </dl>
  );
}

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card className="mb-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="text-lg font-semibold text-ink">{title}</h2>{description && <p className="mt-0.5 text-sm text-muted">{description}</p>}</div>
        {actions}
      </div>
      {children}
    </Card>
  );
}

export function fmtDate(d: Date | string | null | undefined, withTime = false): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), timeZone: "UTC" }).format(new Date(d));
}

export const CAMPAIGN_STATUS_TONE: Record<string, Tone> = { draft: "gray", ready: "blue", active: "green", paused: "orange", completed: "purple", archived: "gray" };
