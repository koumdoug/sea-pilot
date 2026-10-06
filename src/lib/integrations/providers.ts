import { env } from "../env";
import type { Credentials, DateRange, IntegrationProvider, MetricRow, ConnectResult } from "./types";
import { IntegrationError } from "./types";

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  if (res.status === 401 || res.status === 403) throw new IntegrationError(`${what} : accès refusé ou jeton expiré.`, true);
  if (!res.ok) throw new IntegrationError(`${what} : erreur HTTP ${res.status}.`);
  return (await res.json()) as Record<string, unknown>;
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const T = () => AbortSignal.timeout(25_000);

// ───────────── Google OAuth (Analytics + Ads) ─────────────
async function googleExchange(code: string, redirectUri: string): Promise<Credentials> {
  const j = await json(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: T(),
    body: form({ code, client_id: env.googleClientId!, client_secret: env.googleClientSecret!, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  }), "Google OAuth");
  return { accessToken: String(j.access_token), refreshToken: j.refresh_token ? String(j.refresh_token) : undefined, expiresAt: Date.now() + num(j.expires_in) * 1000 };
}
async function googleRefresh(c: Credentials): Promise<Credentials> {
  if (!c.refreshToken) throw new IntegrationError("Aucun jeton de rafraîchissement : reconnectez le compte.", true);
  const j = await json(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: T(),
    body: form({ refresh_token: c.refreshToken, client_id: env.googleClientId!, client_secret: env.googleClientSecret!, grant_type: "refresh_token" }),
  }), "Google OAuth");
  return { ...c, accessToken: String(j.access_token), expiresAt: Date.now() + num(j.expires_in) * 1000 };
}
const googleAuthUrl = (scope: string) => (state: string, redirectUri: string) =>
  `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: env.googleClientId!, redirect_uri: redirectUri, response_type: "code", scope, access_type: "offline", prompt: "consent", state })}`;

// ───────────── Google Analytics 4 ─────────────
export const googleAnalytics: IntegrationProvider = {
  id: "google_analytics", label: "Google Analytics 4", description: "Sessions et conversions de votre site (lecture seule).", category: "analytics", authType: "oauth",
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  fields: [{ key: "propertyId", label: "ID de propriété GA4 (nombre)", placeholder: "123456789", required: true }],
  isConfigured: () => !!(env.googleClientId && env.googleClientSecret),
  authUrl: googleAuthUrl("https://www.googleapis.com/auth/analytics.readonly"),
  exchangeCode: async (code, redirectUri) => ({ credentials: await googleExchange(code, redirectUri), accountName: "Google Analytics" }),
  refresh: googleRefresh,
  check: async (c, cfg) => {
    if (!cfg.propertyId) throw new IntegrationError("ID de propriété GA4 requis.");
    await json(await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(String(cfg.propertyId))}/metadata`, { headers: { authorization: `Bearer ${c.accessToken}` }, signal: T() }), "Google Analytics");
  },
};

/** Sessions GA4 par jour (lecture à la demande, affichée dans Analytics si l'intégration est connectée). */
export async function fetchGaSessions(c: Credentials, propertyId: string, range: DateRange): Promise<{ date: string; sessions: number }[]> {
  const j = await json(await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST", headers: { authorization: `Bearer ${c.accessToken}`, "content-type": "application/json" }, signal: T(),
    body: JSON.stringify({ dateRanges: [{ startDate: range.from, endDate: range.to }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }] }),
  }), "Google Analytics");
  const rows = (j.rows as { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] | undefined) ?? [];
  return rows.map((r) => { const d = r.dimensionValues[0].value; return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: num(r.metricValues[0].value) }; }).sort((a, b) => a.date.localeCompare(b.date));
}

// ───────────── Meta Ads ─────────────
const META = "https://graph.facebook.com/v21.0";
export const metaAds: IntegrationProvider = {
  id: "meta_ads", label: "Meta Ads (Facebook / Instagram)", description: "Dépenses, impressions et clics par campagne.", category: "ads", authType: "oauth",
  requiredEnv: ["META_APP_ID", "META_APP_SECRET"],
  fields: [{ key: "adAccountId", label: "ID du compte publicitaire (act_…)", placeholder: "act_1234567890", required: true }],
  isConfigured: () => !!(env.metaAppId && env.metaAppSecret),
  authUrl: (state, redirectUri) => `https://www.facebook.com/v21.0/dialog/oauth?${form({ client_id: env.metaAppId!, redirect_uri: redirectUri, state, scope: "ads_read", response_type: "code" })}`,
  exchangeCode: async (code, redirectUri) => {
    const short = await json(await fetch(`${META}/oauth/access_token?${form({ client_id: env.metaAppId!, client_secret: env.metaAppSecret!, redirect_uri: redirectUri, code })}`, { signal: T() }), "Meta OAuth");
    const long = await json(await fetch(`${META}/oauth/access_token?${form({ grant_type: "fb_exchange_token", client_id: env.metaAppId!, client_secret: env.metaAppSecret!, fb_exchange_token: String(short.access_token) })}`, { signal: T() }), "Meta OAuth");
    return { credentials: { accessToken: String(long.access_token), expiresAt: Date.now() + (num(long.expires_in) || 5_184_000) * 1000 }, accountName: "Meta Ads" };
  },
  check: async (c, cfg) => {
    if (!cfg.adAccountId) throw new IntegrationError("ID du compte publicitaire requis.");
    await json(await fetch(`${META}/${encodeURIComponent(String(cfg.adAccountId))}?${form({ fields: "name", access_token: c.accessToken! })}`, { signal: T() }), "Meta Ads");
  },
  fetchMetrics: async (c, cfg, range): Promise<MetricRow[]> => {
    const rows: MetricRow[] = [];
    let url: string | null = `${META}/${encodeURIComponent(String(cfg.adAccountId))}/insights?${form({ level: "campaign", time_increment: "1", fields: "campaign_id,campaign_name,spend,impressions,clicks", time_range: JSON.stringify({ since: range.from, until: range.to }), limit: "500", access_token: c.accessToken! })}`;
    for (let page = 0; url && page < 20; page++) {
      const j: Record<string, unknown> = await json(await fetch(url, { signal: T() }), "Meta Ads");
      for (const r of (j.data as Record<string, string>[] | undefined) ?? []) rows.push({ externalCampaignId: r.campaign_id, campaignName: r.campaign_name, date: r.date_start, spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), externalAccountId: String(cfg.adAccountId) });
      url = ((j.paging as { next?: string } | undefined)?.next) ?? null;
    }
    return rows;
  },
};

