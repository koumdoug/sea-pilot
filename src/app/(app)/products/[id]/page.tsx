import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { Alert, Badge, Card, EmptyState, KeyValue, PageHeader, Section, StatTile, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, CheckField, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { portfolioStats } from "@/lib/portfolio/service";
import { CHANNEL_LABEL, EVENT_LABEL, EVENT_TYPES, OUTREACH_CHANNELS, PRODUCT_STATUSES, PRODUCT_STATUS_LABEL, PROSPECT_STATUS_LABEL } from "@/lib/portfolio/rules";
import type { ProductFeature, ProductObjection, ProductPricing, ProductArgument } from "@/lib/portfolio/catalog";
import {
  campaignTransitionAction, createOutreachCampaignAction, recordEventAction, saveProductAction, saveTemplateAction, suspendProductAction, templateStatusAction,
} from "../../portfolio/actions";

export const metadata: Metadata = { title: "Produit" };
const TONE: Record<string, Tone> = { preparation: "gray", validation: "orange", commercialisation: "green", suspended: "red" };
const CAMPAIGN_TONE: Record<string, Tone> = { draft: "gray", pending_approval: "orange", active: "green", paused: "orange", completed: "purple" };
const CAMPAIGN_LABEL: Record<string, string> = { draft: "Brouillon", pending_approval: "En attente d'approbation", active: "Active", paused: "En pause", completed: "Terminée" };
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const product = await db.product.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null } });
  if (!product) notFound();
  const [stats, prospects, templates, campaigns, events] = await Promise.all([
    portfolioStats(ctx.workspaceId).then((s) => s.find((x) => x.productId === id)),
    db.prospect.findMany({ where: { workspaceId: ctx.workspaceId, productId: id, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 25 }),
    db.messageTemplate.findMany({ where: { workspaceId: ctx.workspaceId, productId: id, status: { not: "archived" } }, orderBy: { createdAt: "desc" } }),
    db.outreachCampaign.findMany({ where: { workspaceId: ctx.workspaceId, productId: id }, orderBy: { createdAt: "desc" } }),
    db.productEvent.findMany({ where: { workspaceId: ctx.workspaceId, productId: id }, orderBy: { occurredAt: "desc" }, take: 15, include: { prospect: { select: { name: true } } } }),
  ]);
  const canManage = ctx.can("manage_products"), canWrite = ctx.can("write"), canApprove = ctx.can("approve_outreach");
  const features = arr<ProductFeature>(product.features);
  const pricing = (product.pricing ?? { plans: [] }) as ProductPricing;
  const unconfirmed = arr<string>(product.unconfirmed);
  const args = arr<ProductArgument>(product.salesArguments);
  const objections = arr<ProductObjection>(product.objections);
  const tplName = new Map(templates.map((t) => [t.id, t.name]));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={product.name}
        subtitle={product.tagline ?? undefined}
        actions={<><Badge tone={TONE[product.status]}>{PRODUCT_STATUS_LABEL[product.status]}</Badge><Link href="/portfolio" className="text-sm text-brand-700 underline">← Portefeuille</Link></>}
      />

      {product.status !== "commercialisation" && <div className="mb-4"><Alert tone="warning" title="Aucune prospection possible tant que le produit n'est pas en commercialisation">Les contacts, campagnes et messages restent bloqués. Passez le produit en commercialisation uniquement après avoir vérifié les points « à confirmer ».</Alert></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatTile label="Prospects" value={stats?.prospectsTotal ?? 0} />
        <StatTile label="Leads entrants" value={stats?.inboundLeads ?? 0} />
        <StatTile label="Essais" value={stats?.events.trial_started ?? 0} />
        <StatTile label="Démos" value={stats?.events.demo ?? 0} />
        <StatTile label="Payants" value={stats?.events.payment_confirmed ?? 0} hint={stats?.revenue.length ? stats.revenue.map((r) => `${r.amount.toFixed(2)} ${r.currency}`).join(" · ") : undefined} />
      </div>

      <Section title="Fiche produit" description="Informations vérifiables uniquement. Ce qui n'est pas confirmé reste listé dans « à confirmer ».">
        {unconfirmed.length > 0 && (
          <Alert tone="warning" title="À confirmer"><ul className="list-disc pl-5">{unconfirmed.map((u) => <li key={u}>{u}</li>)}</ul></Alert>
        )}
        <div className="mt-4"><KeyValue items={[
          ["Clientèle cible", product.targetCustomers], ["Proposition de valeur", product.valueProposition], ["Description", product.description],
          ["Problèmes résolus", arr<string>(product.problemsSolved).join(" · ") || null],
          ["URL publique", product.publicUrl], ["Inscription", product.signupUrl], ["Démonstration", product.demoUrl],
          ["Canaux pressentis", arr<string>(product.channels).map((c) => CHANNEL_LABEL[c] ?? c).join(" · ") || null],
        ]} /></div>
        <h3 className="mb-1 mt-5 text-sm font-semibold">Fonctionnalités</h3>
        <ul className="space-y-1 text-sm">
          {features.map((f) => <li key={f.text} className="flex flex-wrap items-center gap-2"><Badge tone={f.verified ? "green" : "orange"}>{f.verified ? "présente dans le code" : "non disponible / non vérifiée"}</Badge><span>{f.text}</span>{f.note && <span className="text-xs text-slate-500">({f.note})</span>}</li>)}
        </ul>
        <h3 className="mb-1 mt-5 text-sm font-semibold">Tarifs</h3>
        {pricing.plans.length === 0 ? <p className="text-sm text-slate-600">Aucun tarif confirmé.</p> : (
          <ul className="text-sm">{pricing.plans.map((p, i) => <li key={i}>{p.name} · {p.amount ?? "?"} {p.currency ?? "(devise à confirmer)"} / {p.interval === "year" ? "an" : "mois"} <Badge tone={p.verified ? "green" : "orange"}>{p.verified ? "vérifié" : "à confirmer"}</Badge></li>)}</ul>
        )}
        {pricing.note && <p className="mt-1 text-xs text-slate-500">{pricing.note}</p>}
        <h3 className="mb-1 mt-5 text-sm font-semibold">Arguments et objections</h3>
        {args.length + objections.length === 0 ? <p className="text-sm text-slate-600">Aucun argument ni réponse approuvés pour l'instant.</p> : (
          <ul className="list-disc pl-5 text-sm">{args.map((a) => <li key={a.text}>{a.text} {a.approved ? "" : "(non approuvé)"}</li>)}{objections.map((o) => <li key={o.objection}>« {o.objection} » → {o.answer} {o.approved ? "" : "(non approuvée)"}</li>)}</ul>
        )}

        {canManage && (
          <details className="mt-5 rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-brand-700">Modifier la fiche et le statut commercial</summary>
            <div className="mt-3">
              <ActionForm action={saveProductAction}>
                <input type="hidden" name="id" value={product.id} />
                <TextField name="name" label="Nom" required defaultValue={product.name} />
                <TextField name="tagline" label="Accroche" defaultValue={product.tagline} />
                <TextAreaField name="description" label="Description" rows={3} defaultValue={product.description} />
                <TextAreaField name="valueProposition" label="Proposition de valeur" rows={2} defaultValue={product.valueProposition} />
                <TextAreaField name="targetCustomers" label="Clientèle cible" rows={2} defaultValue={product.targetCustomers} />
                <TextAreaField name="problemsSolved" label="Problèmes résolus (un par ligne)" rows={3} defaultValue={arr<string>(product.problemsSolved).join("\n")} />
                <TextAreaField name="unconfirmed" label="Points à confirmer (un par ligne)" rows={4} defaultValue={unconfirmed.join("\n")} help="Videz cette liste seulement quand tout est vérifié." />
                <div className="grid gap-3 md:grid-cols-3">
                  <TextField name="publicUrl" label="URL publique" type="url" defaultValue={product.publicUrl} />
                  <TextField name="signupUrl" label="URL d'inscription" type="url" defaultValue={product.signupUrl} />
                  <TextField name="demoUrl" label="URL de démonstration" type="url" defaultValue={product.demoUrl} />
                </div>
                <SelectField name="status" label="Statut commercial" required defaultValue={product.status} options={PRODUCT_STATUSES.map((s) => [s, PRODUCT_STATUS_LABEL[s]] as const)} />
                <CheckField name="confirmReady" label="Je confirme avoir vérifié les points à confirmer avant la commercialisation" />
                <SubmitButton>Enregistrer</SubmitButton>
              </ActionForm>
              {product.status !== "suspended" && <div className="mt-3"><InlineAction action={suspendProductAction} variant="danger" hidden={{ id: product.id, to: "suspended" }} confirm="Suspendre ce produit ? Ses campagnes actives seront mises en pause.">Suspendre le produit</InlineAction></div>}
            </div>
          </details>
        )}
      </Section>

      <Section title={`Prospects (${stats?.prospectsTotal ?? 0})`} actions={<Link href={`/prospects?product=${product.id}`} className="text-sm text-brand-700 underline">Tout voir et ajouter</Link>}>
        {prospects.length === 0 ? <EmptyState title="Aucun prospect pour ce produit">Ajoutez des prospects ou importez un CSV depuis la page Prospects.</EmptyState> : (
          <TableWrap caption="Prospects du produit">
            <thead><tr><Th>Nom</Th><Th>Société</Th><Th>Statut</Th><Th>Prochain suivi</Th></tr></thead>
            <tbody>{prospects.map((p) => <tr key={p.id}><Td><Link href={`/prospects/${p.id}`} className="text-brand-700 underline">{p.name}</Link></Td><Td>{p.company ?? "—"}</Td><Td>{PROSPECT_STATUS_LABEL[p.status] ?? p.status}</Td><Td>{fmtDate(p.nextFollowUpAt)}</Td></tr>)}</tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Modèles de messages" description="Un modèle doit être approuvé avant toute campagne ou contact. Modifier un modèle approuvé le repasse en brouillon.">
        {templates.length === 0 ? <p className="mb-3 text-sm text-slate-500">Aucun modèle.</p> : (
          <ul className="mb-4 space-y-3">
            {templates.map((t) => (
              <li key={t.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{t.name} <span className="font-normal text-slate-500">· {CHANNEL_LABEL[t.channel]}</span></span>
                  <Badge tone={t.status === "approved" ? "green" : "orange"}>{t.status === "approved" ? "Approuvé" : "Brouillon"}</Badge>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-brand-700">Voir / modifier</summary>
                  {canWrite ? (
                    <ActionForm action={saveTemplateAction} className="mt-2">
                      <input type="hidden" name="id" value={t.id} /><input type="hidden" name="productId" value={product.id} />
                      <TextField name="name" label="Nom" required defaultValue={t.name} />
                      <SelectField name="channel" label="Canal" required defaultValue={t.channel} options={OUTREACH_CHANNELS.map((c) => [c, CHANNEL_LABEL[c]] as const)} />
                      <TextField name="subject" label="Objet" defaultValue={t.subject} />
                      <TextAreaField name="body" label="Message" required rows={6} defaultValue={t.body} />
                      <SubmitButton size="sm">Enregistrer (repasse en brouillon)</SubmitButton>
                    </ActionForm>
                  ) : <pre className="mt-2 whitespace-pre-wrap text-sm">{t.body}</pre>}
                </details>
                <div className="mt-2 flex gap-2">
                  {t.status !== "approved" && canApprove && <InlineAction action={templateStatusAction} variant="primary" hidden={{ id: t.id, to: "approved" }}>Approuver</InlineAction>}
                  {canWrite && <InlineAction action={templateStatusAction} hidden={{ id: t.id, to: "archived" }} confirm="Archiver ce modèle ?">Archiver</InlineAction>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details className="rounded-lg border border-dashed border-slate-300 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-brand-700">Nouveau modèle</summary>
            <ActionForm action={saveTemplateAction} resetOnSuccess className="mt-3">
              <input type="hidden" name="productId" value={product.id} />
              <TextField name="name" label="Nom" required />
              <SelectField name="channel" label="Canal" required options={OUTREACH_CHANNELS.map((c) => [c, CHANNEL_LABEL[c]] as const)} />
              <TextField name="subject" label="Objet (courriel)" />
              <TextAreaField name="body" label="Message" required rows={6} help="Identifiez-vous, indiquez vos coordonnées et un moyen simple de refuser les messages. Ne promettez rien que le produit ne fait pas." />
              <SubmitButton>Créer le modèle</SubmitButton>
            </ActionForm>
          </details>
        )}
      </Section>

      <Section title="Campagnes de prospection" description="Brouillon → soumission → approbation humaine → active. Aucune campagne n'envoie quoi que ce soit : elle encadre qui peut être contacté.">
        {campaigns.length === 0 ? <p className="mb-3 text-sm text-slate-500">Aucune campagne.</p> : (
          <ul className="mb-4 space-y-2">
            {campaigns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3">
                <div className="min-w-0"><span className="text-sm font-semibold">{c.name}</span> <span className="text-xs text-slate-500">· {CHANNEL_LABEL[c.channel]} · {c.templateId ? tplName.get(c.templateId) ?? "modèle archivé" : "sans modèle"}</span></div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={CAMPAIGN_TONE[c.status]}>{CAMPAIGN_LABEL[c.status]}</Badge>
                  {canWrite && c.status === "draft" && <InlineAction action={campaignTransitionAction} hidden={{ id: c.id, to: "pending_approval" }}>Soumettre</InlineAction>}
                  {canApprove && c.status === "pending_approval" && <InlineAction action={campaignTransitionAction} variant="primary" hidden={{ id: c.id, to: "active" }} confirm="Approuver cette campagne ? Elle autorisera les contacts consignés par vous.">Approuver</InlineAction>}
                  {canWrite && c.status === "active" && <InlineAction action={campaignTransitionAction} hidden={{ id: c.id, to: "paused" }}>Mettre en pause</InlineAction>}
                  {canWrite && c.status === "paused" && <InlineAction action={campaignTransitionAction} hidden={{ id: c.id, to: "pending_approval" }}>Re-soumettre</InlineAction>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <details className="rounded-lg border border-dashed border-slate-300 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-brand-700">Nouvelle campagne</summary>
            <ActionForm action={createOutreachCampaignAction} resetOnSuccess className="mt-3">
              <input type="hidden" name="productId" value={product.id} />
              <TextField name="name" label="Nom" required />
              <SelectField name="channel" label="Canal" required options={OUTREACH_CHANNELS.map((c) => [c, CHANNEL_LABEL[c]] as const)} />
              <SelectField name="templateId" label="Modèle de message (approuvé)" options={templates.filter((t) => t.status === "approved").map((t) => [t.id, `${t.name} · ${CHANNEL_LABEL[t.channel]}`] as const)} placeholder="— à choisir —" />
              <TextField name="segment" label="Segment visé" />
              <SubmitButton>Créer en brouillon</SubmitButton>
            </ActionForm>
          </details>
        )}
      </Section>

      <Section title="Conversions" description="Saisie manuelle avec traçabilité : indiquez le prospect ou une référence (facture, courriel). Une même conversion n'est jamais comptée deux fois.">
        {events.length === 0 ? <p className="mb-3 text-sm text-slate-500">Aucune conversion enregistrée.</p> : (
          <TableWrap caption="Conversions récentes">
            <thead><tr><Th>Date</Th><Th>Type</Th><Th>Prospect</Th><Th>Montant</Th><Th>Source</Th></tr></thead>
            <tbody>{events.map((e) => <tr key={e.id}><Td>{fmtDate(e.occurredAt)}</Td><Td>{EVENT_LABEL[e.type]}</Td><Td>{e.prospect?.name ?? e.externalRef ?? "—"}</Td><Td>{e.amount != null ? `${e.amount.toFixed(2)} ${e.currency ?? ""}` : "—"}</Td><Td>{e.source === "manual" ? "Saisie manuelle" : "Webhook"}</Td></tr>)}</tbody>
          </TableWrap>
        )}
        {canWrite && (
          <details className="mt-4 rounded-lg border border-dashed border-slate-300 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-brand-700">Enregistrer une conversion</summary>
            <ActionForm action={recordEventAction} resetOnSuccess className="mt-3">
              <input type="hidden" name="productId" value={product.id} />
              <SelectField name="type" label="Type" required options={EVENT_TYPES.map((t) => [t, EVENT_LABEL[t]] as const)} />
              <SelectField name="prospectId" label="Prospect concerné" options={prospects.map((p) => [p.id, p.name] as const)} placeholder="— aucun (référence obligatoire) —" />
              <TextField name="occurredAt" label="Date" type="date" required defaultValue={today} />
              <div className="grid grid-cols-2 gap-3"><TextField name="amount" label="Montant (paiement)" /><TextField name="currency" label="Devise (CAD, USD…)" maxLength={3} /></div>
              <TextField name="externalRef" label="Référence externe (facture, courriel…)" />
              <TextAreaField name="note" label="Note" rows={2} />
              <SubmitButton>Enregistrer</SubmitButton>
            </ActionForm>
          </details>
        )}
      </Section>
      <Card className="text-xs text-slate-500">Conversions automatiques : l'interface <code>POST /api/v1/product-events</code> est prête (clé API de Paramètres, idempotente, source « webhook »), mais aucun des trois SaaS n'y envoie d'événements pour l'instant : non connectée.</Card>
    </>
  );
}
