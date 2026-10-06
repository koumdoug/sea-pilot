import { verifyToken } from "@/lib/crypto";
import { unsubscribeLead } from "@/lib/leads";

export const dynamic = "force-dynamic";

/** Désinscription en un clic (en-tête List-Unsubscribe-Post des clients de messagerie). */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [t, workspaceId, leadId] = (verifyToken(token) ?? "").split("|");
  if (t !== "u" || !workspaceId || !leadId) return new Response("Invalid", { status: 400 });
  await unsubscribeLead(workspaceId, leadId, "one-click");
  return new Response("OK", { status: 200 });
}
