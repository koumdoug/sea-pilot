import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { containsCi, db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { Alert, Badge, EmptyState, PageHeader, Section, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, CheckField, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { LEGAL_BASES, LEGAL_BASIS_LABEL, PROSPECT_STATUSES, PROSPECT_STATUS_LABEL } from "@/lib/portfolio/rules";
import { addProspectAction, importProspectsAction } from "../portfolio/actions";

export const metadata: Metadata = { title: "Prospects" };
const TONE: Record<string, Tone> = { identified: "gray", contacted: "blue", replied: "purple", demo: "orange", trial: "orange", customer: "green", lost: "gray", do_not_contact: "red" };

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<{ product?: string; status?: string; q?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const where: Prisma.ProspectWhereInput = { workspaceId: ctx.workspaceId, deletedAt: null };
  if (sp.product === "none") where.productId = null;
  else if (sp.product) where.productId = sp.product;
  if (sp.status && (PROSPECT_STATUSES as readonly string[]).includes(sp.status)) where.status = sp.status;
  if (sp.q?.trim()) where.OR = [{ name: containsCi(sp.q.trim()) }, { company: containsCi(sp.q.trim()) }, { email: containsCi(sp.q.trim()) }];
  const [prospects, products, total] = await Promise.all([
    db.prospect.findMany({ where, orderBy: { createdAt: "desc" }, take: 100, include: { interests: { select: { productId: true } } } }),
    db.product.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.prospect.count({ where }),
  ]);
  const nameOf = new Map(products.map((p) => [p.id, p.name]));
  const canWrite = ctx.can("write");
  const today = new Date().toISOString().slice(0, 10);
  const productOptions = products.map((p) => [p.id, p.name] as const);

  return (
    <>
      <PageHeader title="Prospects" subtitle="Personnes que vous avez identifiées pour vos SaaS. Chaque personne n'existe qu'une fois et n'est contactée que pour un seul produit." actions={<Link href="/portfolio" className="text-sm text-brand-700 underline">← Portefeuille</Link>} />

      {products.length === 0 && <div className="mb-4"><Alert tone="warning" title="Aucun produit">Créez d'abord le catalogue dans <Link href="/portfolio" className="underline">Portefeuille</Link>.</Alert></div>}

      <form method="get" action="/prospects" className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3" role="search">
        <div className="max-w-full"><label htmlFor="fp" className="mb-1 block text-xs font-medium text-slate-600">Produit</label>
          <select id="fp" name="product" defaultValue={sp.product ?? ""} className="min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Tous</option><option value="none">Sans produit</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="max-w-full"><label htmlFor="fs" className="mb-1 block text-xs font-medium text-slate-600">Statut</label>
          <select id="fs" name="status" defaultValue={sp.status ?? ""} className="min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Tous</option>{PROSPECT_STATUSES.map((s) => <option key={s} value={s}>{PROSPECT_STATUS_LABEL[s]}</option>)}</select></div>
        <div className="min-w-0"><label htmlFor="fq" className="mb-1 block text-xs font-medium text-slate-600">Recherche</label>
          <input id="fq" name="q" defaultValue={sp.q ?? ""} placeholder="Nom, société, courriel" className="min-h-11 w-full max-w-full rounded-lg border border-slate-300 px-3 text-sm" /></div>
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">Filtrer</button>
      </form>

      {prospects.length === 0 ? <EmptyState title="Aucun prospect">Ajoutez une personne ou importez un fichier CSV ci-dessous.</EmptyState> : (
        <>
          <p className="mb-2 text-sm text-slate-600">{total} prospect(s){total > 100 ? " — 100 affichés" : ""}.</p>
          <TableWrap caption="Prospects">
            <thead><tr><Th>Nom</Th><Th>Société</Th><Th>Produit</Th><Th>Statut</Th><Th>Base de contact</Th><Th>Collecté</Th><Th>Prochain suivi</Th></tr></thead>
            <tbody>
              {prospects.map((p) => (
                <tr key={p.id}>
                  <Td><Link href={`/prospects/${p.id}`} className="text-brand-700 underline">{p.name}</Link>{p.interests.length > 0 && <div className="text-xs text-slate-500">aussi : {p.interests.map((i) => nameOf.get(i.productId) ?? "?").join(", ")}</div>}</Td>
                  <Td>{p.company ?? "—"}</Td>
                  <Td>{p.productId ? nameOf.get(p.productId) ?? "?" : <Badge tone="orange">Non attribué</Badge>}</Td>
                  <Td><Badge tone={TONE[p.status]}>{PROSPECT_STATUS_LABEL[p.status] ?? p.status}</Badge></Td>
                  <Td className="text-xs">{LEGAL_BASIS_LABEL[p.legalBasis] ?? p.legalBasis}</Td>
                  <Td>{fmtDate(p.collectedAt)}</Td>
                  <Td>{fmtDate(p.nextFollowUpAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </>
      )}

      {canWrite && products.length > 0 && (
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <Section title="Ajouter un prospect" description="Provenance, date de collecte et base de contact sont obligatoires pour pouvoir le contacter.">
            <ActionForm action={addProspectAction} resetOnSuccess>
              <SelectField name="productId" label="Produit" required options={productOptions} defaultValue={sp.product && sp.product !== "none" ? sp.product : undefined} />
              <TextField name="name" label="Nom" required />
              <div className="grid gap-3 md:grid-cols-2"><TextField name="company" label="Société" /><TextField name="jobTitle" label="Fonction" /></div>
              <div className="grid gap-3 md:grid-cols-2"><TextField name="email" label="Courriel professionnel public" type="email" /><TextField name="phone" label="Téléphone" /></div>
              <TextField name="website" label="Site web" />
              <div className="grid gap-3 md:grid-cols-2">
                <SelectField name="audienceType" label="Type" required defaultValue="b2b" options={[["b2b", "Professionnel (B2B)"], ["b2c", "Particulier (B2C)"]]} />
                <TextField name="segment" label="Segment" />
              </div>
              <TextField name="source" label="Provenance (où l'avez-vous trouvé ?)" required placeholder="Ex. site web public de l'entreprise" />
              <TextField name="sourceUrl" label="Lien de la source" type="url" />
              <TextField name="collectedAt" label="Date de collecte" type="date" required defaultValue={today} />
              <SelectField name="legalBasis" label="Base de contact" required defaultValue="unknown" options={LEGAL_BASES.map((b) => [b, LEGAL_BASIS_LABEL[b]] as const)} help="Sans base documentée, le prospect est enregistré mais ne peut pas être contacté." />
              <TextField name="legalBasisNote" label="Preuve ou précision" />
              <TextAreaField name="notes" label="Notes" rows={2} />
              <SubmitButton>Enregistrer</SubmitButton>
            </ActionForm>
          </Section>

          <Section title="Importer un fichier CSV" description="Colonnes obligatoires : nom, source, date de collecte (AAAA-MM-JJ), et courriel ou téléphone. Recommandées : entreprise, base légale, produit (identifiant du produit), type (b2b/b2c).">
            <ActionForm action={importProspectsAction}>
              <div>
                <label htmlFor="csvfile" className="mb-1 block text-sm font-medium text-slate-800">Fichier CSV (500 lignes max.)</label>
                <input id="csvfile" name="file" type="file" accept=".csv,text/csv" required className="block w-full text-sm" />
              </div>
              <SelectField name="defaultProductId" label="Produit par défaut (si la colonne produit est absente)" options={productOptions} placeholder="— aucun —" />
              <CheckField name="dryRun" label="Vérifier seulement (ne rien enregistrer)" defaultChecked />
              <CheckField name="confirmLawful" label="Je confirme que ces données ont été collectées de façon licite et que leur provenance est indiquée" />
              <SubmitButton pendingLabel="Traitement…">Lancer</SubmitButton>
            </ActionForm>
            <p className="mt-3 text-xs text-slate-500">Les doublons (même courriel, téléphone ou société + nom) ne sont jamais recréés, même entre produits. Les adresses déjà désinscrites arrivent « ne pas contacter ».</p>
          </Section>
        </div>
      )}
    </>
  );
}
