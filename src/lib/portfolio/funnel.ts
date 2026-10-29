import { db } from "../db";

// Parcours d'acquisition d'un produit du portefeuille : visites → leads → prospects → inscriptions → essais → paiements, dépenses, CPL, CAC.
// RÈGLE : une donnée non collectée est « indisponible » (null), JAMAIS zéro. Les conversions sont saisies à la main ou reçues du produit
// (webhook) : SEA Pilot ne les observe pas lui-même. Un CAC n'est « calculé » que sans réserve ; sinon il est « indicatif » avec ses réserves.

export type Availability = "measured" | "manual" | "mixed" | "unavailable";
export type Stage = { id: string; label: string; value: number | null; availability: Availability; note?: string };
export type CacStatus = "unavailable" | "indicative" | "computed";

export type FunnelRaw = {
  currency: string; // devise de l'espace (les dépenses publicitaires y sont saisies)
  linkedPages: number; views: number; pageLeads: number;
  leads: number; qualifiedLeads: number; leadsFromLinkedCampaigns: number;
  sources: { source: string | null; medium: string | null; leads: number }[];
  prospects: number;
  events: Record<string, { manual: number; webhook: number }>;
  payingCustomers: number; unlinkedPayments: number; payments: { currency: string; amount: number }[];
  linkedCampaigns: number; spend: { rows: number; amount: number; unlinkedAmount: number };
};

export type Funnel = {
  stages: Stage[];
  revenue: { currency: string; amount: number }[] | null;
  spend: { value: number | null; currency: string; note?: string };
  cpl: { value: number | null; note?: string };
  rates: { visitToLead: number | null; qualifiedShare: number | null; paidPerSignup: number | null };
  cac: { value: number | null; status: CacStatus; currency: string; caveats: string[]; note?: string };
  sources: { label: string; leads: number }[];
};

export const MIN_CUSTOMERS_FOR_CAC = 5;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const evAvail = (e?: { manual: number; webhook: number }): Availability => (!e ? "manual" : e.manual > 0 && e.webhook > 0 ? "mixed" : e.webhook > 0 ? "measured" : "manual");

