// Vérifie la configuration (sans jamais afficher de valeur secrète) : npm run check:env
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env")) for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim(); }

const has = (k: string) => !!process.env[k]?.trim();
const rows: [string, boolean, string][] = [
  ["DATABASE_URL", has("DATABASE_URL"), "obligatoire"],
  ["SESSION_SECRET (>= 32 car.)", (process.env.SESSION_SECRET ?? "").length >= 32, "obligatoire"],
  ["APP_URL", has("APP_URL"), "obligatoire en production"],
  ["CRON_SECRET", has("CRON_SECRET"), "relances automatiques et synchronisations"],
  ["IA (OPENAI_*, ANTHROPIC_API_KEY ou GEMINI_*)", (has("OPENAI_API_KEY") && has("OPENAI_MODEL")) || has("ANTHROPIC_API_KEY") || (has("GEMINI_API_KEY") && has("GEMINI_MODEL")), "fonctions IA"],
  ["RESEND_API_KEY + EMAIL_FROM", has("RESEND_API_KEY") && has("EMAIL_FROM"), "e-mails système"],
  ["STRIPE_SECRET_KEY + STRIPE_PRICE_*", has("STRIPE_SECRET_KEY") && has("STRIPE_PRICE_STARTER") && has("STRIPE_PRICE_GROWTH") && has("STRIPE_PRICE_PRO"), "paiement"],
  ["STRIPE_WEBHOOK_SECRET", has("STRIPE_WEBHOOK_SECRET"), "paiement"],
  ["GOOGLE_CLIENT_ID/SECRET", has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET"), "Google Analytics / Ads"],
  ["META_APP_ID/SECRET", has("META_APP_ID") && has("META_APP_SECRET"), "Meta Ads"],
  ["TIKTOK_APP_ID/SECRET", has("TIKTOK_APP_ID") && has("TIKTOK_APP_SECRET"), "TikTok Ads"],
];
for (const [name, ok, use] of rows) console.log(`${ok ? "✅" : "⚠️ "} ${name.padEnd(46)} ${ok ? "configuré" : "absent"}  (${use})`);
const missingRequired = rows.slice(0, 3).some(([, ok]) => !ok);
if (missingRequired) { console.error("\nVariables obligatoires manquantes."); process.exit(1); }
