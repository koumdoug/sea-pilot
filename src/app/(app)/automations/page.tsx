import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { parseSteps } from "@/lib/followups";
import { FOLLOWUP_ACTION_LABEL } from "@/lib/constants";
import { Alert, Badge, Card, EmptyState, PageHeader, Section, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { SequenceEditor } from "@/components/sequence-editor";
import { createDefaultSequenceAction, deleteSequenceAction, runFollowUpsNowAction, saveSequenceAction } from "./actions";

export const metadata: Metadata = { title: "Automations" };
const TONE: Record<string, Tone> = { pending: "blue", running: "orange", done: "green", skipped: "gray", cancelled: "gray", failed: "red", blocked: "orange" };
const LABEL: Record<string, string> = { pending: "Planifiée", running: "En cours", done: "Exécutée", skipped: "Ignorée", cancelled: "Annulée", failed: "Échec", blocked: "Bloquée" };

export default async function AutomationsPage() {
  const ctx = await requireCtx();
  const [seqs, upcoming, recent, email, dueNow] = await Promise.all([
    db.followUpSequence.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "asc" }, include: { _count: { select: { followUps: { where: { status: "pending" } } } } } }),
    db.followUp.findMany({ where: { workspaceId: ctx.workspaceId, status: "pending" }, orderBy: { dueAt: "asc" }, take: 15, include: { lead: { select: { id: true, name: true } }, sequence: { select: { name: true } } } }),
    db.followUp.findMany({ where: { workspaceId: ctx.workspaceId, status: { in: ["done", "blocked", "failed", "cancelled"] } }, orderBy: { executedAt: "desc" }, take: 15, include: { lead: { select: { id: true, name: true } } } }),
    db.integration.findUnique({ where: { workspaceId_provider: { workspaceId: ctx.workspaceId, provider: "email" } } }),
    db.followUp.count({ where: { workspaceId: ctx.workspaceId, status: "pending", dueAt: { lte: new Date() } } }),
  ]);
  const emailReady = email?.status === "connected";

  return (
    <>
      <PageHeader title="Automatisations" subtitle="Séquences de relance (e-mail, tâche, rappel, changement de statut). Arrêt automatique dès qu'un prospect devient client, est perdu, disqualifié ou se désinscrit."
        actions={ctx.can("write") ? <><InlineAction action={runFollowUpsNowAction} size="md" variant="secondary">Exécuter les relances échues{dueNow ? ` (${dueNow})` : ""}</InlineAction></> : undefined} />
      <div className="mb-5 space-y-3">
        <Alert tone={emailReady ? "success" : "warning"} title={emailReady ? "E-mail connecté" : "Envoi d'e-mails : configuration requise"}>{emailReady ? `Les e-mails des séquences autorisées partent de ${email?.accountName}, uniquement vers les prospects ayant consenti.` : <>Aucun fournisseur d'e-mail n'est connecté : les étapes e-mail créent des tâches manuelles. <Link href="/integrations" className="underline">Connecter l'e-mail</Link></>}</Alert>
        <Alert tone="info">Les relances échues sont exécutées automatiquement par la tâche planifiée <code>/api/cron/followups</code> (voir README) ou manuellement avec le bouton ci-dessus. Aucun e-mail n'est jamais envoyé sans consentement du prospect ni configuration explicite.</Alert>
      </div>

      {seqs.length === 0 && ctx.can("write") && (
        <EmptyState title="Aucune séquence" action={<InlineAction action={createDefaultSequenceAction} variant="primary" size="md">Créer la séquence recommandée</InlineAction>}>Jour 0 · 1 · 3 · 7 · 14 : accusé de réception, appel, relance, rappel et clôture automatique.</EmptyState>
      )}
      <div className="space-y-4">
        {seqs.map((s) => (
          <Card key={s.id}>
            <details>
              <summary className="flex cursor-pointer flex-wrap items-center gap-2"><span className="text-base font-semibold">{s.name}</span><Badge tone={s.active ? "green" : "gray"}>{s.active ? "Active" : "Inactive"}</Badge>{s.autoEnroll && <Badge tone="blue">Inscription auto</Badge>}<Badge tone={s.sendEmails ? "orange" : "gray"}>{s.sendEmails ? "Envoi e-mail réel autorisé" : "E-mails : tâches manuelles"}</Badge><span className="text-xs text-slate-500">{s._count.followUps} en attente</span></summary>
              <div className="mt-4">
                <ol className="mb-4 space-y-1 text-sm">{parseSteps(s.steps).map((st, i) => <li key={i}><strong>J+{st.day}</strong> — {FOLLOWUP_ACTION_LABEL[st.action]} : {st.subject ?? st.title ?? st.status}</li>)}</ol>
                {ctx.can("write") ? <SequenceEditor action={saveSequenceAction} emailReady={emailReady} seq={{ id: s.id, name: s.name, description: s.description, active: s.active, autoEnroll: s.autoEnroll, sendEmails: s.sendEmails, steps: parseSteps(s.steps) }} /> : null}
                {ctx.can("delete") && <div className="mt-3"><InlineAction action={deleteSequenceAction} variant="danger" hidden={{ id: s.id }} confirm="Supprimer cette séquence et annuler ses relances en attente ?">Supprimer</InlineAction></div>}
              </div>
            </details>
          </Card>
        ))}
      </div>
      {ctx.can("write") && <div className="mt-4"><Section title="Nouvelle séquence"><SequenceEditor action={saveSequenceAction} emailReady={emailReady} /></Section></div>}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <section><h2 className="mb-2 text-base font-semibold">À venir</h2>
          {upcoming.length === 0 ? <p className="text-sm text-slate-500">Aucune relance planifiée.</p> : <TableWrap caption="Relances planifiées"><thead><tr><Th>Prospect</Th><Th>Action</Th><Th>Échéance</Th></tr></thead><tbody>{upcoming.map((f) => <tr key={f.id}><Td><Link href={`/leads/${f.lead.id}`} className="text-brand-700 underline">{f.lead.name}</Link><div className="text-xs text-slate-500">{f.sequence?.name}</div></Td><Td>{FOLLOWUP_ACTION_LABEL[f.action]}</Td><Td>{fmtDate(f.dueAt)}</Td></tr>)}</tbody></TableWrap>}
        </section>
        <section><h2 className="mb-2 text-base font-semibold">Journal d'exécution</h2>
          {recent.length === 0 ? <p className="text-sm text-slate-500">Aucune exécution.</p> : <TableWrap caption="Exécutions récentes"><thead><tr><Th>Prospect</Th><Th>Statut</Th><Th>Résultat</Th></tr></thead><tbody>{recent.map((f) => <tr key={f.id}><Td><Link href={`/leads/${f.lead.id}`} className="text-brand-700 underline">{f.lead.name}</Link><div className="text-xs text-slate-500">{FOLLOWUP_ACTION_LABEL[f.action]} · {fmtDate(f.executedAt, true)}</div></Td><Td><Badge tone={TONE[f.status]}>{LABEL[f.status]}</Badge></Td><Td className="text-xs">{f.result}</Td></tr>)}</tbody></TableWrap>}
        </section>
      </div>
    </>
  );
}