export function computeFunnel(r: FunnelRaw): Funnel {
  const evTotal = Object.values(r.events).reduce((n, e) => n + e.manual + e.webhook, 0);
  const ev = (type: string, label: string): Stage => {
    if (evTotal === 0) return { id: type, label, value: null, availability: "unavailable", note: "Non collecté : aucune conversion saisie ni reçue du produit pour cette période." };
    const e = r.events[type];
    return { id: type, label, value: (e?.manual ?? 0) + (e?.webhook ?? 0), availability: evAvail(e), note: evAvail(e) === "manual" ? "Saisie manuelle, non vérifiée par le produit." : evAvail(e) === "mixed" ? "Saisies manuelles et événements reçus du produit." : "Reçu du produit (webhook)." };
  };
  const stages: Stage[] = [
    r.linkedPages === 0
      ? { id: "visits", label: "Visites des landing pages", value: null, availability: "unavailable", note: "Aucune landing page liée au produit (via son offre ou la page elle-même)." }
      : { id: "visits", label: "Visites des landing pages", value: r.views, availability: "measured", note: `${r.linkedPages} page(s) liée(s) ; pages vues enregistrées par SEA Pilot.` },
    { id: "leads", label: "Leads entrants", value: r.leads, availability: "measured" },
    { id: "qualified", label: "Leads qualifiés", value: r.qualifiedLeads, availability: "measured", note: "Leads dont la qualification a été effectuée." },
    { id: "prospects", label: "Prospects identifiés (sortants)", value: r.prospects, availability: "manual", note: "Ajoutés par vous ; distincts des leads entrants." },
    ev("signup", "Inscriptions"), ev("trial_started", "Essais démarrés"), ev("demo", "Démonstrations"), ev("payment_confirmed", "Paiements confirmés"),
  ];

  const hasPay = r.payments.length > 0;
  const revenue = hasPay ? r.payments.map((p) => ({ ...p })) : null;

  let spend: Funnel["spend"];
  if (r.linkedCampaigns === 0) spend = { value: null, currency: r.currency, note: "Aucune campagne publicitaire liée au produit : dépenses non rattachables." };
  else if (r.spend.rows === 0) spend = { value: null, currency: r.currency, note: "Campagne(s) liée(s) mais aucune dépense saisie ou importée pour la période." };
  else spend = { value: r.spend.amount, currency: r.currency };

  const cpl: Funnel["cpl"] = spend.value === null ? { value: null, note: "Dépenses indisponibles." } : r.leadsFromLinkedCampaigns === 0 ? { value: null, note: "Aucun lead issu des campagnes liées : coût par lead non calculable (pas zéro)." } : { value: spend.value / r.leadsFromLinkedCampaigns };

  const signups = evTotal === 0 ? null : (r.events.signup?.manual ?? 0) + (r.events.signup?.webhook ?? 0);
  const rates = { visitToLead: r.linkedPages === 0 ? null : ratio(r.pageLeads, r.views), qualifiedShare: ratio(r.qualifiedLeads, r.leads), paidPerSignup: signups === null ? null : ratio(r.payingCustomers, signups) };

  const caveats: string[] = [];
  let cac: Funnel["cac"];
  if (spend.value === null) cac = { value: null, status: "unavailable", currency: r.currency, caveats, note: `CAC non calculable : ${spend.note ?? "dépenses indisponibles"}` };
  else if (r.payingCustomers === 0) cac = { value: null, status: "unavailable", currency: r.currency, caveats, note: "CAC non calculable : aucun client payant enregistré sur la période (ce n'est pas un CAC nul)." };
  else {
    if (r.spend.unlinkedAmount > 0) caveats.push("Des dépenses non rattachées à une campagne du produit existent : elles ne sont pas incluses.");
    if (r.unlinkedPayments > 0) caveats.push(`${r.unlinkedPayments} paiement(s) sans prospect identifié : le nombre de clients distincts est incertain.`);
    if (r.payingCustomers < MIN_CUSTOMERS_FOR_CAC) caveats.push(`Moins de ${MIN_CUSTOMERS_FOR_CAC} clients payants : valeur peu significative.`);
    if (r.payments.some((p) => p.currency !== r.currency)) caveats.push("Devise des paiements différente de celle des dépenses : aucune conversion n'est appliquée.");
    if ((r.events.payment_confirmed?.webhook ?? 0) === 0) caveats.push("Paiements saisis à la main, non confirmés par le produit.");
    cac = { value: spend.value / r.payingCustomers, status: caveats.length ? "indicative" : "computed", currency: r.currency, caveats, note: "CAC publicitaire : dépenses des campagnes liées ÷ clients payants distincts (hors temps passé, outils et prospection sortante)." };
  }

  const sources = [...r.sources].sort((a, b) => b.leads - a.leads).map((s) => ({ label: s.source ? `${s.source}${s.medium ? ` / ${s.medium}` : ""}` : "Source non renseignée", leads: s.leads }));
  return { stages, revenue, spend, cpl, rates, cac, sources };
}

