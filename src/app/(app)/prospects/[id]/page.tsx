import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { Alert, Badge, Card, KeyValue, PageHeader, Section, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { ActionForm, CheckField, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { checkEligibility } from "@/lib/portfolio/service";
import { CHANNEL_LABEL, EVENT_LABEL, EVENT_TYPES, LEGAL_BASIS_LABEL, OUTREACH_CHANNELS, PROSPECT_STATUS_LABEL } from "@/lib/portfolio/rules";
import { attachToCampaignAction, eraseProspectAction, logContactAction, logReplyAction, optOutAction, reassignAction, recordEventAction } from "../../portfolio/actions";

export const metadata: Metadata = { title: "Prospect" };

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const p = await db.prospect.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, include: { interests: true, contacts: { orderBy: { createdAt: "desc" }, take: 20 } } });
  if (!p) notFound();
  const [products, templates, campaigns, events] = await Promise.all([
    db.product.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null }, orderBy: { name: "asc" } }),
    p.productId ? db.messageTemplate.findMany({ where: { workspaceId: ctx.workspaceId, productId: p.productId, status: "approved" } }) : Promise.resolve([]),
    p.productId ? db.outreachCampaign.findMany({ where: { workspaceId: ctx.workspaceId, productId: p.productId, status: { in: ["active", "pending_approval", "draft", "paused"] } } }) : Promise.resolve([]),
    db.productEvent.findMany({ where: { workspaceId: ctx.workspaceId, prospectId: p.id }, orderBy: { occurredAt: "desc" } }),
  ]);
  const name = new Map(products.map((x) => [x.id, x.name]));
  const canWrite = ctx.can("write");
  const today = new Date().toISOString().slice(0, 10);
  const elig = p.productId
    ? await Promise.all(OUTREACH_CHANNELS.map(async (c) => [c, await checkEligibility({ workspaceId: ctx.workspaceId, prospectId: p.id, productId: p.productId!, channel: c })] as const))
    : [];

  return (
    <>
      <PageHeader title={p.name} subtitle={[p.jobTitle, p.company].filter(Boolean).join(" · ") || undefined} actions={<><Badge>{PROSPECT_STATUS_LABEL[p.status] ?? p.status}</Badge><Link href="/prospects" className="text-sm text-brand-700 underline">← Prospects</Link></>} />

      {(p.optedOutAt || p.status === "do_not_contact") && <div className="mb-4"><Alert tone="error" title="Ne pas contacter">Cette personne s'est opposée à tout contact (depuis le {fmtDate(p.optedOutAt)}). Aucun produit ne peut la contacter.</Alert></div>}

      <Section title="Identité et provenance">
        <KeyValue items={[
          ["Produit attribué", p.productId ? (name.get(p.productId) ?? "?") : "Non attribué"],
          ["Autres produits concernés", p.interests.map((i) => name.get(i.productId) ?? "?").join(", ") || null],
          ["Courriel", p.email], ["Téléphone", p.phone], ["Domaine", p.websiteDomain], ["Type", p.audienceType === "b2c" ? "Particulier (B2C)" : "Professionnel (B2B)"],
          ["Provenance", p.source], ["Lien de la source", p.sourceUrl], ["Date de collecte", fmtDate(p.collectedAt)],
          ["Base de contact", LEGAL_BASIS_LABEL[p.legalBasis] ?? p.legalBasis], ["Précision", p.legalBasisNote],
          ["Contacts", `${p.contactCount} · dernier : ${fmtDate(p.lastContactedAt)}`], ["Prochain suivi", fmtDate(p.nextFollowUpAt)], ["Notes", p.notes],
        ]} />
      </Section>

      <Section title="Contact autorisé ?" description="Vérification en temps réel avant toute consignation de contact.">
        {!p.productId ? <Alert tone="warning">Attribuez d'abord ce prospect à un produit.</Alert> : (
          <ul className="space-y-2">
            {elig.map(([c, e]) => (
              <li key={c} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-center justify-between gap-2"><span className="font-semibold">{CHANNEL_LABEL[c]}</span><Badge tone={e.ok ? "green" : "red"}>{e.ok ? "Autorisé" : "Bloqué"}</Badge></div>
                {!e.ok && <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">{e.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canWrite && p.productId && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="Consigner un contact" description="SEA Pilot n'envoie rien : envoyez votre message vous-même, puis consignez-le ici. Le contrôle d'éligibilité s'applique.">
            <ActionForm action={logContactAction} resetOnSuccess>
              <input type="hidden" name="prospectId" value={p.id} /><input type="hidden" name="productId" value={p.productId} />
              <SelectField name="channel" label="Canal" required options={OUTREACH_CHANNELS.map((c) => [c, CHANNEL_LABEL[c]] as const)} />
              <SelectField name="templateId" label="Modèle approuvé utilisé" required options={templates.map((t) => [t.id, `${t.name} · ${CHANNEL_LABEL[t.channel]}`] as const)} placeholder="— choisir un modèle approuvé —" help={templates.length === 0 ? "Aucun modèle approuvé pour ce produit : approuvez-en un dans la fiche du produit avant de consigner un contact." : "Obligatoire : un contact n'est consigné qu'avec un modèle approuvé du même produit et du même canal."} />
              <TextField name="subject" label="Objet" />
              <TextAreaField name="summary" label="Résumé du message envoyé" rows={3} />
              <TextField name="nextFollowUp" label="Prochain suivi" type="date" />
              <SubmitButton>Consigner le contact</SubmitButton>
            </ActionForm>
          </Section>

          <Section title="Réponse reçue">
            <ActionForm action={logReplyAction} resetOnSuccess>
              <input type="hidden" name="prospectId" value={p.id} />
              <SelectField name="channel" label="Canal" required options={OUTREACH_CHANNELS.map((c) => [c, CHANNEL_LABEL[c]] as const)} />
              <TextAreaField name="summary" label="Résumé de la réponse" rows={3} />
              <CheckField name="optOut" label="La personne demande à ne plus être contactée" />
              <SubmitButton>Consigner la réponse</SubmitButton>
            </ActionForm>
          </Section>
        </div>
      )}

      {canWrite && (
        <div className="grid gap-5 lg:grid-cols-2">
          <Section title="Réattribuer à un autre produit" description="Décision explicite : le motif est consigné au journal et le prospect quitte sa campagne.">
            <ActionForm action={reassignAction}>
              <input type="hidden" name="prospectId" value={p.id} />
              <SelectField name="toProductId" label="Nouveau produit" required options={products.filter((x) => x.id !== p.productId).map((x) => [x.id, x.name] as const)} />
              <TextField name="reason" label="Motif" required />
              <SubmitButton variant="secondary">Réattribuer</SubmitButton>
            </ActionForm>
          </Section>

          <Section title="Campagne et opposition">
            {p.productId && campaigns.length > 0 && (
              <ActionForm action={attachToCampaignAction} className="mb-4">
                <input type="hidden" name="prospectId" value={p.id} />
                <SelectField name="campaignId" label="Ajouter à une campagne" required defaultValue={p.campaignId} options={campaigns.map((c) => [c.id, `${c.name} (${c.status})`] as const)} />
                <SubmitButton size="sm" variant="secondary">Ajouter</SubmitButton>
              </ActionForm>
            )}
            {p.status !== "do_not_contact" && <InlineAction action={optOutAction} variant="danger" hidden={{ prospectId: p.id }} confirm="Marquer ce prospect « ne pas contacter » ? Tous les produits seront bloqués.">Marquer « ne pas contacter »</InlineAction>}
          </Section>
        </div>
      )}

      <Section title="Historique des contacts">
        {p.contacts.length === 0 ? <p className="text-sm text-slate-500">Aucun contact consigné.</p> : (
          <TableWrap caption="Historique des contacts">
            <thead><tr><Th>Date</Th><Th>Sens</Th><Th>Canal</Th><Th>Produit</Th><Th>Résumé</Th></tr></thead>
            <tbody>{p.contacts.map((c) => <tr key={c.id}><Td className="whitespace-nowrap">{fmtDate(c.createdAt, true)}</Td><Td>{c.direction === "inbound" ? "Reçu" : "Envoyé"}</Td><Td>{CHANNEL_LABEL[c.channel] ?? c.channel}</Td><Td>{c.productId ? name.get(c.productId) : "—"}</Td><Td className="text-xs">{c.summary ?? c.outcome ?? "—"}</Td></tr>)}</tbody>
          </TableWrap>
        )}
      </Section>

      <Section title="Conversions">
        {events.length > 0 && (
          <ul className="mb-3 text-sm">{events.map((e) => <li key={e.id}>{fmtDate(e.occurredAt)} · {EVENT_LABEL[e.type]} · {name.get(e.productId)}{e.amount != null ? ` · ${e.amount.toFixed(2)} ${e.currency ?? ""}` : ""}</li>)}</ul>
        )}
        {canWrite && p.productId && (
          <ActionForm action={recordEventAction} resetOnSuccess>
            <input type="hidden" name="prospectId" value={p.id} /><input type="hidden" name="productId" value={p.productId} />
            <SelectField name="type" label="Type" required options={EVENT_TYPES.map((t) => [t, EVENT_LABEL[t]] as const)} />
            <TextField name="occurredAt" label="Date" type="date" required defaultValue={today} />
            <div className="grid grid-cols-2 gap-3"><TextField name="amount" label="Montant (paiement)" /><TextField name="currency" label="Devise" maxLength={3} /></div>
            <TextField name="externalRef" label="Référence (facture, etc.)" />
            <SubmitButton>Enregistrer la conversion</SubmitButton>
          </ActionForm>
        )}
      </Section>
      {ctx.can("delete") && <Section title="Effacement (droit à l'effacement)" description="Supprime les données personnelles de ce prospect (identité, coordonnées, notes, historique de contacts) et conserve seulement son adresse dans la liste de suppression pour ne jamais le recontacter. Irréversible."><InlineAction action={eraseProspectAction} variant="danger" hidden={{ prospectId: p.id }} confirm="Effacer définitivement les données de ce prospect ? Cette action est irréversible.">Effacer ce prospect</InlineAction></Section>}
      <Card className="text-xs text-slate-500">Toute opération sur ce prospect est inscrite au journal d'audit du portefeuille.</Card>
    </>
  );
}