// ───────────── Google Ads ─────────────
export const googleAds: IntegrationProvider = {
  id: "google_ads", label: "Google Ads", description: "Dépenses, impressions et clics par campagne.", category: "ads", authType: "oauth",
  requiredEnv: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"],
  fields: [
    { key: "customerId", label: "ID client Google Ads (10 chiffres)", placeholder: "1234567890", required: true },
    { key: "loginCustomerId", label: "ID du compte gestionnaire (MCC), si applicable", placeholder: "" },
  ],
  isConfigured: () => !!(env.googleClientId && env.googleClientSecret && env.googleAdsDeveloperToken),
  authUrl: googleAuthUrl("https://www.googleapis.com/auth/adwords"),
  exchangeCode: async (code, redirectUri) => ({ credentials: await googleExchange(code, redirectUri), accountName: "Google Ads" }),
  refresh: googleRefresh,
  check: async (c, cfg) => {
    if (!cfg.customerId) throw new IntegrationError("ID client requis.");
    await googleAdsQuery(c, cfg, "SELECT customer.id FROM customer LIMIT 1");
  },
  fetchMetrics: async (c, cfg, range) => {
    const res = await googleAdsQuery(c, cfg, `SELECT campaign.id, campaign.name, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${range.from}' AND '${range.to}'`);
    return res.map((r) => ({
      externalCampaignId: String((r.campaign as Record<string, unknown>).id), campaignName: String((r.campaign as Record<string, unknown>).name),
      date: String((r.segments as Record<string, unknown>).date), spend: num((r.metrics as Record<string, unknown>).costMicros) / 1_000_000,
      impressions: num((r.metrics as Record<string, unknown>).impressions), clicks: num((r.metrics as Record<string, unknown>).clicks), externalAccountId: String(cfg.customerId),
    }));
  },
};

async function googleAdsQuery(c: Credentials, cfg: Record<string, unknown>, query: string): Promise<Record<string, unknown>[]> {
  const customer = String(cfg.customerId).replace(/\D/g, "");
  const headers: Record<string, string> = { authorization: `Bearer ${c.accessToken}`, "developer-token": env.googleAdsDeveloperToken!, "content-type": "application/json" };
  if (cfg.loginCustomerId) headers["login-customer-id"] = String(cfg.loginCustomerId).replace(/\D/g, "");
  const j = await json(await fetch(`https://googleads.googleapis.com/v18/customers/${customer}/googleAds:search`, { method: "POST", headers, body: JSON.stringify({ query }), signal: T() }), "Google Ads");
  return (j.results as Record<string, unknown>[] | undefined) ?? [];
}

