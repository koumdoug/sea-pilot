"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { run, parse, formObject, UserError, type ActionState } from "@/lib/action";
import { PLAN_IDS } from "@/lib/constants";
import { BillingError, changePaidPlan, createCheckoutSession, createPortalSession, selectTrialPlan, setCancelAtPeriodEnd } from "@/lib/billing";
import { errMsg } from "@/lib/logger";

const plan = z.object({ plan: z.enum(PLAN_IDS) });
const wrap = (e: unknown): never => { if (e instanceof BillingError) throw new UserError(e.message); throw new UserError(`Erreur de facturation : ${errMsg(e).slice(0, 160)}`); };
const OPTS = { action: "manage_billing" as const, allowInactive: true };

export async function selectTrialPlanAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(OPTS, async (ctx) => {
    const { plan: p } = parse(plan, formObject(fd));
    try { await selectTrialPlan(ctx.workspaceId, p, ctx.user.id); } catch (e) { wrap(e); }
    revalidatePath("/billing");
    return { ok: true, message: "Plan d'essai modifié." };
  });
}

export async function checkoutAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let url: string | undefined;
  const r = await run(OPTS, async (ctx) => {
    const { plan: p } = parse(plan, formObject(fd));
    try { url = await createCheckoutSession({ workspaceId: ctx.workspaceId, plan: p, email: ctx.user.email }); } catch (e) { wrap(e); }
  });
  if (r.ok && url) redirect(url);
  return r;
}

export async function portalAction(): Promise<ActionState> {
  let url: string | undefined;
  const r = await run(OPTS, async (ctx) => { try { url = await createPortalSession(ctx.workspaceId); } catch (e) { wrap(e); } });
  if (r.ok && url) redirect(url);
  return r;
}

export async function changePlanAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(OPTS, async (ctx) => {
    const { plan: p } = parse(plan, formObject(fd));
    try { await changePaidPlan(ctx.workspaceId, p, ctx.user.id); } catch (e) { wrap(e); }
    revalidatePath("/billing");
    return { ok: true, message: "Plan modifié." };
  });
}

export async function cancelAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(OPTS, async (ctx) => {
    const { cancel } = parse(z.object({ cancel: z.enum(["1", "0"]) }), formObject(fd));
    try { await setCancelAtPeriodEnd(ctx.workspaceId, cancel === "1", ctx.user.id); } catch (e) { wrap(e); }
    revalidatePath("/billing");
    return { ok: true, message: cancel === "1" ? "Résiliation enregistrée : l'accès reste actif jusqu'à la fin de la période." : "Abonnement repris." };
  });
}
