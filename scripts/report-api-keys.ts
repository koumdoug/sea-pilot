// LECTURE SEULE. Mesure le nombre de clés API par forfait pour préparer la transition « API réservée à Pro ».
//
//   npx tsx --env-file=<fichier d'environnement de la base visée> scripts/report-api-keys.ts --read-only-confirmed
//
// Garanties : uniquement des lectures (`findMany`) ; aucun identifiant de clé, préfixe, empreinte, adresse ni identifiant d'espace n'est affiché (comptages seulement).
// NE PAS LANCER sur la production sans autorisation explicite du propriétaire : cette mission n'a lu aucune donnée de production.
import { PrismaClient } from "@prisma/client";
import { isExemptWorkspace } from "../src/lib/free-access";
import { summarizeApiKeys, type ApiKeyRow } from "../src/lib/api-key-report";

async function main() {
  if (!process.argv.includes("--read-only-confirmed")) {
    console.error("Refus : ajoutez --read-only-confirmed pour confirmer que vous souhaitez lire la base désignée par DATABASE_URL (lecture seule, comptages).");
    process.exitCode = 2;
    return;
  }
  const db = new PrismaClient();
  try {
    const keys = await db.apiKey.findMany({ select: { workspaceId: true, revokedAt: true, lastUsedAt: true } });
    const wsIds = [...new Set(keys.map((k) => k.workspaceId))];
    const subs = new Map((await db.subscription.findMany({ where: { workspaceId: { in: wsIds } }, select: { workspaceId: true, plan: true } })).map((s) => [s.workspaceId, s.plan]));
    const exempt = new Map<string, boolean>();
    for (const id of wsIds) exempt.set(id, await isExemptWorkspace(id));
    const rows: ApiKeyRow[] = keys.map((k) => ({ workspaceId: k.workspaceId, plan: subs.get(k.workspaceId) ?? null, exempt: exempt.get(k.workspaceId) ?? false, revokedAt: k.revokedAt, lastUsedAt: k.lastUsedAt }));
    console.log(JSON.stringify(summarizeApiKeys(rows), null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => { console.error("Échec de la mesure :", e instanceof Error ? e.message : e); process.exitCode = 1; });
