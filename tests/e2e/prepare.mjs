// Recrée la base SQLite des tests E2E avant le démarrage du serveur (Playwright lance le serveur avant tout globalSetup).
import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

for (const f of ["prisma/e2e.db", "prisma/e2e.db-journal"]) rmSync(f, { force: true });
execSync("npx prisma db push --skip-generate", { stdio: "pipe", env: { ...process.env, DATABASE_URL: "file:./e2e.db" } });
