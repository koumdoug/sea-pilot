import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db, containsCi } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { LEAD_STATUSES, LEAD_STATUS_LABEL, QUALIFICATION_LEVELS, LEVEL_LABEL } from "@/lib/constants";
import { Card, EmptyState, LinkButton, PageHeader, Pagination, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { ActionForm, CheckField, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { LevelBadge, StatusBadge } from "@/components/lead-badges";
import { createLeadAction } from "./actions";

export const metadata: Metadata = { title: "Leads" };
const PAGE = 25;

type SP = { q?: string; status?: string; level?: string; campaign?: string; source?: string; page?: string; new?: string };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const where: Prisma.LeadWhereInput = { workspaceId: ctx.workspaceId, deletedAt: null };
  const q = sp.q?.trim();
  if (q) where.OR = [{ name: containsCi(q) }, { email: containsCi(q) }, { company: containsCi(q) }, { phone: containsCi(q) }];
  if (sp.status && (LEAD_STATUSES as readonly string[]).includes(sp.status)) where.status = sp.status;
  if (sp.level && (QUALIFICATION_LEVELS as readonly string[]).includes(sp.level)) where.qualificationLevel = sp.level;
  if (sp.campaign) where.campaignId = sp.campaign;
  if (sp.source) where.utmSource = sp.source;

  const [total, leads, campaigns, sources] = await Promise.all([
    db.lead.count({ where }),
    db.lead.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE, take: PAGE, include: { campaign: { select: { name: true } } } }),
    db.campaign.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.lead.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null, utmSource: { not: null } }, distinct: ["utmSource"], select: { utmSource: true }, take: 50 }),
  ]);
  const hrefFor = (p: number) => { const u = new URLSearchParams(); for (const [k, v] of Object.entries({ ...sp, page: String(p) })) if (v && k !== "new") u.set(k, v); return `/leads?${u.toString()}`; };
  const filtered = !!(q || sp.status || sp.level || sp.campaign || sp.source);

  return (
    <>
      <PageHeader title="Leads" subtitle={`${total} prospect(s)${filtered ? " correspondant aux filtres" : ""}. Chaque lead conserve sa source, sa campagne et ses paramètres UTM.`}
        actions={ctx.can("write") ? <LinkButton href="/leads?new=1#nouveau">Ajouter un lead</LinkButton> : undefined} />

      <form method="get" action="/leads" className="mb-4 grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6" role="search">
        <div className="lg:col-span-2"><label htmlFor="q" className="mb-1 block text-xs font-medium text-slate-600">Recherche</label><input id="q" name="q" defaultValue={q} placeholder="Nom, e-mail, entreprise, téléphone" className="min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm" /></div>
        <Sel name="status" label="Statut" value={sp.status} options={LEAD_STATUSES.map((s) => [s, LEAD_STATUS_LABEL[s]])} />
        <Sel name="level" label="Qualification" value={sp.level} options={QUALIFICATION_LEVELS.map((s) => [s, LEVEL_LABEL[s]])} />
        <Sel name="campaign" label="Campagne" value={sp.campaign} options={campaigns.map((c) => [c.id, c.name])} />
        <Sel name="source" label="Source (UTM)" value={sp.source} options={sources.map((s) => [s.utmSource!, s.utmSource!])} />
        <div className="flex gap-2 sm:col-span-2 lg:col-span-6"><button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">Filtrer</button>{filtered && <Link href="/leads" className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold hover:bg-slate-50">Réinitialiser</Link>}</div>
      </form>

      {sp.new && ctx.can("write") && (
        <Card className="mb-5" id="nouveau"><h2 className="mb-3 text-lg font-semibold">Ajouter un lead manuellement</h2>
          <ActionForm action={createLeadAction}>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField name="name" label="Nom" required /><TextField name="company" label="Entreprise" />
              <TextField name="email" label="E-mail" type="email" /><TextField name="phone" label="Téléphone" type="tel" />
              <TextField name="source" label="Source" placeholder="Ex. salon, bouche-à-oreille, appel entrant" />
              <SelectField name="campaignId" label="Campagne d'origine" options={campaigns.map((c) => [c.id, c.name] as const)} placeholder="— aucune —" />
            </div>
            <TextAreaField name="message" label="Message / besoin" rows={3} />
            <CheckField name="consent" label="Cette personne a accepté de recevoir des e-mails commerciaux" help="À cocher uniquement si le consentement a été recueilli. Sans lui, aucune relance e-mail automatique ne sera envoyée." />
            <SubmitButton>Créer le lead</SubmitButton>
          </ActionForm>
        </Card>
      )}

      {leads.length === 0 ? (
        <EmptyState title={filtered ? "Aucun lead ne correspond à ces filtres" : "Aucun lead pour le moment"}>{filtered ? "Modifiez ou réinitialisez les filtres." : "Publiez une landing page avec formulaire, utilisez l'API d'ingestion ou ajoutez un lead manuellement."}</EmptyState>
      ) : (
        <>
          <TableWrap caption="Liste des leads">
            <thead><tr><Th>Prospect</Th><Th>Statut</Th><Th>Qualification</Th><Th>Campagne</Th><Th>Source</Th><Th>Reçu le</Th></tr></thead>
            <tbody>{leads.map((l) => (
              <tr key={l.id}>
                <Td><Link href={`/leads/${l.id}`} className="font-medium text-brand-700 underline">{l.name}</Link><div className="text-xs text-slate-500">{l.company ?? l.email ?? l.phone}</div></Td>
                <Td><StatusBadge status={l.status} /></Td><Td><LevelBadge level={l.qualificationLevel} score={l.score} /></Td>
                <Td>{l.campaign?.name ?? <span className="text-slate-400">—</span>}</Td><Td>{l.utmSource ?? l.source ?? <span className="text-slate-400">—</span>}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-600">{fmtDate(l.createdAt, true)}</Td>
              </tr>
            ))}</tbody>
          </TableWrap>
          <Pagination page={page} pages={Math.ceil(total / PAGE)} hrefFor={hrefFor} />
        </>
      )}
    </>
  );
}

function Sel({ name, label, value, options }: { name: string; label: string; value?: string; options: (readonly [string, string] | string[])[] }) {
  return (
    <div className="min-w-0"><label htmlFor={`f-${name}`} className="mb-1 block text-xs font-medium text-slate-600">{label}</label>
      <select id={`f-${name}`} name={name} defaultValue={value ?? ""} className="min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Tous</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
  );
}
