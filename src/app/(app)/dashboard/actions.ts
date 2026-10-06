"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { run, type ActionState } from "@/lib/action";

export async function markNotificationsReadAction(): Promise<ActionState> {
  return run({ action: "read" }, async (ctx) => {
    await db.notification.updateMany({ where: { workspaceId: ctx.workspaceId, readAt: null }, data: { readAt: new Date() } });
    revalidatePath("/dashboard");
  });
}
