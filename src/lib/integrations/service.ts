import type { Integration } from "@prisma/client";
import { db } from "../db";
import { env } from "../env";
import { decryptJson, encryptJson, signToken, verifyToken } from "../crypto";
import { audit } from "../audit";
import { log, errMsg } from "../logger";
import { PROVIDERS, PROVIDER_ORDER } from "./providers";
import { IntegrationError, type ConnectResult, type Credentials, type DateRange } from "./types";

export type IntegrationState = "needs_config" | "disconnected" | "connected" | "error" | "expired";

export type IntegrationView = {
  provider: string; label: string; description: string; category: string; authType: string; requiredEnv: string[];
  fields: { key: string; label: string; secret?: boolean; placeholder?: string; required?: boolean }[];
  state: IntegrationState; accountName: string | null; config: Record<string, unknown>; lastSyncAt: Date | null; lastError: string | null; connectedAt: Date | null;
};

export function stateOf(configured: boolean, row: Pick<Integration, "status"> | null): IntegrationState {
  if (!configured) return "needs_config"; // identifiants de la plateforme absents : on n'affiche JAMAIS « connecté »
  if (!row || row.status === "disconnected") return "disconnected";
  return row.status as IntegrationState;
}

export async function listIntegrations(workspaceId: string): Promise<IntegrationView[]> {
  const rows = await db.integration.findMany({ where: { workspaceId } });
  return PROVIDER_ORDER.map((id) => {
    const p = PROVIDERS[id];
    const row = rows.find((r) => r.provider === id) ?? null;
    const cfg = (row?.config as Record<string, unknown> | null) ?? {};
    return {
      provider: id, label: p.label, description: p.description, category: p.category, authType: p.authType, requiredEnv: p.requiredEnv, fields: p.fields ?? [],
      state: stateOf(p.isConfigured(), row), accountName: row?.accountName ?? null, config: cfg, lastSyncAt: row?.lastSyncAt ?? null, lastError: row?.lastError ?? null, connectedAt: row?.connectedAt ?? null,
    };
  });
}

export function callbackUrl(provider: string) { return `${env.appUrl}/api/integrations/${provider}/callback`; }

export function makeOAuthState(workspaceId: string, userId: string, provider: string): string {
  return signToken(`o|${workspaceId}|${userId}|${provider}|${Date.now() + 10 * 60_000}`);
}
export function readOAuthState(state: string): { workspaceId: string; userId: string; provider: string } | null {
  const raw = verifyToken(state);
  const [t, workspaceId, userId, provider, exp] = (raw ?? "").split("|");
  if (t !== "o" || !workspaceId || !userId || !provider || Number(exp) < Date.now()) return null;
  return { workspaceId, userId, provider };
}

export async function saveConnection(workspaceId: string, provider: string, r: ConnectResult, actorId?: string | null) {
  const data = {
    status: "connected", credentials: encryptJson(r.credentials), accountName: r.accountName ?? null, externalAccountId: r.externalAccountId ?? null,
    connectedAt: new Date(), lastError: null, expiresAt: r.credentials.expiresAt ? new Date(r.credentials.expiresAt) : null,
  };
  const row = await db.integration.upsert({
    where: { workspaceId_provider: { workspaceId, provider } },
    create: { workspaceId, provider, ...data, config: (r.config ?? {}) as object }, update: { ...data, ...(r.config ? { config: r.config as object } : {}) },
  });
  await audit({ workspaceId, userId: actorId, action: "integration.connected", entity: "Integration", entityId: row.id, meta: { provider } });
  return row;
}

export async function saveIntegrationConfig(workspaceId: string, provider: string, config: Record<string, unknown>) {
  const row = await db.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  if (!row) throw new IntegrationError("Connectez d'abord le compte.");
  return db.integration.update({ where: { id: row.id }, data: { config: { ...((row.config as object) ?? {}), ...config } as object } });
}

export async function disconnectIntegration(workspaceId: string, provider: string, actorId?: string | null) {
  const row = await db.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  if (!row) return;
  await db.integration.update({ where: { id: row.id }, data: { status: "disconnected", credentials: null, accountName: null, expiresAt: null, lastError: null } });
  await audit({ workspaceId, userId: actorId, action: "integration.disconnected", entity: "Integration", entityId: row.id, meta: { provider } });
}

/** Identifiants valides : rafraîchit le jeton s'il expire dans moins de 2 minutes. */
export async function getValidCredentials(row: Integration): Promise<Credentials> {
  if (!row.credentials) throw new IntegrationError("Intégration non connectée.");
  let c = decryptJson<Credentials>(row.credentials);
  const p = PROVIDERS[row.provider];
  if (c.expiresAt && c.expiresAt - Date.now() < 120_000 && p?.refresh) {
    c = await p.refresh(c);
    await db.integration.update({ where: { id: row.id }, data: { credentials: encryptJson(c), expiresAt: c.expiresAt ? new Date(c.expiresAt) : null } });
  }
  return c;
}

