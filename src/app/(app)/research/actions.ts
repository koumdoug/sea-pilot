"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { run, parse, formObject, optStr, UserError, type ActionState } from "@/lib/action";
import { generate } from "@/lib/ai/service";
import { baseSystem, researchPrompt, researchSchema } from "@/lib/ai/prompts";
import { briefOf } from "@/lib/ai/brief";
import { getProvider } from "@/lib/ai/providers";
import { AIError, aiUserMessage } from "@/lib/ai/errors";
import { errMsg } from "@/lib/logger";

function parseCompetitors(raw: string | undefined) {
  return (raw ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 15).map((l) => {
    const [name, url, ...notes] = l.split("|").map((s) => s.trim());
    return { name: name.slice(0, 120), url: url?.slice(0, 300) || undefined, notes: notes.join(" | ").slice(0, 500) || undefined };
  });
}

async function runGeneration(workspaceId: string, userId: string, researchId: string): Promise<string | null> {
  const r = await db.marketResearch.findFirst({ where: { id: researchId, workspaceId } });
  const ws = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!r || !ws) throw new UserError("Étude introuvable.");
  try {
    const g = await generate({
      workspaceId, userId, kind: "research", temperature: 0.5,
      system: baseSystem(briefOf(ws), "analyste de marché"),
      prompt: researchPrompt({ market: r.market, product: r.product ?? undefined, zone: r.zone ?? undefined, clientele: r.clientele ?? undefined, userData: r.userData }),
      schema: researchSchema, input: { researchId },
    });
    await db.marketResearch.update({ where: { id: r.id }, data: { content: g.data as Prisma.InputJsonValue, status: "done", error: null, provider: g.provider, model: g.model } });
    return null;
  } catch (e) {
    const msg = e instanceof AIError ? aiUserMessage(e) : errMsg(e);
    await db.marketResearch.update({ where: { id: r.id }, data: { status: e instanceof AIError && e.code === "not_configured" ? "pending" : "failed", error: msg.slice(0, 300) } });
    return msg;
  }
}

export async function createResearchAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ market: z.string().trim().min(3, "Décrivez le marché").max(300), product: optStr(300), zone: optStr(200), clientele: optStr(300), competitors: z.string().max(3000).optional(), notes: optStr(3000) }), formObject(fd));
    const rec = await db.marketResearch.create({
      data: { workspaceId: ctx.workspaceId, market: d.market, product: d.product, zone: d.zone, clientele: d.clientele, userData: { competitors: parseCompetitors(d.competitors), notes: d.notes ?? null } as Prisma.InputJsonValue },
    });
    id = rec.id;
    if (getProvider() && ctx.can("ai")) await runGeneration(ctx.workspaceId, ctx.user.id, rec.id);
  });
  if (r.ok && id) redirect(`/research/${id}`);
  return r;
}

export async function regenerateResearchAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "ai" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const err = await runGeneration(ctx.workspaceId, ctx.user.id, id);
    revalidatePath(`/research/${id}`);
    if (err) throw new UserError(err);
    return { ok: true, message: "Analyse générée." };
  });
}

export async function deleteResearchAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const r = await run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    await db.marketResearch.deleteMany({ where: { id, workspaceId: ctx.workspaceId } });
    done = true;
  });
  if (done) redirect("/research");
  return r;
}
