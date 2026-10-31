import { getSessionUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { can } from "@/lib/permissions";
import { PROVIDERS } from "@/lib/integrations/providers";
import { callbackUrl, readOAuthState, saveConnection, workspaceEntitlement } from "@/lib/integrations/service";
import { IntegrationInactiveError, IntegrationLimitError } from "@/lib/integrations/types";
import { env } from "@/lib/env";
import { log, errMsg } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const url = new URL(req.url);
  const back = (q: string) => Response.redirect(`${env.appUrl}/integrations?${q}`, 302);
  const p = PROVIDERS[provider];
  if (!p?.exchangeCode) return back("error=unknown");
  if (url.searchParams.get("error")) return back("error=denied");

  const state = readOAuthState(url.searchParams.get("state") ?? "");
  const user = await getSessionUser();
  // L'état signé relie le retour OAuth à CET utilisateur et à CET espace : un état volé ou rejoué sur une autre session est refusé.
  if (!state || !user || state.userId !== user.id || state.provider !== provider) return back("error=state");
  const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: state.workspaceId } } });
  if (!m || !can(m.role, "manage_integrations")) return back("error=forbidden");

  const code = url.searchParams.get("code");
  if (!code) return back("error=nocode");
  // Abonnement inactif : refus AVANT l'échange du code avec le fournisseur (aucun jeton émis pour rien) ; saveConnection applique la même règle.
  if (!(await workspaceEntitlement(state.workspaceId)).active) return back("error=inactive");
  try {
    const r = await p.exchangeCode(code, callbackUrl(provider));
    await saveConnection(state.workspaceId, provider, r, user.id);
    return back(`connected=${provider}`);
  } catch (e) {
    if (e instanceof IntegrationLimitError) return back("error=limit");
    if (e instanceof IntegrationInactiveError) return back("error=inactive");
    log.error("integration.callback_failed", { provider, error: errMsg(e) });
    return back("error=exchange");
  }
}
