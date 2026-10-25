// Passe 1 / sections 4 et 6 : actions réelles d'offre (saveOfferAction) et d'onboarding (completeOnboardingAction).
// Section 4 : tableau des résultats attendus pour la marge (référence = cahier des charges). « Avec confirmation » = case cochée dans la même soumission.
// Section 6 : modification d'une offre existante, comparaison avec la marge ENREGISTRÉE (jamais celle annoncée par le navigateur) et isolation entre espaces.
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
import { makeWorkspace, resetDb } from "./helpers";

type Fields = Record<string, string | undefined>;
type R = { ok?: boolean; error?: string; fieldErrors?: Record<string, string> };
const toFd = (f: Fields) => { const fd = new FormData(); for (const [k, v] of Object.entries(f)) if (v !== undefined) fd.set(k, v); return fd; };
const accepted = (r: R) => r.ok === true;
const redirectedOk = async (p: Promise<R>): Promise<R> => { try { return await p; } catch (e) { if (String((e as Error).message).startsWith("NEXT_REDIRECT")) return { ok: true }; throw e; } };

const saveOffer = async (f: Fields) => { const { saveOfferAction } = await import("@/app/(app)/offers/actions"); return redirectedOk(saveOfferAction({}, toFd({ name: "Offre test", ...f }))); };
const onboarding = async (f: Fields) => {
  const { completeOnboardingAction } = await import("@/app/onboarding/actions");
  return redirectedOk(completeOnboardingAction({}, toFd({ name: "Société", industry: "Rénovation", country: "France", language: "fr", currency: "EUR", description: "Rénovation de salles de bain clé en main.", companySize: "2-10", offerName: "Offre test", audienceType: "b2c", customerType: "Propriétaires", ...f })));
};
const lastOffer = (workspaceId: string, name: string) => db.offer.findFirst({ where: { workspaceId, name }, orderBy: { createdAt: "desc" } });

// [entrée, accepté sans confirmation, accepté avec confirmation, valeur attendue si acceptée]
const TABLE: [string, boolean, boolean, number | null][] = [
  ["", true, true, null],
  ["   ", true, true, null],
  [" 28 ", true, true, 28],
  ["0", true, true, 0],
  ["-0", true, true, 0],
  ["0.28", false, true, 0.28],
  ["0.3", false, true, 0.3],
  ["0.99", false, true, 0.99],
  ["1", true, true, 1],
  ["28", true, true, 28],
  ["28.55", true, true, 28.55],
  ["100", true, true, 100],
  ["100.01", false, false, null],
  ["-5", false, false, null],
  ["0x10", false, false, null],
  ["1e-1", false, false, null],
  ["NaN", false, false, null],
  ["Infinity", false, false, null],
];

describe("section 4 — marge : tableau attendu sur les actions réelles", () => {
  for (const [label, run] of [["offre", (v: string, c: boolean, name: string) => saveOffer({ name, marginPct: v, ...(c ? { marginPctConfirm: "on" } : {}) })], ["onboarding", (v: string, c: boolean, name: string) => onboarding({ offerName: name, marginPct: v, ...(c ? { marginPctConfirm: "on" } : {}) })]] as const) {
    for (const [input, okWithout, okWith, expected] of TABLE) {
      for (const confirmed of [false, true]) {
        const shouldAccept = confirmed ? okWith : okWithout;
        it(`${label} : ${JSON.stringify(input)} ${confirmed ? "avec" : "sans"} confirmation → ${shouldAccept ? `accepté (${expected === null ? "absente / null" : expected})` : "refusé"}`, async () => {
          await resetDb();
          const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
          const name = `Offre ${label} ${Math.random().toString(36).slice(2, 8)}`;
          const r = await run(input, confirmed, name);
          expect(accepted(r), JSON.stringify(r)).toBe(shouldAccept);
          const stored = await lastOffer(workspaceId, name);
          if (shouldAccept) {
            expect(stored, "offre enregistrée").not.toBeNull();
            if (expected === null) expect(stored!.marginPct).toBeNull();
            else { expect(stored!.marginPct).toBe(expected); expect(Object.is(stored!.marginPct, -0)).toBe(false); }
          } else expect(stored, "aucune offre enregistrée").toBeNull();
        });
      }
    }
  }

  it("onboarding : prix et objectifs « espaces seuls » enregistrés comme absents (null), jamais 0", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const r = await onboarding({ offerName: "Offre sans prix", price: "   ", maxCac: "   ", adBudgetMonthly: "   ", revenueGoal: " 900 " });
    expect(accepted(r), JSON.stringify(r)).toBe(true);
    expect((await lastOffer(workspaceId, "Offre sans prix"))!.price).toBeNull();
    const w = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    expect(w.maxCac).toBeNull();
    expect(w.adBudgetMonthly).toBeNull();
    expect(w.revenueGoal).toBe(900);
  });
  it("offre : prix \"0x10\" refusé ; prix « espaces seuls » enregistré comme absent", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    expect(accepted(await saveOffer({ name: "Prix hexa", price: "0x10" }))).toBe(false);
    expect(await lastOffer(workspaceId, "Prix hexa")).toBeNull();
    expect(accepted(await saveOffer({ name: "Prix vide", price: "   " }))).toBe(true);
    expect((await lastOffer(workspaceId, "Prix vide"))!.price).toBeNull();
  });
});

