import { execSync } from "node:child_process";
import { rmSync } from "node:fs";

// Base SQLite dédiée aux tests : recréée à partir du schéma Prisma avant chaque exécution.
export default function setup() {
  for (const f of ["prisma/test.db", "prisma/test.db-journal"]) rmSync(f, { force: true });
  execSync("npx prisma db push --skip-generate", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
}
