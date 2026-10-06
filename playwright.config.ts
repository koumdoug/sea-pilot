import { defineConfig } from "@playwright/test";

// Tests E2E : serveur de production (`npm run build` d'abord) sur une base SQLite dédiée (prisma/e2e.db), recréée à chaque exécution.
// Utilise Google Chrome installé (channel "chrome") : aucun téléchargement de navigateur.
const PORT = 3101;
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `node tests/e2e/prepare.mjs && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: "file:./e2e.db", SESSION_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789", APP_URL: `http://localhost:${PORT}`, CRON_SECRET: "e2e-cron-secret", LOG_LEVEL: "silent", NODE_ENV: "production",
      OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", STRIPE_SECRET_KEY: "", RESEND_API_KEY: "", META_APP_ID: "", GOOGLE_CLIENT_ID: "", TIKTOK_APP_ID: "",
    },
  },
});
