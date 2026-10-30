import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { workspaceUsage } from "./billing";
import { limitReached, type Plan, type PlanLimits } from "./plans";

export class QuotaError extends Error {}

/**
 * Exécute `fn` dans une transaction qui SÉRIALISE les écritures soumises à quota pour un même espace : la première instruction écrit sur la ligne de
 * l'espace (verrou de ligne PostgreSQL, verrou d'écriture SQLite), donc une seconde transaction attend la validation de la première avant de compter.
 * Sans cela, deux requêtes simultanées comptent toutes deux « limite − 1 » et créent chacune un élément (dépassement de la limite du forfait).
 * Valable entre plusieurs serveurs : le verrou est porté par la base, pas par la mémoire du processus.
 */
export async function withWorkspaceLock<T>(workspaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.workspace.update({ where: { id: workspaceId }, data: { updatedAt: new Date() }, select: { id: true } });
    return fn(tx);
  }, { timeout: 20_000, maxWait: 20_000 });
}

/** Crée un élément seulement si la limite du forfait n'est pas atteinte, comptage et création dans la même transaction verrouillée. */
export async function createWithinLimit<T>(p: { workspaceId: string; plan: Plan; key: keyof PlanLimits; message: string; create: (tx: Prisma.TransactionClient) => Promise<T> }): Promise<T> {
  return withWorkspaceLock(p.workspaceId, async (tx) => {
    const usage = await workspaceUsage(p.workspaceId, tx);
    if (limitReached(p.plan, p.key, usage[p.key])) throw new QuotaError(p.message);
    return p.create(tx);
  });
}
