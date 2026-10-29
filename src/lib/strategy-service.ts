import { db } from "./db";
import { generate } from "./ai/service";
import { getProvider } from "./ai/providers";
import { baseSystem, strategyNarrativePrompt, strategyNarrativeSchema, type StrategyNarrative } from "./ai/prompts";
import type { ProductFacts, StrategyInput, StrategySheet } from "./strategy";
import { billingFromPricing } from "./unit-economics";

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : []);
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/**
 * Entrées de la fiche stratégie lues dans l'espace de travail : MÊME source pour l'onboarding et pour « Recalculer la fiche », afin que la fiche, l'offre
 * enregistrée, l'analyse IA et les objectifs restent cohérents. Le produit du portefeuille rattaché à l'offre (s'il existe) apporte faits vérifiés et mode de facturation ;
 * sans produit rattaché, la récurrence reste inconnue (rien n'est deviné).
 */
export async function loadStrategyInput(workspaceId: string): Promise<StrategyInput | null> {
  const w = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!w) return null;
  const offer = await db.offer.findFirst({ where: { workspaceId, status: { not: "archived" } }, orderBy: { createdAt: "asc" }, include: { audience: true } });
  const p = offer?.productId ? await db.product.findFirst({ where: { id: offer.productId, workspaceId, deletedAt: null } }) : null;
  const product: ProductFacts | null = p ? {
    name: p.name, tagline: p.tagline, valueProposition: p.valueProposition, problemsSolved: strs(p.problemsSolved),
    features: objs(p.features).filter((f) => typeof f.text === "string").map((f) => ({ text: String(f.text), verified: f.verified === true })),
    objections: objs(p.objections).filter((o) => typeof o.objection === "string").map((o) => ({ objection: String(o.objection), answer: typeof o.answer === "string" ? o.answer : null, approved: o.approved === true })),
  } : null;
  return {
    companyName: w.name, currency: w.currency, industry: w.industry, country: w.country, description: w.description,
    offer: offer ? {
      name: offer.name, price: offer.price, marginPct: offer.marginPct, advantages: strs(offer.advantages), differentiation: offer.differentiation, geoZone: offer.geoZone,
      description: offer.description, problem: offer.problem, billing: p ? billingFromPricing(p.pricing, offer.price, offer.currency) : null,
    } : null,
    audience: offer?.audience ? { name: offer.audience.name, type: offer.audience.type, location: offer.audience.location, needs: offer.audience.needs, problems: offer.audience.problems, objections: offer.audience.objections } : null,
    product,
    goals: { leadsPerMonth: w.goalLeadsPerMonth, salesPerMonth: w.goalSalesPerMonth, adBudgetMonthly: w.adBudgetMonthly, maxCac: w.maxCac, revenueGoal: w.revenueGoal },
  };
}

/** Récit IA optionnel de la fiche stratégie. Retourne null si aucun fournisseur d'IA n'est configuré (la fiche chiffrée reste valable). */
export async function generateStrategyNarrative(workspaceId: string, userId: string | null, sheet: StrategySheet): Promise<StrategyNarrative | null> {
  if (!getProvider()) return null;
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return null;
  const r = await generate({
    workspaceId, userId, kind: "strategy", temperature: 0.5,
    system: baseSystem({ name: ws.name, industry: ws.industry, country: ws.country, language: ws.language, description: ws.description, website: ws.website, currency: ws.currency }, "stratège en acquisition client"),
    prompt: strategyNarrativePrompt(sheet), schema: strategyNarrativeSchema, input: { sheet: "strategy" },
  });
  return r.data;
}
