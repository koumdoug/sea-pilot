import type { Prisma } from "@prisma/client";
import { UserError } from "./action";
import { QuotaError, createWithinLimit } from "./quota";
import type { Plan } from "./plans";

export const PAGE_QUOTA_MESSAGE = "Limite de landing pages atteinte pour votre plan.";

/** Refus de plafond ou d'adresse déjà prise, en message destiné à l'utilisateur ; toute autre erreur est relancée telle quelle. */
export function pageWriteError(e: unknown): never {
  if (e instanceof QuotaError) throw new UserError(e.message);
  if ((e as { code?: string })?.code === "P2002") throw new UserError("Cette adresse (slug) vient d'être prise : réessayez.");
  throw e;
}

/**
 * Crée une landing page ET ses formulaires dans UNE transaction verrouillée par espace (mécanisme de quota.ts) :
 * le plafond du forfait est compté dans la même transaction que l'écriture (deux créations simultanées ne le dépassent pas),
 * et une erreur en cours de route annule tout (ni page sans formulaire, ni formulaire sans page).
 * Aucun appel externe ni lecture hors transaction ici : SQLite n'a qu'une connexion, une requête extérieure bloquerait la transaction.
 */
export async function createPageWithForms(p: {
  workspaceId: string;
  plan: Plan;
  page: Prisma.LandingPageUncheckedCreateInput;
  forms: Omit<Prisma.FormUncheckedCreateInput, "workspaceId" | "landingPageId">[];
}) {
  try {
    return await createWithinLimit({
      workspaceId: p.workspaceId, plan: p.plan, key: "landingPages", message: PAGE_QUOTA_MESSAGE,
      create: async (tx) => {
        const page = await tx.landingPage.create({ data: p.page });
        for (const f of p.forms) await tx.form.create({ data: { ...f, workspaceId: p.workspaceId, landingPageId: page.id } });
        return page;
      },
    });
  } catch (e) { return pageWriteError(e); }
}
