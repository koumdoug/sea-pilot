import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { Badge, Card, EmptyState, PageHeader, Section, fmtDate, type Tone } from "@/components/ui";
import { InlineAction, ActionForm, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { fmtMoney } from "@/lib/kpi";
import { OfferForm } from "./offer-form";
import { deleteAudienceAction, saveAudienceAction, setOfferStatusAction } from "./actions";

export const metadata: Metadata = { title: "Offers" };
const TONE: Record<string, Tone> = { draft: "gray", active: "green", archived: "orange" };
const LABEL: Record<string, string> = { draft: "Brouillon", active: "Active", archived: "Archivée" };

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const [offers, audiences] = await Promise.all([
    db.offer.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "desc" }, include: { audience: true } }),
    db.audience.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { name: "asc" } }),
  ]);
  const canWrite = ctx.can("write");

  return (
    <>
      <PageHeader title="Offres" subtitle="Définissez ce que vous vendez, à qui, et générez des variantes d'offre avec l'Offer Builder." actions={canWrite ? <Link href="/offers?new=1#nouvelle" className="inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">Nouvelle offre</Link> : undefined} />

      {offers.length === 0 ? <EmptyState title="Aucune offre pour le moment">Créez votre première offre pour pouvoir lancer une campagne.</EmptyState> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {offers.map((o) => (
            <li key={o.id}><Card className="h-full">
              <div className="flex items-start justify-between gap-2">
                <Link href={`/offers/${o.id}`} className="min-w-0 break-words text-base font-semibold text-brand-700 underline">{o.name}</Link>
                <Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge>
              </div>
              <p className="mt-1 text-sm text-slate-600">{o.price ? fmtMoney(o.price, o.currency) : "Prix non renseigné"}{o.audience ? ` · ${o.audience.name}` : ""}</p>
              <p className="mt-1 text-xs text-slate-500">Créée le {fmtDate(o.createdAt)} · {Array.isArray(o.variants) ? o.variants.length : 0} variante(s) IA</p>
              {canWrite && <div className="mt-3 flex gap-2">
                {o.status !== "active" && <InlineAction action={setOfferStatusAction} hidden={{ id: o.id, status: "active" }}>Activer</InlineAction>}
                {o.status !== "archived" && <InlineAction action={setOfferStatusAction} hidden={{ id: o.id, status: "archived" }}>Archiver</InlineAction>}
              </div>}
            </Card></li>
          ))}
        </ul>
      )}

      {canWrite && sp.new && <div id="nouvelle" className="mt-5"><Section title="Nouvelle offre"><OfferForm audiences={audiences} currency={ctx.workspace.currency} /></Section></div>}

      <div className="mt-8">
        <Section title="Audiences" description="Vos clients idéaux. Une audience peut être associée à plusieurs offres et campagnes.">
          {audiences.length === 0 && <p className="mb-3 text-sm text-slate-500">Aucune audience.</p>}
          <ul className="mb-4 space-y-3">
            {audiences.map((a) => (
              <li key={a.id} className="rounded-lg border border-slate-200 p-3">
                <details>
                  <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm font-semibold">{a.name} <Badge tone="blue">{a.type.toUpperCase()}</Badge></summary>
                  <div className="mt-3">
                    <AudienceForm audience={a} canWrite={canWrite} />
                    {ctx.can("delete") && <div className="mt-2"><InlineAction action={deleteAudienceAction} variant="danger" hidden={{ id: a.id }} confirm="Supprimer cette audience ?">Supprimer</InlineAction></div>}
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {canWrite && <details className="rounded-lg border border-dashed border-slate-300 p-3"><summary className="cursor-pointer text-sm font-semibold text-brand-700">Ajouter une audience</summary><div className="mt-3"><AudienceForm canWrite /></div></details>}
        </Section>
      </div>
    </>
  );
}

function AudienceForm({ audience, canWrite }: { audience?: { id: string; name: string; type: string; customerType: string | null; location: string | null; needs: string | null; problems: string | null; objections: string | null }; canWrite: boolean }) {
  if (!canWrite) return <p className="text-sm text-slate-600">{audience?.needs}</p>;
  return (
    <ActionForm action={saveAudienceAction} resetOnSuccess={!audience}>
      {audience && <input type="hidden" name="id" value={audience.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="name" label="Nom de l'audience" required defaultValue={audience?.name} />
        <SelectField name="type" label="Marché" required defaultValue={audience?.type ?? "b2c"} options={[["b2c", "B2C"], ["b2b", "B2B"]]} />
        <TextField name="customerType" label="Type de client" defaultValue={audience?.customerType} />
        <TextField name="location" label="Localisation" defaultValue={audience?.location} />
      </div>
      <TextAreaField name="needs" label="Besoins" rows={2} defaultValue={audience?.needs} />
      <TextAreaField name="problems" label="Problèmes" rows={2} defaultValue={audience?.problems} />
      <TextAreaField name="objections" label="Objections" rows={2} defaultValue={audience?.objections} />
      <SubmitButton>{audience ? "Enregistrer" : "Ajouter l'audience"}</SubmitButton>
    </ActionForm>
  );
}
