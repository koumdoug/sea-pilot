import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { Alert, Badge, Card, EmptyState, PageHeader, Section, StatTile, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, CheckField, InlineAction, SubmitButton, TextField } from "@/components/forms";
import { portfolioStats } from "@/lib/portfolio/service";
import { CHANNEL_LABEL, OUTREACH_CHANNELS, PRODUCT_STATUS_LABEL } from "@/lib/portfolio/rules";
import { initCatalogAction, saveChannelAction } from "./actions";

export const metadata: Metadata = { title: "Portefeuille" };
const TONE: Record<string, Tone> = { preparation: "gray", validation: "orange", commercialisation: "green", suspended: "red" };

export default async function PortfolioPage() {
  const ctx = await requireCtx();
  const [products, stats, channels, audits] = await Promise.all([
    db.product.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null }, orderBy: { name: "asc" } }),
    portfolioStats(ctx.workspaceId),
    db.outreachChannel.findMany({ where: { workspaceId: ctx.workspaceId } }),
    db.auditLog.findMany({ where: { workspaceId: ctx.workspaceId, OR: [{ action: { startsWith: "product" } }, { action: { startsWith: "prospect." } }, { action: { startsWith: "outreach." } }] }, orderBy: { createdAt: "desc" }, take: 15 }),
  ]);
  const canManage = ctx.can("manage_products");
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  const total = (f: (s: (typeof stats)[number]) => number) => stats.reduce((a, s) => a + f(s), 0);
  const revenueByCurrency = new Map<string, number>();
  for (const s of stats) for (const r of s.revenue) revenueByCurrency.set(r.currency, (revenueByCurrency.get(r.currency) ?? 0) + r.amount);
  const noProduct = await db.prospect.count({ where: { workspaceId: ctx.workspaceId, deletedAt: null, productId: null } });

  return (
    <>
      <PageHeader
        title="Portefeuille"
        subtitle="Prospection, acquisition et suivi commercial de vos SaaS depuis un seul endroit. Chaque produit garde ses propres prospects, messages, campagnes et conversions."
        actions={<Link href="/prospects" className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold hover:bg-slate-50">Prospects</Link>}
      />

      {products.length === 0 ? (
        <EmptyState title="Aucun produit dans le catalogue" action={canManage ? <InlineAction action={initCatalogAction} variant="primary" size="md">Créer les fiches DriverPilot, FreelanceNexa et OperaPilot</InlineAction> : undefined}>
          Les fiches sont préremplies avec les seules informations vérifiées à ce jour ; tout le reste est marqué « à confirmer ». Elles démarrent en préparation : aucune action commerciale n'est active.
        </EmptyState>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Produits" value={products.length} hint={`${products.filter((p) => p.status === "commercialisation").length} en commercialisation`} />
            <StatTile label="Prospects attribués" value={total((s) => s.prospectsTotal)} hint={noProduct ? `${noProduct} sans produit` : undefined} />
            <StatTile label="Inscriptions / essais" value={total((s) => (s.events.signup ?? 0) + (s.events.trial_started ?? 0))} hint="saisis manuellement" />
            <StatTile label="Paiements confirmés" value={total((s) => s.events.payment_confirmed ?? 0)}
              hint={revenueByCurrency.size ? [...revenueByCurrency].map(([c, a]) => `${a.toFixed(2)} ${c}`).join(" · ") : "aucun montant saisi"} />
          </div>
          <p className="mb-4 text-xs text-slate-500">Les dépenses marketing ne sont pas rattachées aux produits : elles ne sont affichées que si une campagne publicitaire est liée à un produit.</p>

          <ul className="mb-6 grid gap-3 lg:grid-cols-3">
            {products.map((p) => {
              const s = stats.find((x) => x.productId === p.id);
              const unconfirmed = Array.isArray(p.unconfirmed) ? (p.unconfirmed as string[]).length : 0;
              return (
                <li key={p.id}><Card className="h-full">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/products/${p.id}`} className="min-w-0 break-words text-base font-semibold text-brand-700 underline">{p.name}</Link>
                    <Badge tone={TONE[p.status]}>{PRODUCT_STATUS_LABEL[p.status]}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{p.tagline ?? "—"}</p>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
                    <div><dt className="text-xs text-slate-500">Prospects</dt><dd className="font-semibold">{s?.prospectsTotal ?? 0}</dd></div>
                    <div><dt className="text-xs text-slate-500">Démos</dt><dd className="font-semibold">{s?.events.demo ?? 0}</dd></div>
                    <div><dt className="text-xs text-slate-500">Payants</dt><dd className="font-semibold">{s?.events.payment_confirmed ?? 0}</dd></div>
                  </dl>
                  {unconfirmed > 0 && <p className="mt-3 text-xs text-amber-800">{unconfirmed} point(s) à confirmer</p>}
                </Card></li>
              );
            })}
          </ul>

          <Section title="Canaux de prospection" description="Tous les canaux sont désactivés par défaut. Activer un canal n'envoie rien : les contacts restent consignés par vous, après contrôle d'éligibilité.">
            <ul className="grid gap-3 md:grid-cols-2">
              {OUTREACH_CHANNELS.map((c) => {
                const row = channels.find((x) => x.channel === c);
                return (
                  <li key={c} className="rounded-lg border border-slate-200 p-3">
                    <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">{CHANNEL_LABEL[c]}</span><Badge tone={row?.enabled ? "green" : "gray"}>{row?.enabled ? "Activé" : "Désactivé"}</Badge></div>
                    {canManage ? (
                      <ActionForm action={saveChannelAction}>
                        <input type="hidden" name="channel" value={c} />
                        <CheckField name="enabled" label="Canal activé" defaultChecked={row?.enabled ?? false} />
                        <div className="grid grid-cols-2 gap-2">
                          <TextField name="minDays" label="Jours min. entre deux contacts" type="number" min={1} max={90} defaultValue={row?.minDaysBetweenContacts ?? 7} />
                          <TextField name="maxContacts" label="Contacts max. par personne" type="number" min={1} max={10} defaultValue={row?.maxContactsPerProspect ?? 3} />
                        </div>
                        <SubmitButton size="sm">Enregistrer</SubmitButton>
                      </ActionForm>
                    ) : <p className="text-xs text-slate-500">Intervalle : {row?.minDaysBetweenContacts ?? 7} j · maximum : {row?.maxContactsPerProspect ?? 3} contacts.</p>}
                  </li>
                );
              })}
            </ul>
          </Section>

          {canManage && <div className="mb-5"><InlineAction action={initCatalogAction}>Ajouter les fiches par défaut manquantes</InlineAction></div>}
        </>
      )}

      <Section title="Journal des opérations" description="Dernières opérations du portefeuille (produits, prospects, contacts, approbations).">
        {audits.length === 0 ? <p className="text-sm text-slate-500">Aucune opération.</p> : (
          <TableWrap caption="Journal des opérations">
            <thead><tr><Th>Date</Th><Th>Action</Th><Th>Détail</Th></tr></thead>
            <tbody>
              {audits.map((a) => {
                const meta = (a.meta ?? {}) as Record<string, unknown>;
                const pid = typeof meta.productId === "string" ? meta.productId : undefined;
                return <tr key={a.id}><Td className="whitespace-nowrap">{fmtDate(a.createdAt, true)}</Td><Td>{a.action}</Td><Td className="text-xs text-slate-600">{pid ? nameOf.get(pid) ?? "" : ""}{Array.isArray(meta.reasons) ? ` — ${(meta.reasons as string[]).join(" ")}` : ""}</Td></tr>;
              })}
            </tbody>
          </TableWrap>
        )}
      </Section>
      {!canManage && <Alert tone="info">La gestion du catalogue et des canaux est réservée aux administrateurs.</Alert>}
    </>
  );
}