// ───────────── TikTok Ads ─────────────
const TT = "https://business-api.tiktok.com/open_api/v1.3";
export const tiktokAds: IntegrationProvider = {
  id: "tiktok_ads", label: "TikTok Ads", description: "Dépenses, impressions et clics par campagne.", category: "ads", authType: "oauth",
  requiredEnv: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],
  fields: [{ key: "advertiserId", label: "ID annonceur TikTok", placeholder: "7000000000000", required: true }],
  isConfigured: () => !!(env.tiktokAppId && env.tiktokAppSecret),
  authUrl: (state, redirectUri) => `https://business-api.tiktok.com/portal/auth?${form({ app_id: env.tiktokAppId!, state, redirect_uri: redirectUri })}`,
  exchangeCode: async (code) => {
    const j = await json(await fetch(`${TT}/oauth2/access_token/`, { method: "POST", headers: { "content-type": "application/json" }, signal: T(), body: JSON.stringify({ app_id: env.tiktokAppId, secret: env.tiktokAppSecret, auth_code: code }) }), "TikTok OAuth");
    const d = (j.data ?? {}) as Record<string, unknown>;
    if (!d.access_token) throw new IntegrationError("TikTok OAuth : jeton non reçu.");
    return { credentials: { accessToken: String(d.access_token) }, accountName: "TikTok Ads" } satisfies ConnectResult;
  },
  check: async (c, cfg) => {
    if (!cfg.advertiserId) throw new IntegrationError("ID annonceur requis.");
    await json(await fetch(`${TT}/advertiser/info/?${form({ advertiser_ids: JSON.stringify([String(cfg.advertiserId)]) })}`, { headers: { "Access-Token": c.accessToken! }, signal: T() }), "TikTok Ads");
  },
  fetchMetrics: async (c, cfg, range) => {
    const j = await json(await fetch(`${TT}/report/integrated/get/?${form({
      advertiser_id: String(cfg.advertiserId), report_type: "BASIC", data_level: "AUCTION_CAMPAIGN", dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks"]), start_date: range.from, end_date: range.to, page_size: "1000",
    })}`, { headers: { "Access-Token": c.accessToken! }, signal: T() }), "TikTok Ads");
    const list = ((j.data as Record<string, unknown> | undefined)?.list as { dimensions: Record<string, string>; metrics: Record<string, string> }[] | undefined) ?? [];
    return list.map((r) => ({ externalCampaignId: r.dimensions.campaign_id, campaignName: r.metrics.campaign_name, date: r.dimensions.stat_time_day.slice(0, 10), spend: num(r.metrics.spend), impressions: num(r.metrics.impressions), clicks: num(r.metrics.clicks), externalAccountId: String(cfg.advertiserId) }));
  },
};

// ───────────── E-mail (Resend, clé API du client) ─────────────
export const emailProvider: IntegrationProvider = {
  id: "email", label: "E-mail (Resend)", description: "Envoi réel des relances depuis votre propre domaine d'expédition.", category: "email", authType: "api_key",
  requiredEnv: [],
  fields: [
    { key: "apiKey", label: "Clé API Resend", secret: true, required: true, placeholder: "re_…" },
    { key: "from", label: "Expéditeur (domaine vérifié chez Resend)", required: true, placeholder: "Équipe Acme <contact@acme.com>" },
  ],
  isConfigured: () => true,
  connectWithKey: async (input) => {
    const apiKey = (input.apiKey ?? "").trim(), from = (input.from ?? "").trim();
    if (!apiKey || !from) throw new IntegrationError("Clé API et expéditeur requis.");
    if (!/^[^<>@\s]*[^<>]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(from)) throw new IntegrationError("Adresse d'expéditeur invalide.");
    const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${apiKey}` }, signal: T() });
    if (res.status === 401 || res.status === 403) throw new IntegrationError("Clé API Resend refusée.");
    if (!res.ok) throw new IntegrationError(`Resend : erreur HTTP ${res.status}.`);
    return { credentials: { apiKey, from }, accountName: from };
  },
  check: async (c) => {
    const res = await fetch("https://api.resend.com/domains", { headers: { authorization: `Bearer ${c.apiKey}` }, signal: T() });
    if (!res.ok) throw new IntegrationError("Clé API Resend refusée ou service indisponible.", res.status === 401 || res.status === 403);
  },
};

export const PROVIDERS: Record<string, IntegrationProvider> = {
  google_analytics: googleAnalytics, meta_ads: metaAds, google_ads: googleAds, tiktok_ads: tiktokAds, email: emailProvider,
};
export const PROVIDER_ORDER = ["google_analytics", "meta_ads", "google_ads", "tiktok_ads", "email"] as const;
