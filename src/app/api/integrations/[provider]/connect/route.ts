import { getSessionUser } from "@/lib/auth";
import { getCtx } from "@/lib/tenant";
import { PROVIDERS } from "@/lib/integrations/providers";
import { callbackUrl, makeOAuthState } from "@/lib/integrations/service";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const p = PROVIDERS[provider];
  const back = (q: string) => Response.redirect(`${env.appUrl}/integrations?${q}`, 302);
  if (!p || p.authType !== "oauth" || !p.authUrl) return back("error=unknown");
  if (!(await getSessionUser())) return Response.redirect(`${env.appUrl}/login?expired=1`, 302);
  const ctx = await getCtx();
  if (!ctx || !ctx.can("manage_integrations")) return back("error=forbidden");
  if (!p.isConfigured()) return back("error=needs_config");
  return Response.redirect(p.authUrl(makeOAuthState(ctx.workspaceId, ctx.user.id, provider), callbackUrl(provider)), 302);
}
