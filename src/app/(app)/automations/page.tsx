import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { parseSteps } from "@/lib/followups";
import { FOLLOWUP_ACTION_LABEL } from "@/lib/constants";
import { Alert, Badge, Card, EmptyState, PageHeader, Section, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, CheckField, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { SequenceEditor } from "@/components/sequence-editor";
import { createDefaultSequenceAction, deleteSequenceAction, resolveFollowUpAction, runFollowUpsNowAction, saveSequenceAction } from "./actions";
import { hasContradiction, listContradictions, listReviewItems } from "@/lib/followup-review";
import { emailAttemptLabel, reviewReason, verdictLabel } from "@/lib/followup-labels";

export const metadata: Metadata = { title: "Automations" };
const TONE: Record<string, Tone> = { pending: "blue", running: "orange", done: "green", skipped: "gray", cancelled: "gray", failed: "red", blocked: "orange", needs_review: "red" };
const LABEL: Record<string, string> = { pending: "Planifiée", running: "En cours", done: "Exécutée", skipped: "Ignorée", cancelled: "Annulée", failed: "Échec", blocked: "Bloquée", needs_review: "À examiner" };

export default async function AutomationsPage() {
  const ctx = await requireCtx();
  const [seqs, upcoming, recent, email, dueNow, review, contradictions, alerts] = await Promise.all([
    db.followUpSequence.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "asc" }, include: { _count: { select: { followUps: { where: { status: "pending" } } } } } }),
    db.followUp.findMany({ where: { workspaceId: ctx.workspaceId, status: "pending" }, orderBy: { dueAt: "asc" }, take: 15, include: { lead: { select: { id: true, name: true } }, sequence: { select: { name: true } } } }),
    db.followUp.findMany({ where: { workspaceId: ctx.workspaceId, status: { in: ["done", "blocked", "failed", "cancelled"] } }, orderBy: { executedAt: "desc" }, take: 15, include: { lead: { select: { id: true, name: true } } } }),
    db.integration.findUnique({ where: { workspaceId_provider: { workspaceId: ctx.workspaceId, provider: "email" } } }),
    db.followUp.count({ where: { workspaceId: ctx.workspaceId, status: "pending", dueAt: { lte: new Date() } } }),
    listReviewItems(ctx.workspaceId),
    listContradictions(ctx.workspaceId),
    db.auditLog.findMany({ where: { workspaceId: ctx.workspaceId, action: { in: ["email.sent_after_revocation", "email.possibly_sent_after_revocation", "email.in_flight_at_revocation"] } }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const canResolve = ctx.can("approve_outreach");
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

      {(review.length > 0 || contradictions.length > 0 || alerts.length > 0) && (
        <section className="mt-6" aria-labelledby="review-title">
          <h2 id="review-title" className="mb-2 text-base font-semibold">À examiner ({review.length})</h2>
          <p className="mb-3 text-sm text-slate-600">Ces relances ne sont jamais reprises automatiquement : un e-mail dont le résultat est incertain a peut-être déjà été accepté par le fournisseur. {canResolve ? "Chaque décision est enregistrée et ne peut pas écraser une décision concurrente." : "Seuls les administrateurs peuvent les résoudre."}</p>
          {alerts.length > 0 && <div className="mb-3"><Alert tone="warning" title="Alertes de conformité">{alerts.map((a) => <div key={a.id} className="text-sm">{fmtDate(a.createdAt, true)} · {a.action === "email.sent_after_revocation" ? "E-mail accepté par le fournisseur après une désinscription ou un effacement" : a.action === "email.possibly_sent_after_revocation" ? "E-mail possiblement parti après une désinscription ou un effacement" : "Envoi en cours au moment d'un effacement"} (tentative {a.entityId}).</div>)}</Alert></div>}
          {contradictions.length > 0 && (
            <div className="mb-3 space-y-3">
              <Alert tone="error" title="Contradiction entre une décision humaine et le résultat du fournisseur">Une contradiction n'ouvre jamais de renvoi. Un administrateur doit l'acquitter avec une preuve ; l'acquittement ne modifie ni le résultat du fournisseur, ni l'état de la relance.</Alert>
              {contradictions.map((c) => (
                <Card key={c.id}>
                  <p className="text-sm"><strong>{emailAttemptLabel(c)}</strong> — {verdictLabel(c.humanVerdict, c.status)} (tentative {c.id}).</p>
                  {canResolve ? (
                    <ActionForm action={resolveFollowUpAction} className="mt-3 space-y-3">
                      <input type="hidden" name="id" value={c.followUpId ?? ""} />
                      <input type="hidden" name="action" value="ack_contradiction" />
                      <input type="hidden" name="attemptCount" value="0" />
                      <input type="hidden" name="attemptId" value={c.id} />
                      <TextAreaField name="note" label="Preuve (20 caractères au moins)" rows={2} maxLength={1000} help="Identifiant fournisseur, journal de livraison, boîte de réception…" />
                      <CheckField name="confirm" label="Je confirme avoir vérifié cette preuve et j'assume cet acquittement." />
                      <TextField name="typed" label="Mot de confirmation" help="« COMPRIS »" />
                      <SubmitButton variant="danger" pendingLabel="Enregistrement…">Acquitter la contradiction</SubmitButton>
                    </ActionForm>
                  ) : <p className="mt-2 text-xs text-slate-500">Seuls les administrateurs peuvent acquitter une contradiction.</p>}
                </Card>
              ))}
            </div>
          )}
          <div className="space-y-4">
            {review.map((it) => {
              const last = [...it.attempts].reverse().find((a) => a.status !== "aborted") ?? null;
              return (
                <Card key={it.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/leads/${it.leadId}`} className="font-semibold text-brand-700 underline">{it.leadName}</Link>
                    <Badge tone="gray">{FOLLOWUP_ACTION_LABEL[it.action]}</Badge>
                    <Badge tone="red">{it.legacy ? "Ancienne ligne sans bail" : "À examiner"}</Badge>
                    {it.sequenceName && <span className="text-xs text-slate-500">{it.sequenceName}</span>}
                  </div>
                  <p className="mt-2 text-sm">{reviewReason(it)}</p>
                  <p className="mt-1 text-xs text-slate-500">Autorisations : {it.attemptCount}/3 · échecs techniques : {it.technicalFailureCount} · dernière tentative : {it.lastAttemptAt ? fmtDate(it.lastAttemptAt, true) : "—"} · échéance : {fmtDate(it.dueAt)}{it.result ? ` · ${it.result}` : ""}</p>
                  {it.attempts.length > 0 && (
                    <TableWrap caption="Tentatives d'envoi"><thead><tr><Th>N°</Th><Th>Résultat du fournisseur</Th><Th>Appel</Th><Th>Décision humaine</Th></tr></thead><tbody>{it.attempts.map((a) => <tr key={a.id}><Td>{a.attemptNo}</Td><Td>{emailAttemptLabel(a)}{a.httpStatus ? ` (HTTP ${a.httpStatus})` : ""}{a.providerMessageId ? <div className="text-xs text-slate-500">Identifiant fournisseur : {a.providerMessageId}</div> : null}</Td><Td className="text-xs">{a.callStartedAt ? fmtDate(a.callStartedAt, true) : "non commencé"}{a.finishedAt ? ` → ${fmtDate(a.finishedAt, true)}` : ""}</Td><Td className="text-xs">{verdictLabel(a.humanVerdict, a.status) ?? "—"}{a.humanNote ? <div>{a.humanNote}</div> : null}{hasContradiction(a) ? <div className="font-semibold text-red-700">Contradiction{a.contradictionAckAt ? " (acquittée)" : ""}</div> : null}</Td></tr>)}</tbody></TableWrap>
                  )}
                  {canResolve ? (
                    <ActionForm action={resolveFollowUpAction} className="mt-3 space-y-3">
                      <input type="hidden" name="id" value={it.id} />
                      <input type="hidden" name="attemptCount" value={it.attemptCount} />
                      <input type="hidden" name="emailStatus" value={last?.status ?? ""} />
                      {it.contradiction && <input type="hidden" name="attemptId" value={it.contradiction.id} />}
                      <SelectField name="action" label="Décision" required options={it.contradiction ? [["ack_contradiction", "Acquitter la contradiction (aucun renvoi)"]] : [
                        ...(last?.status === "sent" ? [["finalize", "Finaliser (l'e-mail est accepté, rien n'est renvoyé)"] as const] : []),
                        ...(it.action === "email" && (!last || last.status === "attempting" || last.status === "uncertain") ? [["mark_sent", "Marquer envoyé (vérification humaine documentée)"] as const, ["mark_not_sent", "Marquer non envoyé (crée une tâche manuelle)"] as const] : []),
                        ...(it.action === "email" && !it.legacy && last && (last.status === "attempting" || last.status === "uncertain") ? [["resend", "Renvoyer (risque de doublon : confirmation obligatoire)"] as const] : []),
                        ...(it.action === "status_change" && (it.failureKind === "status_progressed" || it.failureKind === "status_conflict") ? [["apply_status", "Appliquer le statut quand même (décision humaine documentée)"] as const] : []),
                        ...(!(it.action === "email" && (it.legacy || last)) && it.failureKind !== "status_progressed" ? [["replan", "Replanifier"] as const] : []),
                        ...(last?.status === "sent" ? [] : [["cancel", "Annuler la relance"] as const]),
                      ]} />
                      <TextAreaField name="note" label="Note de vérification" rows={2} maxLength={1000} help="Obligatoire pour « marquer envoyé / non envoyé » (15 caractères au moins) et pour acquitter une contradiction (20 au moins) : identifiant fournisseur, boîte de réception, journal de livraison…" />
                      <CheckField name="confirm" label="Je confirme avoir effectué cette vérification et j'assume cette décision." />
                      <TextField name="typed" label="Mot de confirmation" help="« RENVOYER » si plus de 24 h se sont écoulées depuis l'envoi (la protection du fournisseur contre les doublons ne s'applique plus) ; « COMPRIS » pour acquitter une contradiction." />
                      <SubmitButton variant="danger" pendingLabel="Traitement…">Appliquer la décision</SubmitButton>
                    </ActionForm>
                  ) : null}
                </Card>
              );
            })}
          </div>
        </section>
      )}

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
