import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Même suite de tests que `vitest.config.mts`, exécutée sur un PostgreSQL JETABLE (verrous, transactions et concurrence réels). Voir docs/validation-postgresql-stripe.md.
// Prérequis : base jetable locale `sea_pilot_throwaway_*`, migrations appliquées, client Prisma généré pour PostgreSQL, PG_THROWAWAY_CONFIRM=yes (garde : tests/global-setup-pg.ts).
export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup-pg.ts"],
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      SESSION_SECRET: "x".repeat(40),
      APP_URL: "http://localhost:3000",
      // Isolation : aucune clé réelle, aucun appel externe payant.
      OPENAI_API_KEY: "", OPENAI_MODEL: "", ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "", AI_PROVIDER: "",
      RESEND_API_KEY: "", EMAIL_FROM: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_STARTER: "price_starter_test", STRIPE_PRICE_GROWTH: "price_growth_test", STRIPE_PRICE_PRO: "price_pro_test",
      GOOGLE_CLIENT_ID: "", META_APP_ID: "", TIKTOK_APP_ID: "",
      LOG_LEVEL: "silent",
    },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
