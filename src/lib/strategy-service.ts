import { db } from "./db";
import { generate } from "./ai/service";
import { getProvider } from "./ai/providers";
import { baseSystem, strategyNarrativePrompt, strategyNarrativeSchema, type StrategyNarrative } from "./ai/prompts";
import type { StrategySheet } from "./strategy";

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
