import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { LEAD_STATUSES, LEAD_STATUS_LABEL, PIPELINE_COLUMNS } from "@/lib/constants";
import { fmtMoney } from "@/lib/kpi";
import { Badge, Card, EmptyState, LinkButton, PageHeader, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextField } from "@/components/forms";
import { LevelBadge } from "@/components/lead-badges";
import { addTaskAction, changeStatusAction, toggleTaskAction } from "../leads/actions";

export const metadata: Metadata = { title: "CRM" };
const PER_COL = 30;

export default async function CrmPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const view = ["customers", "tasks"].includes(sp.view ?? "") ? sp.view! : "pipeline";
  const cur = ctx.workspace.currency;

  return (
    <>
      <PageHeader title="CRM" subtitle="Pipeline commercial : Lead → Qualifié → Contacté → Proposition → Gagné / Perdu." actions={ctx.can("write") ? <LinkButton href="/leads?new=1#nouveau" variant="secondary">Ajouter un lead</LinkButton> : undefined} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Vues du CRM">
        {[["pipeline", "Pipeline"], ["customers", "Clients"], ["tasks", "Tâches"]].map(([v, l]) => <LinkButton key={v} href={`/crm?view=${v}`} size="sm" variant={view === v ? "primary" : "secondary"} aria-current={view === v ? "page" : undefined}>{l}</LinkButton>)}
      </nav>
      {view === "pipeline" && <Pipeline workspaceId={ctx.workspaceId} cur={cur} canWrite={ctx.can("write")} />}
      {view === "customers" && <Customers workspaceId={ctx.workspaceId} cur={cur} />}
      {view === "tasks" && <Tasks workspaceId={ctx.workspaceId} canWrite={ctx.can("write")} />}
    </>
  );
}

async function Pipeline({ workspaceId, cur, canWrite }: { workspaceId: string; cur: string; canWrite: boolean }) {
  const cols = await Promise.all(PIPELINE_COLUMNS.map(async (status) => ({
    status,
    total: await db.lead.count({ where: { workspaceId, status, deletedAt: null } }),
    leads: await db.lead.findMany({ where: { workspaceId, status, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: PER_COL, include: { campaign: { select: { name: true } } } }),
  })));
  const disq = await db.lead.count({ where: { workspaceId, status: "disqualified", deletedAt: null } });
  const all = cols.reduce((s, c) => s + c.total, 0);
  if (all === 0 && disq === 0) return <EmptyState title="Votre pipeline est vide" action={<LinkButton href="/landing-pages">Publier une landing page</LinkButton>}>Les nouveaux leads apparaissent dans la colonne « Nouveau ».</EmptyState>;
  return (
    <>
      <div className="relative grid auto-cols-[minmax(16rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-3" role="region" aria-label="Pipeline commercial" tabIndex={0}>
        {cols.map((c) => (
          <section key={c.status} aria-label={LEAD_STATUS_LABEL[c.status]} className="rounded-xl border border-slate-200 bg-slate-100/70 p-2">
            <h2 className="flex items-center justify-between px-1 py-1 text-sm font-semibold">{c.status === "new" ? "Lead" : LEAD_STATUS_LABEL[c.status]}<Badge>{c.total}</Badge></h2>
            <ul className="space-y-2">
              {c.leads.map((l) => (
                <li key={l.id}><Card as="article" className="!p-3 text-sm">
                  <Link href={`/leads/${l.id}`} className="font-semibold text-brand-700 underline">{l.name}</Link>
                  <p className="truncate text-xs text-slate-500">{l.company ?? l.email ?? l.phone}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1"><LevelBadge level={l.qualificationLevel} score={l.score} />{l.value ? <Badge tone="green">{fmtMoney(l.value, cur)}</Badge> : null}</div>
                  <p className="mt-1 truncate text-xs text-slate-500">{l.campaign?.name ?? "Sans campagne"} · {fmtDate(l.createdAt)}</p>
                  {canWrite && (
                    <details className="mt-2"><summary className="cursor-pointer text-xs font-medium text-brand-700">Déplacer</summary>
                      <ActionForm action={changeStatusAction} className="mt-2 !space-y-2"><input type="hidden" name="id" value={l.id} />
                        <SelectField name="status" label="Nouveau statut" required defaultValue={l.status} options={LEAD_STATUSES.map((s) => [s, LEAD_STATUS_LABEL[s]] as const)} />
                        <TextField name="value" label="Montant (si gagné)" type="number" min={0} step="0.01" defaultValue={l.value} />
                        <SubmitButton size="sm" variant="secondary">Valider</SubmitButton></ActionForm></details>
                  )}
                </Card></li>
              ))}
              {c.leads.length === 0 && <li className="px-1 py-3 text-xs text-slate-500">Aucun lead.</li>}
            </ul>
            {c.total > PER_COL && <p className="mt-2 px-1 text-xs text-slate-500">{c.total - PER_COL} autre(s) : <Link href={`/leads?status=${c.status}`} className="underline">voir la liste</Link></p>}
          </section>
        ))}
      </div>
      {disq > 0 && <p className="text-sm text-slate-600">{disq} lead(s) disqualifié(s) — <Link href="/leads?status=disqualified" className="underline">voir</Link></p>}
    </>
  );
}

async function Customers({ workspaceId, cur }: { workspaceId: string; cur: string }) {
  const customers = await db.customer.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 100, include: { campaign: { select: { name: true } }, leads: { select: { id: true }, take: 1 } } });
  if (!customers.length) return <EmptyState title="Aucun client">Un lead passé à « Gagné » devient automatiquement un client.</EmptyState>;
  const total = customers.reduce((s, c) => s + c.revenue, 0);
  return (
    <>
      <p className="mb-2 text-sm text-slate-600">{customers.length} client(s) · revenu total attribué : <strong>{fmtMoney(total, cur)}</strong></p>
      <TableWrap caption="Clients"><thead><tr><Th>Client</Th><Th>Contact</Th><Th>Campagne d'origine</Th><Th className="text-right">Revenu</Th><Th>Depuis</Th></tr></thead>
        <tbody>{customers.map((c) => <tr key={c.id}><Td>{c.leads[0] ? <Link href={`/leads/${c.leads[0].id}`} className="font-medium text-brand-700 underline">{c.name}</Link> : c.name}<div className="text-xs text-slate-500">{c.company}</div></Td><Td>{c.email ?? c.phone ?? "—"}</Td><Td>{c.campaign?.name ?? "—"}</Td><Td className="text-right tabular-nums">{c.revenue ? fmtMoney(c.revenue, cur) : "—"}</Td><Td>{fmtDate(c.createdAt)}</Td></tr>)}</tbody></TableWrap>
    </>
  );
}

