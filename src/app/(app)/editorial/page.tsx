import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { EDITORIAL_LABEL, EDITORIAL_STATES, PRIORITIES, isOverdue, type Priority } from "@/lib/editorial";
import { loadEditorialBoard, type BoardItem } from "@/lib/editorial-service";
import { Alert, Badge, Card, EmptyState, PageHeader, Section, StatTile, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, CheckField, InlineAction, SelectField, SubmitButton, TextField } from "@/components/forms";
import { changeContentStateAction, createContentAction, deleteContentAction, updateContentAction } from "./actions";

export const metadata: Metadata = { title: "Suivi éditorial" };
const STATE_TONE: Record<string, Tone> = { idea: "gray", brief_todo: "orange", ready: "blue", writing: "purple", published: "green" };
const PRIORITY_LABEL: Record<Priority, string> = { high: "Haute", medium: "Moyenne", low: "Basse" };
const PRIORITY_TONE: Record<Priority, Tone> = { high: "red", medium: "blue", low: "gray" };
const PRIORITY_OPTIONS = PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]] as const);
type Opt = readonly [string, string];

function ContentFields({ item, pages, products }: { item?: BoardItem; pages: Opt[]; products: Opt[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <TextField name="title" label="Titre" required maxLength={200} defaultValue={item?.title} className="md:col-span-2" />
      <SelectField name="priority" label="Priorité" required options={PRIORITY_OPTIONS} defaultValue={item?.priority ?? "medium"} />
      <TextField name="dueAt" label="Échéance" type="date" defaultValue={item?.dueAt?.toISOString().slice(0, 10)} help="Facultative : sans date, le contenu reste dans « Sans échéance »." />
      <SelectField name="landingPageId" label="Landing page associée" options={pages} defaultValue={item?.landingPageId} placeholder="Aucune" help="Donne accès au brief et, une fois publié, aux mesures de la page." />
      <SelectField name="productId" label="Produit associé" options={products} defaultValue={item?.productId} placeholder="Aucun" />
    </div>
  );
}

function StateControls({ item, canWrite }: { item: BoardItem; canWrite: boolean }) {
  if (!canWrite || item.state === "published") return null;
  const i = EDITORIAL_STATES.indexOf(item.state);
  const prev = EDITORIAL_STATES[i - 1];
  const next = EDITORIAL_STATES[i + 1];
  return (
    <div className="mt-3 flex flex-wrap items-start gap-2">
      {prev && <InlineAction action={changeContentStateAction} hidden={{ id: item.id, to: prev }}>← {EDITORIAL_LABEL[prev]}</InlineAction>}
      {next && next !== "published" && <InlineAction action={changeContentStateAction} variant="primary" hidden={{ id: item.id, to: next }}>{EDITORIAL_LABEL[next]} →</InlineAction>}
      {next === "published" && (
        <details className="w-full rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer py-2 text-sm font-medium text-brand-700">Marquer comme publié…</summary>
          <ActionForm action={changeContentStateAction} className="mt-3">
            <input type="hidden" name="id" value={item.id} />
            <input type="hidden" name="to" value="published" />
            <CheckField name="confirmPublished" required label="Je confirme que ce contenu est publié." help="SEA Pilot ne publie rien lui-même : seule votre confirmation fait passer le contenu à « Publié »." />
            <TextField name="publishedUrl" label="URL de publication (facultative)" type="url" maxLength={500} placeholder="https://" />
            <SubmitButton pendingLabel="Confirmation…">Confirmer la publication</SubmitButton>
          </ActionForm>
        </details>
      )}
    </div>
  );
}

function ItemCard({ item, now, canWrite, canDelete, pages, products }: { item: BoardItem; now: Date; canWrite: boolean; canDelete: boolean; pages: Opt[]; products: Opt[] }) {
  const late = isOverdue(item, now);
  return (
    <Card as="article">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 break-words text-base font-semibold">{item.title}</h3>
        <div className="flex flex-wrap gap-1.5">
          {late && <Badge tone="red">En retard</Badge>}
          <Badge tone={STATE_TONE[item.state]}>{EDITORIAL_LABEL[item.state]}</Badge>
          <Badge tone={PRIORITY_TONE[item.priority]}>Priorité {PRIORITY_LABEL[item.priority].toLowerCase()}</Badge>
        </div>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Échéance : {item.dueAt ? fmtDate(item.dueAt) : "non définie"}
        {item.landingPageName && <> · Page : <Link href={`/landing-pages/${item.landingPageId}`} className="underline">{item.landingPageName}</Link></>}
        {item.productName && <> · Produit : {item.productName}</>}
      </p>
      {item.landingPageId && item.landingPageName && <p className="mt-1 text-sm"><Link href={`/landing-pages/${item.landingPageId}/brief`} className="font-medium text-brand-700 underline">Ouvrir le brief de la page</Link></p>}
      {item.state === "published" && (
        <p className="mt-2 text-sm text-slate-700">
          Publication confirmée le {fmtDate(item.publishedConfirmedAt)}{item.publishedUrl && <> · <a href={item.publishedUrl} rel="noopener noreferrer" target="_blank" className="break-all underline">{item.publishedUrl}</a></>}
          <span className={item.results.available ? "mt-1 block" : "mt-1 block text-slate-500"}>{item.results.text}</span>
        </p>
      )}
      <StateControls item={item} canWrite={canWrite} />
      {canWrite && (
        <details className="mt-3 rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer py-2 text-sm font-medium text-slate-700">Modifier</summary>
          <ActionForm action={updateContentAction} className="mt-3">
            <input type="hidden" name="id" value={item.id} />
            <ContentFields item={item} pages={pages} products={products} />
            <SubmitButton>Enregistrer</SubmitButton>
          </ActionForm>
        </details>
      )}
      {canDelete && <div className="mt-3"><InlineAction action={deleteContentAction} variant="danger" confirm="Supprimer définitivement ce contenu éditorial ?" hidden={{ id: item.id }}>Supprimer</InlineAction></div>}
    </Card>
  );
}

/** Suivi éditorial : file de travail, calendrier par semaine (lundi), contenus sans échéance, publiés et mesures réelles. Aucune génération IA ici. */
export default async function EditorialPage() {
  const ctx = await requireCtx();
  const now = new Date();
  const [board, pageRows, productRows] = await Promise.all([
    loadEditorialBoard(ctx.workspaceId, now),
    db.landingPage.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 }),
    db.product.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null }, orderBy: { name: "asc" }, select: { id: true, name: true }, take: 200 }),
  ]);
  const pages: Opt[] = pageRows.map((p) => [p.id, p.name]);
  const products: Opt[] = productRows.map((p) => [p.id, p.name]);
  const canWrite = ctx.can("write");
  const canDelete = ctx.can("delete");
  const card = (i: BoardItem) => <li key={i.id}><ItemCard item={i} now={now} canWrite={canWrite} canDelete={canDelete} pages={pages} products={products} /></li>;
  const overdue = board.queue.filter((i) => isOverdue(i, now)).length;

  return (
    <>
      <PageHeader title="Suivi éditorial" subtitle="Planifiez vos contenus, suivez leur avancement et confirmez vous-même leur publication : SEA Pilot ne publie rien à votre place." />
      {!canWrite && <div className="mb-5"><Alert tone="info">Votre rôle permet de consulter le suivi éditorial, pas de le modifier.</Alert></div>}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="À traiter" value={board.queue.length} />
        <StatTile label="En retard" value={overdue} tone={overdue ? "red" : undefined} />
        <StatTile label="Sans échéance" value={board.calendar.undated.length} />
        <StatTile label="Publiés" value={board.published.length} />
      </div>

      {board.items.length === 0 && <EmptyState title="Aucun contenu éditorial pour le moment">{canWrite ? "Ajoutez votre première idée de contenu ci-dessous." : "Aucun contenu n'a encore été ajouté."}</EmptyState>}

      {board.items.length > 0 && (
        <Section title="File de travail" description="Ordre de traitement : contenus en retard, puis priorité, puis échéance (sans échéance en dernier). Les contenus publiés n'y figurent pas.">
          {board.queue.length === 0 ? <p className="text-sm text-slate-600">Rien à traiter : tous les contenus sont publiés.</p> : <ol className="space-y-3">{board.queue.map(card)}</ol>}
        </Section>
      )}

      {board.items.length > 0 && (
        <Section title="Calendrier hebdomadaire" description="Semaines commençant le lundi, contenus non publiés avec échéance.">
          {board.calendar.weeks.length === 0 ? <p className="text-sm text-slate-600">Aucun contenu avec échéance.</p> : (
            <ul className="space-y-4">
              {board.calendar.weeks.map((w) => (
                <li key={w.monday}>
                  <h3 className="text-sm font-semibold">Semaine du lundi {fmtDate(w.monday)}</h3>
                  <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
                    {w.items.map((i) => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><span className="min-w-0 break-words">{i.title} <span className="text-slate-500">· {fmtDate(i.dueAt)}</span></span><Badge tone={STATE_TONE[i.state]}>{EDITORIAL_LABEL[i.state]}</Badge></li>)}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {board.calendar.undated.length > 0 && (
        <Section title="Sans échéance" description="Ces contenus ne figurent pas dans le calendrier tant qu'aucune date n'est définie.">
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
            {board.calendar.undated.map((i) => <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"><span className="min-w-0 break-words">{i.title}</span><Badge tone={STATE_TONE[i.state]}>{EDITORIAL_LABEL[i.state]}</Badge></li>)}
          </ul>
        </Section>
      )}

      {board.published.length > 0 && (
        <Section title="Publiés" description="Résultats observés : mesures réelles de la landing page associée, jamais attribuées à ce contenu seul.">
          <ul className="space-y-3">{board.published.map(card)}</ul>
        </Section>
      )}

      {canWrite && (
        <Section title="Nouveau contenu">
          <ActionForm action={createContentAction} resetOnSuccess>
            <ContentFields pages={pages} products={products} />
            <SubmitButton pendingLabel="Ajout…">Ajouter le contenu</SubmitButton>
          </ActionForm>
        </Section>
      )}
    </>
  );
}
