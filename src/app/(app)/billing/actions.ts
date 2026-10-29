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
/** L'accès propriétaire gratuit ne passe jamais par l'abonnement : aucune souscription, aucun essai, aucune résiliation n'a de sens (et rien n'est facturé). */
const notExempt = (ctx: { ent: { state: string } }) => { if (ctx.ent.state === "exempt") throw new UserError("Cet espace bénéficie de l'accès propriétaire gratuit : aucune souscription ni modification d'abonnement n'est nécessaire."); };

export async function selectTrialPlanAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(OPTS, async (ctx) => {
    notExempt(ctx);
    const { plan: p } = parse(plan, formObject(fd));
    try { await selectTrialPlan(ctx.workspaceId, p, ctx.user.id); } catch (e) { wrap(e); }
    revalidatePath("/billing");
    return { ok: true, message: "Plan d'essai modifié : ses limites s'appliquent jusqu'à la fin de l'essai. Aucun paiement n'a été effectué." };
  });
}

export async function checkoutAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let url: string | undefined;
  const r = await run(OPTS, async (ctx) => {
    notExempt(ctx);
    const { plan: p } = parse(plan, formObject(fd));
    try { url = await createCheckoutSession({ workspaceId: ctx.workspaceId, plan: p, email: ctx.user.email }); } catch (e) { wrap(e); }
  });
  if (r.ok && url) redirect(url);
  return r;
}

export async function portalAction(): Promise<ActionState> {
  let url: string | undefined;
  const r = await run(OPTS, async (ctx) => { notExempt(ctx); try { url = await createPortalSession(ctx.workspaceId); } catch (e) { wrap(e); } });
  if (r.ok && url) redirect(url);
  return r;
}

export async function changePlanAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(OPTS, async (ctx) => {
    notExempt(ctx);
    const { plan: p } = parse(plan, formObject(fd));
    try { await changePaidPlan(ctx.workspaceId, p, ctx.user.id); } catch (e) { wrap(e); }
    revalidatePath("/billing");
    return { ok: true, message: "Changement demandé à Stripe. Le nouveau forfait s'appliquera dès que Stripe l'aura confirmé (quelques secondes) : actualisez la page." };
  });
}

export async function cancelAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run(OPTS, async (ctx) => {
    notExempt(ctx);
    const { cancel } = parse(z.object({ cancel: z.enum(["1", "0"]) }), formObject(fd));
    try { await setCancelAtPeriodEnd(ctx.workspaceId, cancel === "1", ctx.user.id); } catch (e) { wrap(e); }
    revalidatePath("/billing");
    return { ok: true, message: cancel === "1" ? "Résiliation enregistrée : l'accès reste actif jusqu'à la fin de la période." : "Abonnement repris." };
  });
}