async function Tasks({ workspaceId, canWrite }: { workspaceId: string; canWrite: boolean }) {
  const tasks = await db.task.findMany({ where: { workspaceId }, orderBy: [{ status: "asc" }, { dueAt: "asc" }], take: 100, include: { lead: { select: { id: true, name: true } } } });
  const open = tasks.filter((t) => t.status === "open");
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {tasks.length === 0 ? <EmptyState title="Aucune tâche">Les tâches de relance et vos propres tâches apparaissent ici.</EmptyState> : (
          <>
            <p className="mb-2 text-sm text-slate-600">{open.length} tâche(s) ouverte(s)</p>
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0"><p className={t.status === "done" ? "text-slate-400 line-through" : "font-medium"}>{t.title}</p>
                    <p className="text-xs text-slate-500">{t.lead ? <Link href={`/leads/${t.lead.id}`} className="underline">{t.lead.name}</Link> : "Sans prospect"}{t.dueAt ? ` · échéance ${fmtDate(t.dueAt)}` : ""}{t.source === "followup" ? " · relance auto" : ""}</p>
                    {t.description && <p className="mt-1 whitespace-pre-line text-xs text-slate-600">{t.description}</p>}</div>
                  {canWrite && <InlineAction action={toggleTaskAction} variant="ghost" hidden={{ id: t.id }}>{t.status === "done" ? "Rouvrir" : "Terminer"}</InlineAction>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {canWrite && <Card><h2 className="mb-3 text-base font-semibold">Nouvelle tâche</h2><ActionForm action={addTaskAction} resetOnSuccess><TextField name="title" label="Titre" required /><TextField name="dueAt" label="Échéance" type="date" /><SubmitButton>Ajouter</SubmitButton></ActionForm></Card>}
    </div>
  );
}
