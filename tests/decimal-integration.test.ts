// Passe 2bis / B3 : grammaire décimale (« .5 » accepté, « 5. » et notation scientifique refusés) sur les ACTIONS RÉELLES de chaque écran.
// Consommateurs d'optNum (recherche exhaustive) : offres (prix, marge), onboarding (prix, marge, 5 objectifs), réglages (5 objectifs),
// leads (création, mise à jour, passage à « gagné »), campagnes (budget, étape 6). Les règles propres à chaque champ ne changent pas :
// les négatifs restent refusés partout ; un budget doit rester > 0 ; la marge ambiguë (0 < marge < 1) exige toujours la confirmation.
import { describe, expect, it, vi } from "vitest";

const state: { ws: string } = { ws: "" };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireCtx: async () => {
      const { db } = await import("@/lib/db");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: null, ent: { active: true }, can: () => true } as never;
    },
  };
});

import { db } from "@/lib/db";
import { createLead } from "@/lib/leads";
import { makeWorkspace, resetDb } from "./helpers";

type R = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };
const fd = (f: Record<string, string>) => { const x = new FormData(); for (const [k, v] of Object.entries(f)) x.set(k, v); return x; };
const redirectedOk = async (p: Promise<R>): Promise<R> => { try { return await p; } catch (e) { if (String((e as Error).message).startsWith("NEXT_REDIRECT")) return { ok: true }; throw e; } };
const fresh = async () => { await resetDb(); const { workspaceId } = await makeWorkspace(); state.ws = workspaceId; return workspaceId; };
const SCI = /[ée]crivez le nombre en d[ée]cimal, sans notation scientifique/i;
const num = (v: unknown) => { expect(typeof v).toBe("number"); return v as number; };

const saveOffer = async (f: Record<string, string>) => { const { saveOfferAction } = await import("@/app/(app)/offers/actions"); return redirectedOk(saveOfferAction({}, fd({ name: "Offre décimale", ...f }))); };
const onboarding = async (f: Record<string, string>) => {
  const { completeOnboardingAction } = await import("@/app/onboarding/actions");
  return redirectedOk(completeOnboardingAction({}, fd({ name: "Société", industry: "Rénovation", country: "France", language: "fr", currency: "EUR", description: "Rénovation de salles de bain clé en main.", companySize: "2-10", offerName: "Offre décimale", audienceType: "b2c", customerType: "Propriétaires", ...f })));
};
const lastOffer = (ws: string) => db.offer.findFirst({ where: { workspaceId: ws, name: "Offre décimale" }, orderBy: { createdAt: "desc" } });