/** Rafraîchit et vérifie une intégration ; met à jour son état (connected / expired / error). */
export async function refreshIntegration(workspaceId: string, provider: string) {
  const row = await db.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  const p = PROVIDERS[provider];
  if (!row || !p || row.status === "disconnected") throw new IntegrationError("Intégration non connectée.");
  try {
    const c = await getValidCredentials(row);
    await p.check?.(c, (row.config as Record<string, unknown>) ?? {});
    await db.integration.update({ where: { id: row.id }, data: { status: "connected", lastError: null } });
  } catch (e) {
    const expired = e instanceof IntegrationError && e.expired;
    await db.integration.update({ where: { id: row.id }, data: { status: expired ? "expired" : "error", lastError: errMsg(e).slice(0, 300) } });
    throw e;
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
export function lastDaysRange(days: number, now = new Date()): DateRange { return { from: iso(new Date(now.getTime() - (days - 1) * 86_400_000)), to: iso(now) }; }

/** Synchronise les métriques publicitaires d'une plateforme (upsert idempotent). */
export async function syncIntegration(workspaceId: string, provider: string, range: DateRange = lastDaysRange(30)): Promise<{ rows: number; campaigns: number }> {
  const row = await db.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider } } });
  const p = PROVIDERS[provider];
  if (!row || !p?.fetchMetrics || row.status === "disconnected") throw new IntegrationError("Intégration non connectée ou sans synchronisation.");
  try {
    const c = await getValidCredentials(row);
    const cfg = (row.config as Record<string, unknown>) ?? {};
    const rows = await p.fetchMetrics(c, cfg, range);

    const accountExt = String(cfg.adAccountId ?? cfg.customerId ?? cfg.advertiserId ?? "");
    const account = accountExt ? await db.adAccount.upsert({
      where: { workspaceId_platform_externalId: { workspaceId, platform: provider, externalId: accountExt } },
      create: { workspaceId, integrationId: row.id, platform: provider, externalId: accountExt, name: row.accountName }, update: { integrationId: row.id },
    }) : null;

    const seen = new Map<string, { id: string; campaignId: string | null }>();
    for (const r of rows) {
      let ac = seen.get(r.externalCampaignId);
      if (!ac) {
        const up = await db.adCampaign.upsert({
          where: { workspaceId_platform_externalId: { workspaceId, platform: provider, externalId: r.externalCampaignId } },
          create: { workspaceId, platform: provider, externalId: r.externalCampaignId, name: r.campaignName, adAccountId: account?.id }, update: { name: r.campaignName },
        });
        ac = { id: up.id, campaignId: up.campaignId }; seen.set(r.externalCampaignId, ac);
      }
      const dedupeKey = `integration:${provider}:${r.externalCampaignId}:${r.date}`;
      const date = new Date(`${r.date}T00:00:00.000Z`);
      await db.metric.upsert({
        where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
        create: { workspaceId, dedupeKey, campaignId: ac.campaignId, adCampaignId: ac.id, platform: provider === "meta_ads" ? "meta_ads" : provider, date, spend: r.spend, impressions: r.impressions, clicks: r.clicks, source: `integration:${provider}` },
        update: { spend: r.spend, impressions: r.impressions, clicks: r.clicks, campaignId: ac.campaignId },
      });
    }
    await db.integration.update({ where: { id: row.id }, data: { lastSyncAt: new Date(), lastError: null, status: "connected" } });
    log.info("integration.synced", { workspaceId, provider, rows: rows.length });
    return { rows: rows.length, campaigns: seen.size };
  } catch (e) {
    const expired = e instanceof IntegrationError && e.expired;
    await db.integration.update({ where: { id: row.id }, data: { status: expired ? "expired" : "error", lastError: errMsg(e).slice(0, 300) } });
    throw e;
  }
}

/** Associe une campagne de plateforme à une campagne SEA Pilot et rattache ses métriques existantes. */
export async function linkAdCampaign(workspaceId: string, adCampaignId: string, campaignId: string | null) {
  const ac = await db.adCampaign.findFirst({ where: { id: adCampaignId, workspaceId } });
  if (!ac) throw new IntegrationError("Campagne de plateforme introuvable.");
  if (campaignId) {
    const c = await db.campaign.findFirst({ where: { id: campaignId, workspaceId }, select: { id: true } });
    if (!c) throw new IntegrationError("Campagne introuvable.");
  }
  await db.adCampaign.update({ where: { id: ac.id }, data: { campaignId } });
  await db.metric.updateMany({ where: { workspaceId, adCampaignId: ac.id }, data: { campaignId } });
}
