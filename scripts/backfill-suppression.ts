// Conversion PROGRESSIVE des entrées de suppression en clair vers le format HMAC (`backfillSuppressionKeys`). Jamais lancée automatiquement.
// Procédure complète : docs/followup-reliability.md (§ 15) — sauvegarde de la base AVANT toute écriture.
//
//   SIMULATION (défaut, aucune écriture) :
//     npx tsx --env-file=<fichier d'environnement de la base visée> scripts/backfill-suppression.ts
//   ÉTAPE ADDITIVE (ajoute les entrées HMAC, ne supprime rien, réversible) :
//     ... scripts/backfill-suppression.ts --apply --confirm-host=<hôte affiché par la simulation>
//   SUPPRESSION DU CLAIR (après vérification de l'entrée HMAC ; retour arrière impossible pour un prospect effacé) :
//     ... scripts/backfill-suppression.ts --apply --delete-plain --confirm-host=<hôte>
//
// Options : --workspace=<id> (un seul espace), --limit=<n> (1 à 20000 ; 500 par défaut).
// Garanties : SUPPRESSION_HMAC_KEY doit être valide (sinon rien n'est converti) ; aucune adresse, clé ni identifiant d'espace n'est affiché (comptages et hôte de la base seulement) ;
// l'écriture exige --apply ET --confirm-host égal à l'hôte réellement visé par DATABASE_URL (pour ne pas écrire dans la mauvaise base).
import { backfillSuppressionKeys } from "../src/lib/suppression";
import { db } from "../src/lib/db";

/** Hôte et nom de base de DATABASE_URL, SANS identifiants ni paramètres. */
export function describeTarget(url: string | undefined): { kind: string; host: string } {
  if (!url) return { kind: "absente", host: "" };
  if (/^file:/.test(url)) return { kind: "sqlite", host: "fichier-local" };
  try {
    const u = new URL(url);
    return { kind: u.protocol.replace(":", ""), host: `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}` };
  } catch {
    return { kind: "illisible", host: "" };
  }
}

export function parseArgs(argv: string[]) {
  const opt = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const limitRaw = opt("limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const known = new Set(["--apply", "--delete-plain"]);
  const unknown = argv.filter((a) => !known.has(a) && !/^--(workspace|limit|confirm-host)=/.test(a));
  return {
    apply: argv.includes("--apply"), deletePlain: argv.includes("--delete-plain"),
    workspaceId: opt("workspace"), confirmHost: opt("confirm-host"), limit, unknown,
    limitInvalid: limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20_000),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.unknown.length || a.limitInvalid) { console.error(`Refus : option inconnue ou invalide (${a.unknown.join(", ") || "--limit"}).`); process.exitCode = 2; return; }
  if (a.deletePlain && !a.apply) { console.error("Refus : --delete-plain exige --apply."); process.exitCode = 2; return; }
  const target = describeTarget(process.env.DATABASE_URL);
  if (target.kind === "absente" || target.kind === "illisible") { console.error("Refus : DATABASE_URL absente ou illisible."); process.exitCode = 2; return; }
  console.log(`Base visée : ${target.kind} ${target.host}`);
  if (a.apply && a.confirmHost !== target.host) {
    console.error(`Refus : pour écrire, ajoutez --confirm-host=${target.host} (l'hôte de la base réellement visée). Rien n'a été modifié.`);
    process.exitCode = 2; return;
  }
  try {
    const r = await backfillSuppressionKeys({ workspaceId: a.workspaceId, dryRun: !a.apply, deletePlain: a.deletePlain, limit: a.limit });
    console.log(a.apply ? (a.deletePlain ? "Mode : ÉCRITURE + suppression du clair" : "Mode : ÉCRITURE additive (aucune suppression)") : "Mode : SIMULATION (aucune écriture)");
    console.log(JSON.stringify(r, null, 2));
    if (r.malformedKeyed > 0) console.warn(`ATTENTION : ${r.malformedKeyed} entrée(s) h1: mal formée(s) — à examiner avant d'aller plus loin.`);
    if (r.keptUnverified > 0) console.warn(`ATTENTION : ${r.keptUnverified} entrée(s) en clair conservée(s) faute de vérification — la configuration de clés a peut-être changé.`);
    if (r.scanned >= (a.limit ?? 500)) console.warn("Le plafond d'entrées par appel est atteint : relancer (avec --delete-plain la file avance ; sans, augmenter --limit).");
  } finally {
    await db.$disconnect();
  }
}

// Ne s'exécute que lancé directement (les tests importent describeTarget / parseArgs sans effet).
if (process.argv[1] && /backfill-suppression\.[cm]?[tj]s$/.test(process.argv[1])) {
  main().catch((e) => { console.error("Échec :", e instanceof Error ? e.message : e); process.exitCode = 1; });
}