describe("section 6 — modification d'une offre existante", () => {
  const mk = async (marginPct: number | null, name = "Ancienne") => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const offer = await db.offer.create({ data: { workspaceId, name, price: 1000, marginPct, status: "active" } });
    return { workspaceId, offer };
  };
  const reload = (id: string) => db.offer.findUniqueOrThrow({ where: { id } });
  const update = (id: string, f: Fields) => saveOffer({ id, price: "1000", ...f });

  it("1. marge ambiguë INCHANGÉE (0,28) : renommer sans nouvelle confirmation est accepté, la marge reste 0,28", async () => {
    const { offer } = await mk(0.28);
    const r = await update(offer.id, { name: "Renommée", marginPct: "0.28" });
    expect(accepted(r), JSON.stringify(r)).toBe(true);
    const after = await reload(offer.id);
    expect(after.name).toBe("Renommée");
    expect(after.marginPct).toBe(0.28);
  });
  it("1 bis. même chose avec la valeur « 0.280 » (même nombre) : acceptée", async () => {
    const { offer } = await mk(0.28);
    expect(accepted(await update(offer.id, { name: "Renommée 2", marginPct: "0.280" }))).toBe(true);
  });
  it("2. NOUVELLE valeur ambiguë (0,28 → 0,5) : refusée sans confirmation (offre inchangée), acceptée avec confirmation", async () => {
    const { offer } = await mk(0.28);
    const refused = await update(offer.id, { name: "Tentative", marginPct: "0.5" });
    expect(accepted(refused)).toBe(false);
    expect(refused.error ?? "").toMatch(/pourcentage entier/);
    expect(await reload(offer.id)).toMatchObject({ name: "Ancienne", marginPct: 0.28 });
    const ok = await update(offer.id, { name: "Tentative", marginPct: "0.5", marginPctConfirm: "on" });
    expect(accepted(ok), JSON.stringify(ok)).toBe(true);
    expect(await reload(offer.id)).toMatchObject({ name: "Tentative", marginPct: 0.5 });
  });
  it("2 bis. marge valide (28) → nouvelle valeur ambiguë (0,28) : confirmation exigée", async () => {
    const { offer } = await mk(28);
    expect(accepted(await update(offer.id, { name: "Offre modifiée", marginPct: "0.28" }))).toBe(false);
    expect(accepted(await update(offer.id, { name: "Offre modifiée", marginPct: "0.28", marginPctConfirm: "on" }))).toBe(true);
    expect((await reload(offer.id)).marginPct).toBe(0.28);
  });
  it("2 ter. marge absente (null) → première saisie ambiguë (0,28) : confirmation exigée", async () => {
    const { offer } = await mk(null);
    expect(accepted(await update(offer.id, { name: "Offre modifiée", marginPct: "0.28" }))).toBe(false);
    expect((await reload(offer.id)).marginPct).toBeNull();
  });
  it("3. marge valide : règles existantes (28 → 28,55 accepté ; 101 refusé ; vide → null)", async () => {
    const { offer } = await mk(28);
    expect(accepted(await update(offer.id, { name: "V1", marginPct: "28.55" }))).toBe(true);
    expect((await reload(offer.id)).marginPct).toBe(28.55);
    expect(accepted(await update(offer.id, { name: "V2", marginPct: "101" }))).toBe(false);
    expect((await reload(offer.id)).marginPct).toBe(28.55);
    expect(accepted(await update(offer.id, { name: "V3", marginPct: "" }))).toBe(true);
    expect((await reload(offer.id)).marginPct).toBeNull();
  });
  it("3 bis. ambiguë → valide (0,28 → 28) : acceptée sans confirmation", async () => {
    const { offer } = await mk(0.28);
    expect(accepted(await update(offer.id, { name: "Corrigée", marginPct: "28" }))).toBe(true);
    expect((await reload(offer.id)).marginPct).toBe(28);
  });
  it("4. identifiant inexistant : refusé (« Offre introuvable. »), rien n'est créé", async () => {
    const { workspaceId } = await mk(0.28);
    const r = await update("offre-inexistante", { name: "Fantôme", marginPct: "28" });
    expect(accepted(r)).toBe(false);
    expect(r.error).toBe("Offre introuvable.");
    expect(await db.offer.count({ where: { workspaceId, name: "Fantôme" } })).toBe(0);
    const r2 = await update("offre-inexistante", { name: "Fantôme", marginPct: "0.28" });
    expect(accepted(r2)).toBe(false);
  });
  it("5. offre d'un AUTRE espace : refusée (« Offre introuvable. »), sans aucune modification, avec ou sans confirmation, même marge que l'enregistrée", async () => {
    await resetDb();
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const foreign = await db.offer.create({ data: { workspaceId: b.workspaceId, name: "Offre de B", price: 1000, marginPct: 0.28, status: "active" } });
    state.ws = a.workspaceId;
    for (const f of [{ marginPct: "0.28" }, { marginPct: "0.28", marginPctConfirm: "on" }, { marginPct: "28" }, { marginPct: "0.5" }, { marginPct: "0.5", marginPctConfirm: "on" }] as Fields[]) {
      const r = await update(foreign.id, { name: "Piratée", ...f });
      expect(accepted(r), JSON.stringify(f)).toBe(false);
      expect(r.error, JSON.stringify(f)).toBe("Offre introuvable.");
      expect(await reload(foreign.id), JSON.stringify(f)).toMatchObject({ name: "Offre de B", marginPct: 0.28, workspaceId: b.workspaceId });
    }
    expect(await db.offer.count({ where: { workspaceId: a.workspaceId } })).toBe(0);
  });
  it("6. la comparaison utilise la marge ENREGISTRÉE : des champs fournis par le navigateur (marge « précédente », confirmation implicite) sont ignorés", async () => {
    const { offer } = await mk(28);
    const forged = await update(offer.id, { name: "Falsifiée", marginPct: "0.5", currentMarginPct: "0.5", previousMarginPct: "0.5", originalMarginPct: "0.5", marginPctOriginal: "0.5" });
    expect(accepted(forged)).toBe(false);
    expect(await reload(offer.id)).toMatchObject({ name: "Ancienne", marginPct: 28 });
    const { offer: o2 } = await mk(0.28);
    const forged2 = await update(o2.id, { name: "Falsifiée", marginPct: "0.5", currentMarginPct: "0.5", previousMarginPct: "0.5" });
    expect(accepted(forged2)).toBe(false);
    expect(await reload(o2.id)).toMatchObject({ name: "Ancienne", marginPct: 0.28 });
  });
  it("7. confirmation uniquement valable pour la requête : une marge ambiguë inchangée ne dispense pas une AUTRE valeur ambiguë de la case", async () => {
    const { offer } = await mk(0.28);
    expect(accepted(await update(offer.id, { name: "Même", marginPct: "0.28" }))).toBe(true);
    expect(accepted(await update(offer.id, { name: "Autre", marginPct: "0.29" }))).toBe(false);
    expect((await reload(offer.id)).marginPct).toBe(0.28);
  });
});