export async function loadProductFunnel(workspaceId: string, productId: string, from: Date, to: Date): Promise<Funnel> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } });
  const range = { gte: from, lte: to };
  const [pages, campaigns] = await Promise.all([
    db.landingPage.findMany({ where: { workspaceId, status: { not: "archived" }, OR: [{ productId }, { offer: { productId } }] }, select: { id: true } }),
    db.campaign.findMany({ where: { workspaceId, productId }, select: { id: true } }),
  ]);
  const pageIds = pages.map((p) => p.id), campaignIds = campaigns.map((c) => c.id);
  const leadBase = { workspaceId, productId, deletedAt: null, createdAt: range };
  const [views, leads, qualified, pageLeads, campLeads, sources, prospects, evs, pays, spend, unlinked] = await Promise.all([
    pageIds.length ? db.analyticsEvent.count({ where: { workspaceId, type: "page_view", landingPageId: { in: pageIds }, createdAt: range } }) : 0,
    db.lead.count({ where: leadBase }),
    db.lead.count({ where: { ...leadBase, qualifiedAt: { not: null } } }),
    pageIds.length ? db.lead.count({ where: { ...leadBase, landingPageId: { in: pageIds } } }) : 0,
    campaignIds.length ? db.lead.count({ where: { ...leadBase, campaignId: { in: campaignIds } } }) : 0,
    db.lead.groupBy({ by: ["utmSource", "utmMedium"], where: leadBase, _count: { _all: true } }),
    db.prospect.count({ where: { workspaceId, productId, deletedAt: null, createdAt: range } }),
    db.productEvent.groupBy({ by: ["type", "source"], where: { workspaceId, productId, occurredAt: range }, _count: { _all: true } }),
    db.productEvent.findMany({ where: { workspaceId, productId, type: "payment_confirmed", occurredAt: range }, select: { prospectId: true, currency: true, amount: true }, take: 5000 }),
    campaignIds.length ? db.metric.aggregate({ where: { workspaceId, campaignId: { in: campaignIds }, date: range }, _sum: { spend: true }, _count: { _all: true } }) : null,
    db.metric.aggregate({ where: { workspaceId, date: range, OR: [{ campaignId: null }, { campaign: { productId: null } }] }, _sum: { spend: true } }),
  ]);
  const events: FunnelRaw["events"] = {};
  for (const e of evs) { const cur = (events[e.type] ??= { manual: 0, webhook: 0 }); if (e.source === "webhook") cur.webhook += e._count._all; else cur.manual += e._count._all; }
  const byCur = new Map<string, number>();
  for (const p of pays) byCur.set(p.currency ?? "?", (byCur.get(p.currency ?? "?") ?? 0) + (p.amount ?? 0));
  const payingCustomers = new Set(pays.filter((p) => p.prospectId).map((p) => p.prospectId)).size;
  return computeFunnel({
    currency: ws.currency, linkedPages: pageIds.length, views, pageLeads, leads, qualifiedLeads: qualified, leadsFromLinkedCampaigns: campLeads,
    sources: sources.map((s) => ({ source: s.utmSource, medium: s.utmMedium, leads: s._count._all })),
    prospects, events, payingCustomers, unlinkedPayments: pays.filter((p) => !p.prospectId).length,
    payments: [...byCur].map(([currency, amount]) => ({ currency, amount })),
    linkedCampaigns: campaignIds.length, spend: { rows: spend?._count._all ?? 0, amount: spend?._sum.spend ?? 0, unlinkedAmount: unlinked._sum.spend ?? 0 },
  });
}

// ── Vue globale du portefeuille ──
export type PortfolioFunnelRow = { productId: string; name: string; slug: string; funnel: Funnel };
export type PortfolioTotals = { stages: Record<string, number | null>; revenue: { currency: string; amount: number }[] | null; spend: number | null; spendCurrency: string };

/** Totaux multi-produits : une étape n'est « indisponible » que si elle l'est pour tous les produits ; les revenus restent séparés par devise (aucune conversion). */
export function aggregateFunnels(rows: PortfolioFunnelRow[], currency: string): PortfolioTotals {
  const stages: Record<string, number | null> = {};
  const ids = new Set(rows.flatMap((r) => r.funnel.stages.map((s) => s.id)));
  for (const id of ids) {
    const vals = rows.map((r) => r.funnel.stages.find((s) => s.id === id)?.value ?? null).filter((v): v is number => v !== null);
    stages[id] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  const byCur = new Map<string, number>();
  for (const r of rows) for (const p of r.funnel.revenue ?? []) byCur.set(p.currency, (byCur.get(p.currency) ?? 0) + p.amount);
  const spends = rows.map((r) => r.funnel.spend.value).filter((v): v is number => v !== null);
  return { stages, revenue: byCur.size ? [...byCur].map(([c, amount]) => ({ currency: c, amount })) : null, spend: spends.length ? spends.reduce((a, b) => a + b, 0) : null, spendCurrency: currency };
}

export async function loadPortfolioFunnels(workspaceId: string, from: Date, to: Date): Promise<{ rows: PortfolioFunnelRow[]; totals: PortfolioTotals }> {
  const [products, ws] = await Promise.all([
    db.product.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } }),
    db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } }),
  ]);
  const rows = await Promise.all(products.map(async (p) => ({ productId: p.id, name: p.name, slug: p.slug, funnel: await loadProductFunnel(workspaceId, p.id, from, to) })));
  return { rows, totals: aggregateFunnels(rows, ws.currency) };
}
