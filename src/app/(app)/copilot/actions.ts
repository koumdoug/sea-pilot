"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run, parse, formObject, type ActionState } from "@/lib/action";
import { askCopilot } from "@/lib/copilot";

export async function askCopilotAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "ai" }, async (ctx) => {
    const { question } = parse(z.object({ question: z.string().trim().min(5, "Posez une question (5 caractères minimum).").max(600, "Question trop longue (600 caractères max).") }), formObject(fd));
    await askCopilot({ workspace: ctx.workspace, userId: ctx.user.id, question });
    revalidatePath("/copilot");
    return { ok: true };
  });
}
