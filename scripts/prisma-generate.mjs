// Génère le client Prisma adapté à DATABASE_URL (SQLite par défaut, PostgreSQL si l'URL commence par postgres).
// Exécuté par `postinstall` et `build` : un clone propre se construit sans étape manuelle.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

let url = process.env.DATABASE_URL ?? "";
if (!url && existsSync(".env")) {
  const m = readFileSync(".env", "utf8").match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (m) url = m[1];
}
const pg = /^postgres(ql)?:\/\//.test(url);
const args = ["prisma", "generate", ...(pg ? ["--schema", "prisma/postgres/schema.prisma"] : [])];
console.log(`[prisma] ${pg ? "PostgreSQL" : "SQLite"} -> ${args.join(" ")}`);
const r = spawnSync("npx", args, { stdio: "inherit", shell: true, env: { ...process.env, DATABASE_URL: url || "file:./dev.db" } });
process.exit(r.status ?? 1);
