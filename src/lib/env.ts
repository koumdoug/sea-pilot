// Lecture centralisée des variables d'environnement. Aucune clé secrète n'est jamais exposée au navigateur.
const opt = (k: string) => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : undefined;
};
const int = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const num = (k: string) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

export const env = {
  get appUrl() { return (opt("APP_URL") ?? "http://localhost:3000").replace(/\/$/, ""); },
  get isProd() { return process.env.NODE_ENV === "production"; },
  get sessionSecret() {
    const s = opt("SESSION_SECRET");
    if (!s || s.length < 32) throw new Error("SESSION_SECRET manquant ou trop court (>= 32 caractères). Voir .env.example");
    return s;
  },
  get encryptionKey() { return opt("ENCRYPTION_KEY") ?? this.sessionSecret; },
  get cronSecret() { return opt("CRON_SECRET"); },
  get trialDays() { return int("TRIAL_DAYS", 14); },
  // IA
  get aiProvider() { return (opt("AI_PROVIDER") ?? "").toLowerCase(); }, // openai | anthropic | gemini | "" (premier fournisseur configuré)
  get openaiKey() { return opt("OPENAI_API_KEY"); },
  get openaiModel() { return opt("OPENAI_MODEL"); },
  get openaiBaseUrl() { return (opt("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, ""); },
  get anthropicKey() { return opt("ANTHROPIC_API_KEY"); },
  get anthropicModel() { return opt("ANTHROPIC_MODEL"); },
  get geminiKey() { return opt("GEMINI_API_KEY"); },
  get geminiModel() { return opt("GEMINI_MODEL"); },
  get aiTimeoutMs() { return int("AI_TIMEOUT_MS", 60000); },
  get aiMaxOutputTokens() { return int("AI_MAX_OUTPUT_TOKENS", 4000); },
  get aiDailyLimitPerWorkspace() { return int("AI_DAILY_LIMIT_PER_WORKSPACE", 200); },
  get aiRatePerMinute() { return int("AI_RATE_LIMIT_PER_MIN", 10); },
  get aiPricePerMTokIn() { return num("AI_PRICE_IN_PER_MTOK"); },
  get aiPricePerMTokOut() { return num("AI_PRICE_OUT_PER_MTOK"); },
  // E-mail
  get resendKey() { return opt("RESEND_API_KEY"); },
  get emailFrom() { return opt("EMAIL_FROM"); },
  // Stripe
  get stripeSecret() { return opt("STRIPE_SECRET_KEY"); },
  get stripeWebhookSecret() { return opt("STRIPE_WEBHOOK_SECRET"); },
  stripePriceId(plan: string) { return opt(`STRIPE_PRICE_${plan.toUpperCase()}`); },
  planPriceLabel(plan: string) { return opt(`PLAN_${plan.toUpperCase()}_PRICE_LABEL`); },
  // OAuth / intégrations
  get googleClientId() { return opt("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return opt("GOOGLE_CLIENT_SECRET"); },
  get googleAdsDeveloperToken() { return opt("GOOGLE_ADS_DEVELOPER_TOKEN"); },
  get metaAppId() { return opt("META_APP_ID"); },
  get metaAppSecret() { return opt("META_APP_SECRET"); },
  get tiktokAppId() { return opt("TIKTOK_APP_ID"); },
  get tiktokAppSecret() { return opt("TIKTOK_APP_SECRET"); },
  get legalEntity() { return opt("LEGAL_ENTITY_NAME") ?? "l'éditeur de SEA Pilot"; },
  get legalContactEmail() { return opt("LEGAL_CONTACT_EMAIL"); },
};
