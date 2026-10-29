import { z } from "zod";
import type { ContentItem } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { UserError, optStr, parse } from "./action";
import { EDITORIAL_STATES, PRIORITIES, EditorialError, calendarByWeek, observedResults, transition, workQueue, type EditorialItem, type EditorialState, type Priority } from "./editorial";

// Persistance du suivi éditorial (modèle ContentItem). Les RÈGLES (transitions, confirmation de publication, file, calendrier) restent
// dans editorial.ts : ce service ne fait que charger, valider le périmètre d'espace de travail et enregistrer. Aucun appel IA ici.

/** Date d'échéance saisie « AAAA-MM-JJ » (jour civil, stocké à minuit UTC pour rester cohérent avec mondayOf) ; vide = pas d'échéance. */
const dueDate = z.string().trim().optional().transform((v, ctx) => {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { ctx.addIssue({ code: "custom", message: "Date invalide (format AAAA-MM-JJ)." }); return z.NEVER; }
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) { ctx.addIssue({ code: "custom", message: "Date invalide." }); return z.NEVER; }
  return d;
});
const httpUrl = optStr(500).refine((v) => { if (!v) return true; try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; } }, "URL invalide (http ou https).");

const idOrEmpty = z.string().trim().max(60).optional().transform((v) => (v ? v : null));
export const contentFieldsSchema = z.object({
  title: z.string().trim().min(1, "Titre requis").max(200, "Titre trop long (200 caractères maximum)."),
  priority: z.enum(PRIORITIES, { message: "Priorité invalide." }).default("medium"),
  dueAt: dueDate,
  landingPageId: idOrEmpty,
  productId: idOrEmpty,
});
export type ContentFields = z.output<typeof contentFieldsSchema>;
export const changeStateSchema = z.object({
  id: z.string().trim().min(1).max(60),
  to: z.enum(EDITORIAL_STATES, { message: "État invalide." }),
  confirmPublished: z.string().optional().transform((v) => v === "on" || v === "true"),
  publishedUrl: httpUrl,
});

type Scope = { workspaceId: string; actorId?: string | null };

export const toEditorialItem = (r: Pick<ContentItem, "id" | "title" | "state" | "priority" | "dueAt" | "publishedConfirmedAt" | "landingPageId">): EditorialItem => ({
  id: r.id, title: r.title, state: (EDITORIAL_STATES as readonly string[]).includes(r.state) ? (r.state as EditorialState) : "idea",
  priority: (PRIORITIES as readonly string[]).includes(r.priority) ? (r.priority as Priority) : "medium", dueAt: r.dueAt, publishedConfirmedAt: r.publishedConfirmedAt, landingPageId: r.landingPageId,
});

/** Les associations ne sont acceptées que si la page / le produit appartient à CET espace de travail (et que le produit n'est pas supprimé). */
async function checkAssociations(workspaceId: string, f: { landingPageId: string | null; productId: string | null }) {
  if (f.landingPageId && !(await db.landingPage.findFirst({ where: { id: f.landingPageId, workspaceId }, select: { id: true } }))) throw new UserError("Landing page introuvable dans cet espace de travail.");
  if (f.productId && !(await db.product.findFirst({ where: { id: f.productId, workspaceId, deletedAt: null }, select: { id: true } }))) throw new UserError("Produit introuvable dans cet espace de travail.");
}

export async function createContentItem(s: Scope, input: unknown) {
  const f = parse(contentFieldsSchema, input);
  await checkAssociations(s.workspaceId, f);
  const row = await db.contentItem.create({ data: { workspaceId: s.workspaceId, title: f.title, priority: f.priority, dueAt: f.dueAt, landingPageId: f.landingPageId, productId: f.productId } });
  await audit({ workspaceId: s.workspaceId, userId: s.actorId, action: "content.create", entity: "ContentItem", entityId: row.id });
  return row;
}

/** Modifie titre, priorité, échéance et associations. L'état et la confirmation de publication ne passent QUE par changeContentState. */
export async function updateContentItem(s: Scope, id: string, input: unknown) {
  const f = parse(contentFieldsSchema, input);
  await checkAssociations(s.workspaceId, f);
  const u = await db.contentItem.updateMany({ where: { id, workspaceId: s.workspaceId }, data: { title: f.title, priority: f.priority, dueAt: f.dueAt, landingPageId: f.landingPageId, productId: f.productId } });
  if (!u.count) throw new UserError("Contenu introuvable.");
  await audit({ workspaceId: s.workspaceId, userId: s.actorId, action: "content.update", entity: "ContentItem", entityId: id });
}