describe("offre (saveOfferAction) : prix et marge", () => {
  it("prix \".5\" accepté, enregistré comme NOMBRE 0.5 (jamais la chaîne)", async () => {
    const ws = await fresh();
    const r = await saveOffer({ price: ".5" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(num((await lastOffer(ws))!.price)).toBe(0.5);
  });
  it("prix \"05\" → 5, \" .5 \" → 0.5, \"28.0\" → 28 (nombres normalisés)", async () => {
    const ws = await fresh();
    for (const [input, expected] of [["05", 5], [" .5 ", 0.5], ["28.0", 28]] as const) {
      expect((await saveOffer({ price: input })).ok, input).toBe(true);
      expect(num((await lastOffer(ws))!.price), input).toBe(expected);
    }
  });
  it("marge \".28\" : refusée sans confirmation (message d'unité), acceptée avec confirmation, valeur enregistrée 0.28 (nombre)", async () => {
    const ws = await fresh();
    const refused = await saveOffer({ marginPct: ".28" });
    expect(refused.ok).toBeFalsy();
    expect(refused.error ?? "").toMatch(/serait lue comme/);
    expect(await lastOffer(ws)).toBeNull();
    const ok = await saveOffer({ marginPct: ".28", marginPctConfirm: "on" });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(num((await lastOffer(ws))!.marginPct)).toBe(0.28);
  });
  it("« -.5 » est refusé par la règle du champ, pour le prix ET pour la marge (aucune offre créée)", async () => {
    const ws = await fresh();
    const price = await saveOffer({ price: "-.5" });
    expect(price.ok).toBeFalsy();
    expect(price.fieldErrors?.price).toBe("Nombre invalide");
    const margin = await saveOffer({ marginPct: "-.5" });
    expect(margin.ok).toBeFalsy();
    expect(margin.fieldErrors?.marginPct).toBe("Nombre invalide");
    const marginConfirmed = await saveOffer({ marginPct: "-.5", marginPctConfirm: "on" });
    expect(marginConfirmed.ok).toBeFalsy();
    expect(await lastOffer(ws)).toBeNull();
  });
  it("\"5.\" refusé ; notation scientifique refusée AVEC le message explicite (prix et marge)", async () => {
    const ws = await fresh();
    expect((await saveOffer({ price: "5." })).fieldErrors?.price).toBe("Nombre invalide");
    expect((await saveOffer({ price: "1e2" })).fieldErrors?.price).toMatch(SCI);
    expect((await saveOffer({ marginPct: "1e-1" })).fieldErrors?.marginPct).toMatch(SCI);
    expect((await saveOffer({ marginPct: "1e-1", marginPctConfirm: "on" })).fieldErrors?.marginPct).toMatch(SCI);
    expect(await lastOffer(ws)).toBeNull();
  });
});

describe("onboarding (completeOnboardingAction) : prix, marge et objectifs", () => {
  it("prix \".5\" → 0.5 (nombre) ; objectif de budget \".5\" → 0.5 ; objectif CAC \"28.0\" → 28", async () => {
    const ws = await fresh();
    const r = await onboarding({ price: ".5", adBudgetMonthly: ".5", maxCac: "28.0" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(num((await lastOffer(ws))!.price)).toBe(0.5);
    const w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
    expect(num(w.adBudgetMonthly)).toBe(0.5);
    expect(num(w.maxCac)).toBe(28);
  });
  it("marge \".28\" : refusée sans confirmation, acceptée avec, valeur 0.28", async () => {
    const ws = await fresh();
    const refused = await onboarding({ marginPct: ".28" });
    expect(refused.ok).toBeFalsy();
    expect(refused.error ?? "").toMatch(/serait lue comme/);
    expect(await lastOffer(ws)).toBeNull();
    const ok = await onboarding({ marginPct: ".28", marginPctConfirm: "on" });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(num((await lastOffer(ws))!.marginPct)).toBe(0.28);
  });
  it("« -.5 » refusé pour le prix, la marge et un objectif ; \"5.\" et \"1e2\" refusés (message explicite pour l'exponentielle)", async () => {
    const ws = await fresh();
    expect((await onboarding({ price: "-.5" })).fieldErrors?.price).toBe("Nombre invalide");
    expect((await onboarding({ marginPct: "-.5" })).fieldErrors?.marginPct).toBe("Nombre invalide");
    expect((await onboarding({ revenueGoal: "-.5" })).fieldErrors?.revenueGoal).toBe("Nombre invalide");
    expect((await onboarding({ price: "5." })).fieldErrors?.price).toBe("Nombre invalide");
    expect((await onboarding({ maxCac: "1e2" })).fieldErrors?.maxCac).toMatch(SCI);
    expect((await onboarding({ marginPct: "1e-1", marginPctConfirm: "on" })).fieldErrors?.marginPct).toMatch(SCI);
    expect(await lastOffer(ws)).toBeNull();
  });
});

describe("réglages (updateWorkspaceAction) : objectifs", () => {
  const base = { name: "Société", language: "fr", currency: "EUR" };
  it("\".5\" accepté et enregistré comme nombre ; « -.5 », \"5.\" et \"1e2\" refusés ; les objectifs existants ne sont pas modifiés par un refus", async () => {
    const ws = await fresh();
    const { updateWorkspaceAction } = await import("@/app/(app)/settings/actions");
    const ok = await updateWorkspaceAction({}, fd({ ...base, adBudgetMonthly: ".5", maxCac: "28.0" }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    let w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
    expect(num(w.adBudgetMonthly)).toBe(0.5);
    expect(num(w.maxCac)).toBe(28);
    expect((await updateWorkspaceAction({}, fd({ ...base, adBudgetMonthly: "-.5" }))).fieldErrors?.adBudgetMonthly).toBe("Nombre invalide");
    expect((await updateWorkspaceAction({}, fd({ ...base, adBudgetMonthly: "5." }))).fieldErrors?.adBudgetMonthly).toBe("Nombre invalide");
    expect((await updateWorkspaceAction({}, fd({ ...base, revenueGoal: "1e2" }))).fieldErrors?.revenueGoal).toMatch(SCI);
    w = await db.workspace.findUniqueOrThrow({ where: { id: ws } });
    expect(num(w.adBudgetMonthly)).toBe(0.5);
  });
});

describe("leads : création, mise à jour, passage à « gagné »", () => {
  it("création : valeur \".5\" → 0.5 (nombre) ; « -.5 », \"5.\" refusés (aucun lead) ; \"1e2\" refusé avec le message explicite", async () => {
    const ws = await fresh();
    const { createLeadAction } = await import("@/app/(app)/leads/actions");
    const mk = (email: string, value: string) => redirectedOk(createLeadAction({}, fd({ name: "L", email, value })));
    expect((await mk("a@x.com", ".5")).ok).toBe(true);
    expect(num((await db.lead.findFirstOrThrow({ where: { workspaceId: ws, email: "a@x.com" } })).value)).toBe(0.5);
    for (const [email, value] of [["b@x.com", "-.5"], ["c@x.com", "5."]] as const) {
      expect((await mk(email, value)).ok, value).toBeFalsy();
      expect(await db.lead.count({ where: { workspaceId: ws, email } }), value).toBe(0);
    }
    expect((await mk("d@x.com", "1e2")).fieldErrors?.value).toMatch(SCI);
  });
  it("mise à jour : valeur \".5\" → 0.5 ; « -.5 » refusé sans toucher la valeur existante", async () => {
    const ws = await fresh();
    const { lead } = await createLead({ workspaceId: ws, name: "Maj", email: "maj@x.com", value: 500 });
    const { updateLeadAction } = await import("@/app/(app)/leads/actions");
    const bad = await updateLeadAction({}, fd({ id: lead.id, name: "Maj", email: "maj@x.com", value: "-.5" }));
    expect(bad.ok).toBeFalsy();
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).value).toBe(500);
    const ok = await updateLeadAction({}, fd({ id: lead.id, name: "Maj", email: "maj@x.com", value: ".5" }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(num((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).value)).toBe(0.5);
  });
  it("passage à « gagné » : \".5\" → valeur 0.5 ; « 5. » et « -.5 » refusés SANS écraser la valeur existante ni changer le statut (cas qui l'écrasait par 0)", async () => {
    const ws = await fresh();
    const { changeStatusAction } = await import("@/app/(app)/leads/actions");
    const { lead } = await createLead({ workspaceId: ws, name: "Gagné", email: "g@x.com", value: 500 });
    for (const value of ["5.", "-.5", "1e2"]) {
      const r = await changeStatusAction({}, fd({ id: lead.id, status: "won", value }));
      expect(r.ok, value).toBeFalsy();
      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.value, value).toBe(500);
      expect(after.status, value).not.toBe("won");
    }
    const ok = await changeStatusAction({}, fd({ id: lead.id, status: "won", value: ".5" }));
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    const won = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(won.status).toBe("won");
    expect(num(won.value)).toBe(0.5);
  });
});

describe("campagne, étape 6 : budget", () => {
  it("budget \".5\" accepté (> 0) et enregistré comme nombre ; « -.5 », \"5.\" refusés ; \"1e2\" refusé avec le message explicite ; budget 0 reste refusé (« Budget requis »)", async () => {
    const ws = await fresh();
    const c = await db.campaign.create({ data: { workspaceId: ws, name: "Brouillon", status: "draft" } });
    const { saveCampaignStepAction } = await import("@/app/(app)/campaigns/actions");
    const step6 = (budget: string) => redirectedOk(saveCampaignStepAction({}, fd({ id: c.id, step: "6", budget, budgetType: "monthly" })));
    expect((await step6("-.5")).ok).toBeFalsy();
    expect((await step6("5.")).ok).toBeFalsy();
    expect((await step6("1e2")).fieldErrors?.budget).toMatch(SCI);
    expect((await step6("0")).fieldErrors?.budget).toBe("Budget requis");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).budget).toBeNull();
    const ok = await step6(".5");
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(num((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).budget)).toBe(0.5);
  });
});
