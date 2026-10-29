import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { audit } from "../audit";
import { UserError } from "../action";
import { FIELD_LIBRARY, sectionsSchema, sid } from "../landing";
import { limitReached, type Plan } from "../plans";
import { workspaceUsage } from "../billing";
import { slugify } from "../workspaces";
import { buildProductLanding, type TemplateProduct } from "./landing-template";

type Feature = { text: string; verified: boolean };
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

async function uniqueSlug(workspaceId: string, base: string) {
  const root = slugify(base);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? root : `${root}-${i}`;
    if (!(await db.landingPage.findUnique({ where: { workspaceId_slug: { workspaceId, slug } }, select: { id: true } }))) return slug;
  }
}

/** Landing page existante (non archivée) rattachée au produit, directement ou par son offre. */
export const findProductPage = (workspaceId: string, productId: string) =>
  db.landingPage.findFirst({ where: { workspaceId, status: { not: "archived" }, OR: [{ productId }, { offer: { productId } }] }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, status: true } });

/**
 * Crée, à la demande de l'utilisateur, l'offre (brouillon, tarif vide s'il n'est pas confirmé) et la landing page BROUILLON d'un produit du catalogue.
 * Idempotent : si une page est déjà rattachée au produit, rien n'est créé. Aucune publication, aucun envoi, aucun appel externe.
 */
export async function createProductLanding(p: { workspaceId: string; productId: string; userId: string; plan: Plan }): Promise<{ created: boolean; pageId: string; offerId: string | null; gaps: string[] }> {
  const product = await db.product.findFirst({ where: { id: p.productId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!product) throw new UserError("Produit introuvable.");
  const existing = await findProductPage(p.workspaceId, product.id);
  if (existing) return { created: false, pageId: existing.id, offerId: null, gaps: [] };
  if (limitReached(p.plan, "landingPages", (await workspaceUsage(p.workspaceId)).landingPages)) throw new UserError("Limite de landing pages atteinte pour votre plan.");

  const draft = buildProductLanding(product as unknown as TemplateProduct, sid);
  const parsed = sectionsSchema.safeParse(draft.sections);
  if (!parsed.success) throw new UserError("La fiche produit ne permet pas de construire une page valide : complétez-la.");
  const fields = FIELD_LIBRARY.filter((f) => draft.formFieldKeys.includes(f.key)).map(({ key, label, type, required }) => ({ key, label, type, required }));

  const verified = arr<Feature>(product.features).filter((f) => f.verified).map((f) => f.text);
  const priced = arr<{ verified: boolean; amount: number | null; currency: string | null; interval: string | null }>((product.pricing as { plans?: unknown } | null)?.plans).find((x) => x.verified && x.amount != null && x.amount > 0 && !!x.currency && x.interval === "month");
  const slug = await uniqueSlug(p.workspaceId, product.slug); // hors transaction : SQLite n'a qu'une connexion, une requête externe bloquerait la transaction
  const result = await db.$transaction(async (tx) => {
    const offer = (await tx.offer.findFirst({ where: { workspaceId: p.workspaceId, productId: product.id, status: { not: "archived" } }, orderBy: { createdAt: "asc" } }))
      ?? await tx.offer.create({ data: {
        workspaceId: p.workspaceId, productId: product.id, name: `Offre ${product.name}`, status: "draft", description: product.description, problem: arr<string>(product.problemsSolved).join(" ; ") || null,
        advantages: verified as Prisma.InputJsonValue, ...(priced ? { price: priced.amount, currency: priced.currency! } : {}),
      } });
    const page = await tx.landingPage.create({ data: {
      workspaceId: p.workspaceId, productId: product.id, offerId: offer.id, name: draft.name, slug, status: "draft",
      sections: parsed.data as unknown as Prisma.InputJsonValue, seoTitle: draft.seoTitle, seoDescription: draft.seoDescription,
    } });
    await tx.form.create({ data: { workspaceId: p.workspaceId, landingPageId: page.id, name: "Formulaire de contact", fields: fields as unknown as Prisma.InputJsonValue, consentText: draft.consentText } });
    return { pageId: page.id, offerId: offer.id };
  });
  await audit({ workspaceId: p.workspaceId, userId: p.userId, action: "product.landing_created", entity: "LandingPage", entityId: result.pageId, meta: { productId: product.id } });
  return { created: true, ...result, gaps: draft.gaps };
}
