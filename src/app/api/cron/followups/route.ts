import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";
import { processDueFollowUps } from "@/lib/followups";
import { syncIntegration } from "@/lib/integrations/service";
import { PROVIDERS } from "@/lib/integrations/providers";
import { log, errMsg } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Tâche planifiée (toutes les 5 à 15 minutes) : exécute les relances échues et synchronise les plateformes publicitaires.
 * Protégée par `Authorization: Bearer $CRON_SECRET`.
 */
async function handle(req: Request) {
  const secret = env.cronSecret;
  if (!secret) return Response.json({ error: "CRON_SECRET non configuré." }, { status: 503 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, secret)) return Response.json({ error: "Non autorisé." }, { status: 401 });

  const followups = await processDueFollowUps();
  const syncs: { workspaceId: string; provider: string; ok: boolean }[] = [];
  const url = new URL(req.url);
  if (url.searchParams.get("sync") !== "0") {
    const integ = await db.integration.findMany({ where: { status: "connected" }, select: { workspaceId: true, provider: true } });
    for (const i of integ) {
      if (!PROVIDERS[i.provider]?.fetchMetrics) continue;
      try { await syncIntegration(i.workspaceId, i.provider); syncs.push({ ...i, ok: true }); } catch (e) { log.warn("cron.sync_failed", { provider: i.provider, error: errMsg(e) }); syncs.push({ ...i, ok: false }); }
    }
  }
  return Response.json({ followups, syncs: syncs.length, syncErrors: syncs.filter((s) => !s.ok).length });
}

export const GET = handle;
export const POST = handle;