/** Change l'état avec les règles de editorial.ts (un cran, publication = confirmation explicite, retour arrière = confirmation effacée). */
export async function changeContentState(s: Scope, input: unknown) {
  const d = parse(changeStateSchema, input);
  const row = await db.contentItem.findFirst({ where: { id: d.id, workspaceId: s.workspaceId } });
  if (!row) throw new UserError("Contenu introuvable.");
  const before = toEditorialItem(row);
  let next: EditorialItem;
  try { next = transition(before, d.to, { confirmedPublished: d.confirmPublished }); } catch (e) { if (e instanceof EditorialError) throw new UserError(e.message); throw e; }
  // Condition sur l'état lu : deux changements simultanés ne peuvent pas sauter une étape.
  const u = await db.contentItem.updateMany({
    where: { id: d.id, workspaceId: s.workspaceId, state: row.state },
    data: { state: next.state, publishedConfirmedAt: next.publishedConfirmedAt, publishedUrl: next.state === "published" ? (d.publishedUrl ?? row.publishedUrl) : null },
  });
  if (!u.count) throw new UserError("Ce contenu vient d'être modifié ailleurs : rechargez la page.");
  await audit({ workspaceId: s.workspaceId, userId: s.actorId, action: "content.state", entity: "ContentItem", entityId: d.id, meta: { from: before.state, to: next.state } });
  return next;
}

export async function deleteContentItem(s: Scope, id: string) {
  const u = await db.contentItem.deleteMany({ where: { id, workspaceId: s.workspaceId } });
  if (!u.count) throw new UserError("Contenu introuvable.");
  await audit({ workspaceId: s.workspaceId, userId: s.actorId, action: "content.delete", entity: "ContentItem", entityId: id });
}

export type BoardItem = EditorialItem & { productId: string | null; publishedUrl: string | null; landingPageName: string | null; productName: string | null; results: { available: boolean; text: string } };

/** Tout ce que la page /editorial affiche, lu dans l'espace de travail. Lecture seule : aucun appel IA, aucune métrique inventée. */
export async function loadEditorialBoard(workspaceId: string, now = new Date()) {
  const rows = await db.contentItem.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" }, take: 500 });
  const pageIds = [...new Set(rows.map((r) => r.landingPageId).filter((x): x is string => !!x))];
  const productIds = [...new Set(rows.map((r) => r.productId).filter((x): x is string => !!x))];
  const publishedPageIds = [...new Set(rows.filter((r) => r.state === "published").map((r) => r.landingPageId).filter((x): x is string => !!x))];
  const [pages, products, views, leads] = await Promise.all([
    pageIds.length ? db.landingPage.findMany({ where: { workspaceId, id: { in: pageIds } }, select: { id: true, name: true } }) : [],
    productIds.length ? db.product.findMany({ where: { workspaceId, id: { in: productIds }, deletedAt: null }, select: { id: true, name: true } }) : [],
    publishedPageIds.length ? db.analyticsEvent.groupBy({ by: ["landingPageId"], where: { workspaceId, landingPageId: { in: publishedPageIds }, type: "page_view" }, _count: { _all: true } }) : [],
    publishedPageIds.length ? db.lead.groupBy({ by: ["landingPageId"], where: { workspaceId, landingPageId: { in: publishedPageIds }, deletedAt: null }, _count: { _all: true } }) : [],
  ]);
  const pageName = new Map(pages.map((p) => [p.id, p.name]));
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const v = new Map(views.map((x) => [x.landingPageId, x._count._all]));
  const l = new Map(leads.map((x) => [x.landingPageId, x._count._all]));
  const items: BoardItem[] = rows.map((r) => {
    const e = toEditorialItem(r);
    // Les mesures sont celles de la page entière : seule une page existante dans l'espace fournit des résultats.
    const m = e.landingPageId && pageName.has(e.landingPageId) ? { views: v.get(e.landingPageId) ?? 0, leads: l.get(e.landingPageId) ?? 0 } : null;
    return { ...e, productId: r.productId, publishedUrl: r.publishedUrl, landingPageName: e.landingPageId ? pageName.get(e.landingPageId) ?? null : null, productName: r.productId ? productName.get(r.productId) ?? null : null, results: observedResults(e, m) };
  });
  // Les règles de editorial.ts travaillent sur EditorialItem : on retrouve les éléments enrichis par leur id.
  const byId = new Map(items.map((i) => [i.id, i]));
  const enrich = (xs: EditorialItem[]) => xs.map((x) => byId.get(x.id)!);
  const cal = calendarByWeek(items.filter((i) => i.state !== "published"));
  return {
    items,
    queue: enrich(workQueue(items, now)),
    calendar: { weeks: cal.weeks.map((w) => ({ monday: w.monday, items: enrich(w.items) })), undated: enrich(cal.undated) },
    published: items.filter((i) => i.state === "published"),
  };
}
