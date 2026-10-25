// Passe 2 / B : après un rejet serveur, les valeurs soumises reviennent dans l'état de l'action — offre et onboarding SEULEMENT.
// Les autres actions ne renvoient pas `values` : leurs formulaires gardent exactement leur comportement.
// Exigences : seules les chaînes du formulaire reviennent (ni fichiers, ni champs internes `$ACTION…`) ; aucun retour en cas de succès.
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

import { makeWorkspace, resetDb } from "./helpers";

type R = { ok?: boolean; error?: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };
const fd = (f: Record<string, string>) => { const x = new FormData(); for (const [k, v] of Object.entries(f)) x.set(k, v); return x; };
const redirected = async (p: Promise<R>): Promise<R> => { try { return await p; } catch (e) { if (String((e as Error).message).startsWith("NEXT_REDIRECT")) return { ok: true }; throw e; } };

const ONBOARDING = { name: "Société", industry: "Rénovation", country: "France", language: "fr", currency: "EUR", description: "Rénovation de salles de bain clé en main.", companySize: "2-10", offerName: "Salle de bain", price: "1000", marginPct: "101", audienceType: "b2c", customerType: "Propriétaires de maisons" };

describe("passe 2 / B — valeurs soumises renvoyées après un rejet (offre et onboarding)", () => {
  it("offre : un rejet (marge 101) renvoie les valeurs soumises, sans champs internes ni fichiers", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { saveOfferAction } = await import("@/app/(app)/offers/actions");
    const form = fd({ name: "Offre à conserver", description: "Une description", price: "1000", marginPct: "101", currency: "EUR", $ACTION_ID_abc: "x", "$ACTION_REF_1": "" });
    form.set("fichier", new File(["x"], "a.txt"));
    const r = await redirected(saveOfferAction({}, form));
    expect(r.ok).toBeFalsy();
    expect(r.values).toMatchObject({ name: "Offre à conserver", description: "Une description", price: "1000", marginPct: "101", currency: "EUR" });
    expect(Object.keys(r.values ?? {}).some((k) => k.startsWith("$"))).toBe(false);
    expect(r.values).not.toHaveProperty("fichier");
    expect(Object.values(r.values ?? {}).every((v) => typeof v === "string")).toBe(true);
  });

  it("offre : un rejet pour marge ambiguë non confirmée renvoie aussi les valeurs (champ vidé conservé comme chaîne vide)", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { saveOfferAction } = await import("@/app/(app)/offers/actions");
    const r = await redirected(saveOfferAction({}, fd({ name: "Offre ambiguë", price: "", marginPct: "0.28" })));
    expect(r.ok).toBeFalsy();
    expect(r.values).toMatchObject({ name: "Offre ambiguë", price: "", marginPct: "0.28" });
  });

  it("offre : un succès ne renvoie PAS de valeurs (le formulaire repart de l'état enregistré)", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { saveOfferAction } = await import("@/app/(app)/offers/actions");
    const r = await redirected(saveOfferAction({}, fd({ name: "Offre valide", marginPct: "28" })));
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("values");
  });

  it("onboarding : un rejet renvoie les six champs saisis (secteur, description, offre, prix, marge, type de client)", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { completeOnboardingAction } = await import("@/app/onboarding/actions");
    const r = await redirected(completeOnboardingAction({}, fd(ONBOARDING)));
    expect(r.ok).toBeFalsy();
    expect(r.values).toMatchObject({ industry: "Rénovation", description: "Rénovation de salles de bain clé en main.", offerName: "Salle de bain", price: "1000", marginPct: "101", customerType: "Propriétaires de maisons" });
  });

  it("onboarding : un succès ne renvoie pas de valeurs", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { completeOnboardingAction } = await import("@/app/onboarding/actions");
    const r = await redirected(completeOnboardingAction({}, fd({ ...ONBOARDING, marginPct: "28" })));
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("values");
  });
});

describe("passe 2 / B — les autres actions (donc les autres formulaires) sont inchangées", () => {
  it("création de lead rejetée : aucun `values` dans l'état", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { createLeadAction } = await import("@/app/(app)/leads/actions");
    const r = await redirected(createLeadAction({}, fd({ name: "Sans contact" })));
    expect(r.ok).toBeFalsy();
    expect(r.error).toBeTruthy();
    expect(r).not.toHaveProperty("values");
  });
  it("réglages rejetés (format numérique) : aucun `values` dans l'état", async () => {
    await resetDb();
    const { workspaceId } = await makeWorkspace(); state.ws = workspaceId;
    const { updateWorkspaceAction } = await import("@/app/(app)/settings/actions");
    const r = await updateWorkspaceAction({}, fd({ name: "Société", language: "fr", currency: "EUR", maxCac: "0x10" }));
    expect(r.ok).toBeFalsy();
    expect(r).not.toHaveProperty("values");
  });
});
