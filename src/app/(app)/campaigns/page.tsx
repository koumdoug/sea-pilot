import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { loadAnalytics, defaultRange } from "@/lib/analytics";
import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABEL, PLATFORM_LABEL } from "@/lib/constants";
import { fmtMoney } from "@/lib/kpi";
import { Badge, CAMPAIGN_STATUS_TONE, EmptyState, LinkButton, PageHeader, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { duplicateCampaignAction } from "./actions";

export const metadata: Metadata = { title: "Campaigns" };
const STATUS_TONE = CAMPAIGN_STATUS_TONE;

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const status = (CAMPAIGN_STATUSES as readonly string[]).includes(sp.status ?? "") ? sp.status! : undefined;
  const cur = ctx.workspace.currency;
  const [campaigns, counts, a] = await Promise.all([
    db.campaign.findMany({ where: { workspaceId: ctx.workspaceId, ...(status ? { status } : { status: { not: "archived" } }) }, orderBy: { updatedAt: "desc" }, include: { offer: { select: { name: true } } } }),
    db.campaign.groupBy({ by: ["status"], where: { workspaceId: ctx.workspaceId }, _count: { _all: true } }),
    loadAnalytics(ctx.workspaceId, { ...defaultRange(90) }),
  ]);
  const byId = new Map(a.campaigns.map((c) => [c.id, c]));

  return (
    <>
      <PageHeader title="Campagnes" subtitle="Vos campagnes d'acquisition, de la préparation au pilotage. Indicateurs sur les 90 derniers jours." actions={ctx.can("write") ? <LinkButton href="/campaigns/new">Nouvelle campagne</LinkButton> : undefined} />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Filtrer par statut">
        <LinkButton href="/campaigns" size="sm" variant={!status ? "primary" : "secondary"}>Actives et en cours</LinkButton>
        {CAMPAIGN_STATUSES.map((s) => <LinkButton key={s} href={`/campaigns?status=${s}`} size="sm" variant={status === s ? "primary" : "secondary"}>{CAMPAIGN_STATUS_LABEL[s]} ({counts.find((c) => c.status === s)?._count._all ?? 0})</LinkButton>)}
      </nav>
      {campaigns.length === 0 ? (
        <EmptyState title="Aucune campagne" action={ctx.can("write") ? <LinkButton href="/campaigns/new">Créer une campagne</LinkButton> : undefined}>Le Campaign Builder vous guide en 10 étapes, de l'objectif au lancement.</EmptyState>
      ) : (
        <TableWrap caption="Liste des campagnes">
          <thead><tr><Th>Campagne</Th><Th>Statut</Th><Th>Plateforme</Th><Th className="text-right">Budget</Th><Th className="text-right">Dépense</Th><Th className="text-right">Leads</Th><Th className="text-right">CPL</Th><Th>MAJ</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
          <tbody>
            {campaigns.map((c) => {
              const row = byId.get(c.id);
              return (
                <tr key={c.id}>
                  <Td><Link href={`/campaigns/${c.id}`} className="font-medium text-brand-700 underline">{c.name}</Link>{c.offer && <div className="text-xs text-slate-500">{c.offer.name}</div>}</Td>
                  <Td><Badge tone={STATUS_TONE[c.status]}>{CAMPAIGN_STATUS_LABEL[c.status as keyof typeof CAMPAIGN_STATUS_LABEL]}</Badge></Td>
                  <Td>{PLATFORM_LABEL[c.platform] ?? c.platform}</Td>
                  <Td className="text-right tabular-nums">{c.budget ? fmtMoney(c.budget, cur) : "—"}</Td>
                  <Td className="text-right tabular-nums">{row && row.totals.spend > 0 ? fmtMoney(row.totals.spend, cur) : "—"}</Td>
                  <Td className="text-right tabular-nums">{row?.totals.leads ?? 0}</Td>
                  <Td className="text-right tabular-nums">{fmtMoney(row?.kpis.cpl ?? null, cur)}</Td>
                  <Td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(c.updatedAt)}</Td>
                  <Td>{ctx.can("write") && <InlineAction action={duplicateCampaignAction} hidden={{ id: c.id }}>Dupliquer</InlineAction>}</Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
