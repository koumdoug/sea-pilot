import { getCtx } from "@/lib/tenant";
import { getSessionUser } from "@/lib/auth";
import { exportUser, exportWorkspace } from "@/lib/data-export";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** GET /api/export?scope=workspace|me — téléchargement JSON (portabilité RGPD). */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Non authentifié." }, { status: 401 });
  if (!rateLimit(`export:${user.id}`, 5, 10 * 60_000).ok) return Response.json({ error: "Trop d'exports. Réessayez plus tard." }, { status: 429 });
  const scope = new URL(req.url).searchParams.get("scope") ?? "workspace";
  let data: unknown;
  let name: string;
  if (scope === "me") { data = await exportUser(user.id); name = "sea-pilot-mes-donnees"; }
  else {
    const ctx = await getCtx();
    if (!ctx || !ctx.can("manage_settings")) return Response.json({ error: "Permission refusée." }, { status: 403 });
    data = await exportWorkspace(ctx.workspaceId);
    name = `sea-pilot-export-${ctx.workspace.slug}`;
    await audit({ workspaceId: ctx.workspaceId, userId: user.id, action: "data.exported" });
  }
  return new Response(JSON.stringify(data, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.json"`, "cache-control": "no-store" } });
}
