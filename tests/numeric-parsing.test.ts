// Passe 1 / section 4 : parsing numérique partagé (optNum, src/lib/action.ts).
// Consommateurs réels de optNum (inventaire par recherche dans le code) :
//   offres (prix, marge), onboarding (prix, marge, 5 objectifs), réglages (5 objectifs),
//   leads (valeur à la création et au changement de statut), campagnes (budget, étape 6).
// Résultats attendus (référence = cahier des charges, pas le code) : une valeur absente ne devient jamais zéro ;
// formats non décimaux (hexadécimal, notation scientifique, NaN, Infinity) refusés ; -0 normalisé en 0 ; limites métier inchangées.
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
import { optNum } from "@/lib/action";
import { createLead } from "@/lib/leads";
import { makeWorkspace, resetDb } from "./helpers";

const parsed = (v: unknown) => optNum.safeParse(v);
const fd = (f: Record<string, string>) => { const x = new FormData(); for (const [k, v] of Object.entries(f)) x.set(k, v); return x; };
type R = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };
const redirected = async (p: Promise<R>): Promise<R> => { try { return await p; } catch (e) { if (String((e as Error).message).startsWith("NEXT_REDIRECT")) return { ok: true }; throw e; } };

describe("optNum : parseur partagé (unitaire)", () => {
  it("chaîne vide, espaces seuls ou valeur absente : absente (undefined), jamais zéro", () => {
    for (const v of ["", "   ", "\t", " \n ", undefined]) {
      const r = parsed(v);
      expect(r.success, JSON.stringify(v)).toBe(true);
      expect(r.success && r.data, JSON.stringify(v)).toBeUndefined();
    }
  });
  it("espaces extérieurs acceptés et normalisés : \" 28 \" → 28, \" 1000 \" → 1000, \" 12.5\" → 12.5", () => {
    expect(parsed(" 28 ")).toMatchObject({ success: true, data: 28 });
    expect(parsed(" 1000 ")).toMatchObject({ success: true, data: 1000 });
    expect(parsed(" 12.5")).toMatchObject({ success: true, data: 12.5 });
  });
  it("0 accepté et conservé ; \"-0\" accepté mais normalisé en 0 (jamais -0)", () => {
    expect(parsed("0")).toMatchObject({ success: true, data: 0 });
    const r = parsed("-0");
    expect(r.success).toBe(true);
    expect(Object.is(r.success && r.data, 0)).toBe(true);
    expect(Object.is(parsed(-0).success && (parsed(-0) as { data: number }).data, 0)).toBe(true);
  });
  it("décimaux normaux acceptés : \"28.55\", \"0.28\", \"100\", \"1000000\" ; nombres JS conservés", () => {
    for (const [s, n] of [["28.55", 28.55], ["0.28", 0.28], ["100", 100], ["1000000", 1_000_000]] as const) expect(parsed(s)).toMatchObject({ success: true, data: n });
    expect(parsed(5)).toMatchObject({ success: true, data: 5 });
  });
  it("formats non conformes refusés : \"0x10\", \"1e-1\", \"1e3\", \"NaN\", \"Infinity\", \"abc\", \"28 %\", \"12 5\", \"1_000\"", () => {
    for (const v of ["0x10", "1e-1", "1e3", "NaN", "Infinity", "-Infinity", "abc", "28 %", "12 5", "1_000", "0b11", "0o7"]) {
      const r = parsed(v);
      expect(r.success, v).toBe(false);
    }
  });
  it("limite métier existante inchangée : valeur négative refusée (« Nombre invalide »), virgule décimale toujours refusée", () => {
    for (const v of ["-5", "-0.1", "0,28"]) {
      const r = parsed(v);
      expect(r.success, v).toBe(false);
      expect(!r.success && r.error.issues[0].message, v).toBe("Nombre invalide");
    }
  });
});

describe("optNum : consommateurs réels (actions serveur, base de test locale)", () => {
  it("réglages : objectifs « espaces seuls » → null (jamais 0) ; \" 250 \" → 250 ; format hexadécimal refusé", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { updateWorkspaceAction } = await import("@/app/(app)/settings/actions");
    const base = { name: "Société", language: "fr", currency: "EUR" };
    const r = await updateWorkspaceAction({}, fd({ ...base, adBudgetMonthly: "   ", maxCac: "   ", revenueGoal: " 250 ", goalLeadsPerMonth: "   ", goalSalesPerMonth: "" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const w = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(w.adBudgetMonthly).toBeNull();
    expect(w.maxCac).toBeNull();
    expect(w.revenueGoal).toBe(250);
    expect(w.goalLeadsPerMonth).toBeNull();
    const bad = await updateWorkspaceAction({}, fd({ ...base, maxCac: "0x10" }));
    expect(bad.ok).toBeFalsy();
    expect(bad.fieldErrors?.maxCac).toBe("Nombre invalide");
  });

  it("création de lead : valeur « espaces seuls » → null (jamais 0) ; \" 500 \" → 500 ; \"1e2\" refusé", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { createLeadAction } = await import("@/app/(app)/leads/actions");
    expect((await redirected(createLeadAction({}, fd({ name: "A", email: "a@x.com", value: "   " })))).ok).toBe(true);
    expect((await db.lead.findFirstOrThrow({ where: { workspaceId, email: "a@x.com" } })).value).toBeNull();
    expect((await redirected(createLeadAction({}, fd({ name: "B", email: "b@x.com", value: " 500 " })))).ok).toBe(true);
    expect((await db.lead.findFirstOrThrow({ where: { workspaceId, email: "b@x.com" } })).value).toBe(500);
    const bad = await redirected(createLeadAction({}, fd({ name: "C", email: "c@x.com", value: "1e2" })));
    expect(bad.ok).toBeFalsy();
    expect(await db.lead.count({ where: { workspaceId, email: "c@x.com" } })).toBe(0);
  });

  it("passage d'un lead à « gagné » : un montant « espaces seuls » ne remplace PAS la valeur existante par 0", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { lead } = await createLead({ workspaceId, name: "V", email: "v@x.com", value: 500 });
    const { changeStatusAction } = await import("@/app/(app)/leads/actions");
    const r = await changeStatusAction({}, fd({ id: lead.id, status: "won", value: "   " }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).toBe("won");
    expect(after.value).toBe(500);
  });

  it("campagne, étape 6 : budget « espaces seuls » refusé (« Budget requis ») ; \" 120 \" accepté ; \"0x10\" refusé", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const c = await db.campaign.create({ data: { workspaceId, name: "Brouillon", status: "draft" } });
    const { saveCampaignStepAction } = await import("@/app/(app)/campaigns/actions");
    const step6 = (budget: string) => redirected(saveCampaignStepAction({}, fd({ id: c.id, step: "6", budget, budgetType: "monthly" })));
    const empty = await step6("   ");
    expect(empty.ok).toBeFalsy();
    expect(empty.fieldErrors?.budget).toBe("Budget requis");
    const hex = await step6("0x10");
    expect(hex.ok).toBeFalsy();
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).budget).not.toBe(16);
    const ok = await step6(" 120 ");
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).budget).toBe(120);
  });
});
