"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run, parse, formObject, UserError, type ActionState } from "@/lib/action";
import { INTEGRATION_PROVIDERS } from "@/lib/constants";
import { PROVIDERS } from "@/lib/integrations/providers";
import { IntegrationError } from "@/lib/integrations/types";
import { disconnectIntegration, linkAdCampaign, refreshIntegration, saveConnection, saveIntegrationConfig, syncIntegration } from "@/lib/integrations/service";
import { limitReached } from "@/lib/plans";
import { workspaceUsage } from "@/lib/billing";
import { db } from "@/lib/db";
import { errMsg } from "@/lib/logger";

const prov = z.object({ provider: z.enum(INTEGRATION_PROVIDERS) });
const wrap = (e: unknown): never => { if (e instanceof IntegrationError) throw new UserError(e.message); throw new UserError(`Erreur : ${errMsg(e).slice(0, 200)}`); };

export async function connectWithKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const raw = formObject(fd);
    const { provider } = parse(prov, raw);
    const p = PROVIDERS[provider];
    if (!p.connectWithKey) throw new UserError("Ce fournisseur se connecte via OAuth.");
    const existing = await db.integration.findUnique({ where: { workspaceId_provider: { workspaceId: ctx.workspaceId, provider } } });
    if (!existing || existing.status === "disconnected") {
      const usage = await workspaceUsage(ctx.workspaceId);
      if (limitReached(ctx.ent.plan, "integrations", usage.integrations)) throw new UserError("Limite d'intégrations atteinte pour votre plan.");
    }
    try {
      const r = await p.connectWithKey(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)])));
      await saveConnection(ctx.workspaceId, provider, r, ctx.user.id);
    } catch (e) { wrap(e); }
    revalidatePath("/integrations");
    return { ok: true, message: "E-mail connecté : la clé a été vérifiée auprès du fournisseur et stockée chiffrée." };
  });
}

export async function saveConfigAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const raw = formObject(fd);
    const { provider } = parse(prov, raw);
    const p = PROVIDERS[provider];
    const cfg: Record<string, string> = {};
    for (const f of p.fields ?? []) { const v = String(raw[f.key] ?? "").trim(); if (v) cfg[f.key] = v.slice(0, 100); else if (f.required) throw new UserError(`${f.label} requis.`); }
    try { await saveIntegrationConfig(ctx.workspaceId, provider, cfg); await refreshIntegration(ctx.workspaceId, provider); } catch (e) { wrap(e); }
    revalidatePath("/integrations");
    return { ok: true, message: "Configuration vérifiée et enregistrée." };
  });
}

export async function disconnectAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const { provider } = parse(prov, formObject(fd));
    await disconnectIntegration(ctx.workspaceId, provider, ctx.user.id);
    revalidatePath("/integrations");
  });
}

export async function refreshAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const { provider } = parse(prov, formObject(fd));
    try { await refreshIntegration(ctx.workspaceId, provider); } catch (e) { revalidatePath("/integrations"); wrap(e); }
    revalidatePath("/integrations");
    return { ok: true, message: "Connexion vérifiée." };
  });
}

export async function syncAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const { provider } = parse(prov, formObject(fd));
    try {
      const r = await syncIntegration(ctx.workspaceId, provider);
      revalidatePath("/integrations"); revalidatePath("/analytics");
      return { ok: true, message: `${r.rows} ligne(s) de métriques synchronisée(s) pour ${r.campaigns} campagne(s). Associez-les ci-dessous à vos campagnes SEA Pilot.` };
    } catch (e) { revalidatePath("/integrations"); return wrap(e); }
  });
}

export async function linkAdCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const d = parse(z.object({ adCampaignId: z.string(), campaignId: z.string().optional() }), formObject(fd));
    try { await linkAdCampaign(ctx.workspaceId, d.adCampaignId, d.campaignId || null); } catch (e) { wrap(e); }
    revalidatePath("/integrations"); revalidatePath("/analytics"); revalidatePath("/dashboard");
    return { ok: true, message: "Association enregistrée." };
  });
}
