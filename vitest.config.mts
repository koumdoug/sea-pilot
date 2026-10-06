import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: {
      DATABASE_URL: "file:./test.db?connection_limit=1",
      SESSION_SECRET: "x".repeat(40),
      APP_URL: "http://localhost:3000",
      // Isolation : les tests ne lisent JAMAIS de clé réelle — aucun appel externe payant n'est possible.
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
