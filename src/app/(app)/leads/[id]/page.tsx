import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import { LEAD_STATUSES, LEAD_STATUS_LABEL, FOLLOWUP_ACTION_LABEL } from "@/lib/constants";
import type { CriterionResult } from "@/lib/scoring";
import { Alert, Badge, Card, KeyValue, PageHeader, Section, fmtDate } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { LevelBadge, StatusBadge } from "@/components/lead-badges";
import { addConversationAction, addTaskAction, cancelFollowUpsAction, changeStatusAction, enrollSequenceAction, eraseLeadAction, qualifyAction, toggleTaskAction, unsubscribeAction, updateLeadAction } from "../actions";

export const metadata: Metadata = { title: "Fiche prospect" };

const BASIS: Record<string, { label: string; tone: "green" | "purple" | "gray" }> = { fact: { label: "Fait fourni", tone: "green" }, inference: { label: "Inférence", tone: "purple" }, missing: { label: "Manquant", tone: "gray" } };
const ACTIVITY: Record<string, string> = { created: "Lead créé", status_changed: "Changement de statut", qualified: "Qualification", note: "Note / échange", task: "Tâche", followup: "Séquence de relance", email: "E-mail envoyé", consent: "Consentement", unsubscribed: "Désinscription" };

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const lead = await db.lead.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    include: {
      campaign: { select: { id: true, name: true } }, landingPage: { select: { id: true, name: true } }, customer: { select: { id: true } },
      qualifications: { orderBy: { createdAt: "desc" }, take: 1 }, conversations: { orderBy: { createdAt: "desc" } }, activities: { orderBy: { createdAt: "desc" }, take: 50 },
      tasks: { orderBy: [{ status: "asc" }, { createdAt: "desc" }] }, followUps: { orderBy: { dueAt: "asc" }, include: { sequence: { select: { name: true } } } },
    },
  });
  if (!lead) notFound();
  const sequences = await db.followUpSequence.findMany({ where: { workspaceId: ctx.workspaceId, active: true }, orderBy: { name: "asc" } });
  const q = lead.qualifications[0];
  const criteria = (q?.criteria ?? []) as unknown as CriterionResult[];
  const ai = providerStatus();
  const cf = (lead.customFields ?? {}) as Record<string, unknown>;
  const canWrite = ctx.can("write");
  const pending = lead.followUps.filter((f) => f.status === "pending");

  return (
    <>
      <PageHeader title={lead.name} subtitle={<><Link href="/leads" className="underline">← Leads</Link> · <StatusBadge status={lead.status} /> · <LevelBadge level={lead.qualificationLevel} score={lead.score} /> · reçu le {fmtDate(lead.createdAt, true)}</>} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title="Coordonnées">
            {canWrite ? (
              <ActionForm action={updateLeadAction}>
                <input type="hidden" name="id" value={lead.id} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField name="name" label="Nom" required defaultValue={lead.name} /><TextField name="company" label="Entreprise" defaultValue={lead.company} />
                  <TextField name="email" label="E-mail" type="email" defaultValue={lead.email} /><TextField name="phone" label="Téléphone" type="tel" defaultValue={lead.phone} />
                  <TextField name="value" label={`Valeur de l'affaire (${ctx.workspace.currency})`} type="number" min={0} step="0.01" defaultValue={lead.value} help="Utilisée comme revenu attribué lorsque le lead est gagné." />
                </div>
                <SubmitButton>Enregistrer</SubmitButton>
              </ActionForm>
            ) : <KeyValue items={[["E-mail", lead.email], ["Téléphone", lead.phone], ["Entreprise", lead.company]]} />}
            {lead.message && <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm"><p className="text-xs font-semibold uppercase text-slate-500">Message du prospect</p><p className="mt-1 whitespace-pre-line">{lead.message}</p></div>}
            {Object.keys(cf).length > 0 && <div className="mt-3"><KeyValue items={Object.entries(cf).map(([k, v]) => [k, String(v)] as [string, string])} /></div>}
          </Section>

          <Section title="Qualification" description="Évaluation selon vos critères configurables (Réglages → Qualification). Les faits fournis par le prospect sont séparés des inférences." actions={q && <Badge tone={q.method === "rules" ? "blue" : "purple"}>{q.method === "rules" ? "Règles" : "Règles + IA"}</Badge>}>
            {canWrite && (
              <div className="mb-4 flex flex-wrap gap-2">
                <InlineAction action={qualifyAction} size="md" variant="primary" hidden={{ id: lead.id }}>{q ? "Requalifier" : "Qualifier"}</InlineAction>
                {ai.configured && ctx.can("ai") && <InlineAction action={qualifyAction} size="md" hidden={{ id: lead.id, ai: "1" }}>Qualifier avec l'IA</InlineAction>}
                {!ai.configured && <span className="self-center text-xs text-slate-500">Analyse IA : configuration requise côté serveur.</span>}
              </div>
            )}
            {!q ? <p className="text-sm text-slate-500">Ce lead n'a pas encore été qualifié.</p> : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3"><span className="text-4xl font-extrabold tabular-nums">{q.score}<span className="text-lg font-medium text-slate-500">/100</span></span><LevelBadge level={q.level} /><span className="text-xs text-slate-500">{fmtDate(q.createdAt, true)}{q.model ? ` · ${q.model}` : ""}</span></div>
                <div className="rounded-lg border border-brand-100 bg-brand-50 p-3 text-sm"><p className="font-semibold text-brand-700">Prochaine action recommandée</p><p>{q.nextAction}</p></div>
                <div className="relative overflow-x-auto"><table className="w-full min-w-[30rem] text-sm"><caption className="sr-only">Détail par critère</caption>
                  <thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-2">Critère</th><th className="py-1 pr-2">Poids</th><th className="py-1 pr-2">Valeur</th><th className="py-1 pr-2">Base</th><th className="py-1">Justification</th></tr></thead>
                  <tbody>{criteria.map((c) => <tr key={c.key} className="border-t border-slate-100 align-top"><td className="py-1.5 pr-2 font-medium">{c.label}</td><td className="py-1.5 pr-2">{c.weight}</td><td className="py-1.5 pr-2 tabular-nums">{c.value === null ? "—" : `${Math.round(c.value * 100)} %`}</td><td className="py-1.5 pr-2"><Badge tone={BASIS[c.basis].tone}>{BASIS[c.basis].label}</Badge></td><td className="py-1.5">{c.evidence}</td></tr>)}</tbody></table></div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div><h3 className="text-sm font-semibold">Faits fournis par le prospect</h3><ul className="mt-1 list-disc pl-5 text-sm">{(q.facts as string[]).map((f) => <li key={f}>{f}</li>)}</ul></div>
                  <div><h3 className="text-sm font-semibold">Inférences (non vérifiées)</h3>{(q.inferences as string[]).length ? <ul className="mt-1 list-disc pl-5 text-sm text-violet-900">{(q.inferences as string[]).map((f) => <li key={f}>{f}</li>)}</ul> : <p className="text-sm text-slate-500">Aucune.</p>}</div>
                </div>
                {(q.missingInfo as string[]).length > 0 && <div><h3 className="text-sm font-semibold">Informations manquantes</h3><ul className="mt-1 list-disc pl-5 text-sm">{(q.missingInfo as string[]).map((f) => <li key={f}>{f}</li>)}</ul></div>}
              </div>
            )}
          </Section>

          <Section title="Échanges et notes">
            {canWrite && (
              <ActionForm action={addConversationAction} resetOnSuccess className="mb-4">
                <input type="hidden" name="id" value={lead.id} />
                <div className="grid gap-3 sm:grid-cols-3">
                  <SelectField name="channel" label="Type" required defaultValue="note" options={[["note", "Note interne"], ["call", "Appel"], ["email", "E-mail"], ["sms", "SMS"], ["meeting", "Rendez-vous"], ["chat", "Chat"]]} />
                  <SelectField name="direction" label="Sens" defaultValue="internal" options={[["internal", "Interne"], ["outbound", "Sortant"], ["inbound", "Entrant"]]} />
                  <TextField name="subject" label="Objet (optionnel)" />
                </div>
                <TextAreaField name="body" label="Contenu" required rows={3} help="Un échange sortant fait passer un lead « Nouveau » à « Contacté ». Rien n'est envoyé au prospect : ceci consigne un échange déjà réalisé." />
                <SubmitButton>Ajouter</SubmitButton>
              </ActionForm>
            )}
            {lead.conversations.length === 0 ? <p className="text-sm text-slate-500">Aucun échange enregistré.</p> : (
              <ul className="space-y-3">{lead.conversations.map((c) => <li key={c.id} className="rounded-lg border border-slate-200 p-3 text-sm"><p className="flex flex-wrap items-center gap-2 text-xs text-slate-500"><Badge>{c.channel}</Badge>{c.direction !== "internal" && <Badge tone="blue">{c.direction === "inbound" ? "Entrant" : "Sortant"}</Badge>}{fmtDate(c.createdAt, true)}</p>{c.subject && <p className="mt-1 font-medium">{c.subject}</p>}<p className="mt-1 whitespace-pre-line">{c.body}</p></li>)}</ul>
            )}
          </Section>

          <Section title="Historique">
            <ol className="space-y-1.5 text-sm">{lead.activities.map((a) => {
              const d = (a.data ?? {}) as Record<string, unknown>;
              const extra = a.type === "status_changed" ? `${LEAD_STATUS_LABEL[d.from as keyof typeof LEAD_STATUS_LABEL] ?? d.from} → ${LEAD_STATUS_LABEL[d.to as keyof typeof LEAD_STATUS_LABEL] ?? d.to}` : a.type === "qualified" ? `score ${d.score} (${d.level})` : "";
              return <li key={a.id} className="flex flex-wrap justify-between gap-2"><span>{ACTIVITY[a.type] ?? a.type}{extra && <span className="text-slate-600"> — {extra}</span>}</span><time className="text-xs text-slate-500" dateTime={a.createdAt.toISOString()}>{fmtDate(a.createdAt, true)}</time></li>;
            })}</ol>
          </Section>
        </div>

        <div className="space-y-5">
          {canWrite && (
            <Card>
              <h2 className="mb-3 text-base font-semibold">Pipeline</h2>
              <ActionForm action={changeStatusAction}>
                <input type="hidden" name="id" value={lead.id} />
                <SelectField name="status" label="Statut" required defaultValue={lead.status} options={LEAD_STATUSES.map((s) => [s, LEAD_STATUS_LABEL[s]] as const)} />
                <TextField name="value" label="Montant gagné (si « Gagné »)" type="number" min={0} step="0.01" defaultValue={lead.value} />
                <TextField name="lostReason" label="Motif (si « Perdu »)" defaultValue={lead.lostReason} />
                <SubmitButton>Mettre à jour</SubmitButton>
              </ActionForm>
            </Card>
          )}

          <Card>
            <h2 className="mb-3 text-base font-semibold">Origine</h2>
            <KeyValue items={[
              ["Campagne", lead.campaign ? <Link key="c" href={`/campaigns/${lead.campaign.id}`} className="underline">{lead.campaign.name}</Link> : "—"],
              ["Landing page", lead.landingPage ? <Link key="p" href={`/landing-pages/${lead.landingPage.id}`} className="underline">{lead.landingPage.name}</Link> : "—"],
              ["utm_source", lead.utmSource], ["utm_medium", lead.utmMedium], ["utm_campaign", lead.utmCampaign], ["utm_term", lead.utmTerm], ["utm_content", lead.utmContent], ["Référent", lead.referrer],
            ]} />
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Relances</h2>
            {lead.unsubscribedAt && <Alert tone="warning">Désinscrit le {fmtDate(lead.unsubscribedAt)} : aucun e-mail marketing.</Alert>}
            {!lead.consentMarketing && !lead.unsubscribedAt && <p className="mb-2 text-xs text-slate-500">Pas de consentement marketing : les étapes e-mail créent des tâches manuelles au lieu d'envoyer.</p>}
            {lead.followUps.length > 0 ? <ul className="mb-3 space-y-1 text-sm">{lead.followUps.map((f) => <li key={f.id} className="flex flex-wrap items-center justify-between gap-1"><span>{FOLLOWUP_ACTION_LABEL[f.action]} <span className="text-xs text-slate-500">({f.sequence?.name ?? "—"})</span></span><span className="text-xs text-slate-500">{fmtDate(f.dueAt)} · {f.status}</span></li>)}</ul> : <p className="mb-3 text-sm text-slate-500">Aucune relance planifiée.</p>}
            {canWrite && sequences.length > 0 && (
              <ActionForm action={enrollSequenceAction}><input type="hidden" name="id" value={lead.id} />
                <SelectField name="sequenceId" label="Inscrire à une séquence" required options={sequences.map((s) => [s.id, s.name] as const)} placeholder="Choisir…" /><SubmitButton variant="secondary">Inscrire</SubmitButton></ActionForm>
            )}
            {canWrite && sequences.length === 0 && <p className="text-sm"><Link href="/automations" className="text-brand-700 underline">Créer une séquence de relance</Link></p>}
            {canWrite && pending.length > 0 && <div className="mt-2"><InlineAction action={cancelFollowUpsAction} hidden={{ id: lead.id }}>Arrêter les relances</InlineAction></div>}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Tâches</h2>
            <ul className="mb-3 space-y-1.5 text-sm">{lead.tasks.length === 0 && <li className="text-slate-500">Aucune tâche.</li>}{lead.tasks.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-2"><span className={t.status === "done" ? "text-slate-400 line-through" : ""}>{t.title}{t.dueAt && <span className="text-xs text-slate-500"> · {fmtDate(t.dueAt)}</span>}</span>{canWrite && <InlineAction action={toggleTaskAction} variant="ghost" hidden={{ id: t.id }}>{t.status === "done" ? "Rouvrir" : "Fait"}</InlineAction>}</li>
            ))}</ul>
            {canWrite && <ActionForm action={addTaskAction} resetOnSuccess><input type="hidden" name="leadId" value={lead.id} /><TextField name="title" label="Nouvelle tâche" required /><TextField name="dueAt" label="Échéance" type="date" /><SubmitButton variant="secondary">Ajouter</SubmitButton></ActionForm>}
          </Card>

          <Card>
            <h2 className="mb-2 text-base font-semibold">Données personnelles (RGPD)</h2>
            <p className="mb-2 text-xs text-slate-600">Consentement marketing : {lead.consentMarketing ? `donné le ${fmtDate(lead.consentAt)}` : "non donné"}.{lead.consentText ? ` Texte : « ${lead.consentText} »` : ""}</p>
            <div className="flex flex-wrap gap-2">
              {canWrite && !lead.unsubscribedAt && <InlineAction action={unsubscribeAction} hidden={{ id: lead.id }} confirm="Désinscrire ce prospect de tous les e-mails marketing ?">Désinscrire</InlineAction>}
              {ctx.can("delete") && <InlineAction action={eraseLeadAction} variant="danger" hidden={{ id: lead.id }} confirm="Effacer définitivement les données personnelles de ce prospect ? Cette action est irréversible.">Effacer les données</InlineAction>}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
