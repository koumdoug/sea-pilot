"use server";

import { redirect } from "next/navigation";
import { verifyToken } from "@/lib/crypto";
import { unsubscribeLead } from "@/lib/leads";

export async function unsubscribeAction(token: string) {
  const [t, workspaceId, leadId] = (verifyToken(token) ?? "").split("|");
  if (t === "u" && workspaceId && leadId) await unsubscribeLead(workspaceId, leadId, "link");
  redirect(`/unsubscribe/${token}?done=1`);
}
