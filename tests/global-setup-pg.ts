// Garde de sécurité de la suite PostgreSQL (`npm run test:pg`) : cette suite SUPPRIME des données (resetDb) et ne doit JAMAIS viser autre chose qu'une base jetable locale.
// Refus net si : l'hôte n'est pas la boucle locale, le nom de la base ne commence pas par `sea_pilot_throwaway_`, ou la confirmation explicite est absente.
// Les migrations sont appliquées AVANT, par `prisma migrate deploy --schema prisma/postgres/schema.prisma` (voir docs/validation-postgresql-stripe.md).
export default function setup() {
  const raw = process.env.DATABASE_URL ?? "";
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Suite PostgreSQL : DATABASE_URL absent ou invalide."); }
  const db = u.pathname.replace(/^\//, "");
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("Suite PostgreSQL : DATABASE_URL doit être une URL postgresql://.");
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) throw new Error(`Suite PostgreSQL refusée : l'hôte « ${u.hostname} » n'est pas local.`);
  if (!db.startsWith("sea_pilot_throwaway_")) throw new Error(`Suite PostgreSQL refusée : la base « ${db} » n'est pas une base jetable (nom attendu : sea_pilot_throwaway_*).`);
  if (process.env.PG_THROWAWAY_CONFIRM !== "yes") throw new Error("Suite PostgreSQL refusée : définissez PG_THROWAWAY_CONFIRM=yes pour confirmer que la base visée est jetable.");
}
