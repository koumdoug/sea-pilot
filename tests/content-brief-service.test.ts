// Génération de brief : explicite, journalisée, soumise aux permissions, quotas et erreurs du service IA existant.
// Les tests prouvent des appels (fake.calls) et des lignes AIGeneration, pas seulement un rendu. Base de test dédiée (globalSetup).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string; role: string } = { ws: "", role: "owner" };
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
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan(state.role, opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: state.role, subscription: null, ent: { active: true }, can: (a: import("@/lib/permissions").Action) => can(state.role, a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { AIError } from "@/lib/ai/errors";
import { setAIProviderForTests, type AIProvider, type AIRequest } from "@/lib/ai/providers";
import { generateContentBrief, listGeneratedBriefs, loadBrief } from "@/lib/content-brief-service";
import { generateBriefAction } from "../src/app/(app)/landing-pages/[id]/brief/actions";
import { makeWorkspace, resetDb } from "./helpers";

class Fake implements AIProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  calls: AIRequest[] = [];
  constructor(private replies: (string | Error)[]) {}
  async complete(req: AIRequest) {
    this.calls.push(req);
    const r = this.replies.length > 1 ? this.replies.shift()! : (this.replies[0] ?? "{}");
    if (r instanceof Error) throw r;
    return { text: r, model: this.model, promptTokens: 100, completionTokens: 50 };
  }
}
const GOOD = JSON.stringify({ workingTitle: "Rénover sa salle de bain à Lyon", searchIntent: "transactional", intentRationale: "Le sujet contient « devis ».", audience: "Propriétaires", mainQuestion: "Combien de temps dure un chantier ?", outline: [{ heading: "Introduction", points: ["Réponse directe"] }, { heading: "FAQ", points: [] }], secondaryQuestions: ["Quel budget prévoir ?"], faq: [{ q: "Quel délai ?", a: "Cela dépend du chantier ; 95 % des clients sont satisfaits." }], seoNotes: ["Ajouter une méta-description"], cta: "Demander un devis", assumptions: ["Le public est local"] });

async function seed(name = "Acme", opts: { role?: string } = {}) {
  const w = await makeWorkspace(name, opts);
  state.ws = w.workspaceId; state.role = opts.role ?? "owner";
  const audience = await db.audience.create({ data: { workspaceId: w.workspaceId, name: "Propriétaires lyonnais", objections: "Trop cher" } });
  const offer = await db.offer.create({ data: { workspaceId: w.workspaceId, name: "Rénovation", price: 4900, currency: "EUR", problem: "Chantiers qui dérapent", audienceId: audience.id, status: "active" } });
  const page = await db.landingPage.create({ data: { workspaceId: w.workspaceId, name: "Devis Lyon", slug: `devis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status: "published", offerId: offer.id, seoTitle: "Devis salle de bain Lyon", sections: [{ type: "hero", id: "h", headline: "Devis salle de bain à Lyon", subheadline: "", ctaLabel: "Devis" }] } });
  await db.form.create({ data: { workspaceId: w.workspaceId, landingPageId: page.id, name: "F", consentText: "ok", fields: [{ key: "email", label: "E-mail", type: "email", required: true }] } });
  return { ...w, page, offer };
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

beforeEach(async () => { await resetDb(); state.role = "owner"; });
afterEach(() => setAIProviderForTests(null));

describe("loadBrief : lecture seule, isolée par espace de travail", () => {
  it("assemble page, offre, audience et mesures réelles ; n'appelle jamais l'IA", async () => {
    const s = await seed();
    await db.analyticsEvent.createMany({ data: [{ workspaceId: s.workspaceId, type: "page_view", landingPageId: s.page.id }, { workspaceId: s.workspaceId, type: "page_view", landingPageId: s.page.id }, { workspaceId: s.workspaceId, type: "cta_click", landingPageId: s.page.id }] });
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    const d = (await loadBrief(s.workspaceId, s.page.id))!;
    await listGeneratedBriefs(s.workspaceId, s.page.id);
    expect(fake.calls).toHaveLength(0);
    expect(await db.aIGeneration.count()).toBe(0);
    const facts = d.brief.facts.map((f) => f.text).join("\n");
    expect(facts).toContain("Rénovation");
    expect(facts).toContain("Propriétaires lyonnais");
    expect(facts).toContain("2 visite(s), 1 clic(s) sur le bouton, 0 lead(s)");
    expect(d.brief.cta.supported).toBe(true);
    expect(d.brief.questions.some((q) => q.text === "Trop cher ?")).toBe(true);
    expect(d.brief.reliability).toBe("partial");
  });

  it("une page d'un autre espace est introuvable, même avec son identifiant exact", async () => {
    const a = await seed("A");
    const b = await seed("B");
    expect(await loadBrief(b.workspaceId, a.page.id)).toBeNull();
    expect(await loadBrief(a.workspaceId, a.page.id)).not.toBeNull();
  });

  it("offre ou campagne d'un autre espace ignorées (pas de fuite entre locataires)", async () => {
    const a = await seed("A");
    const b = await seed("B");
    await db.landingPage.update({ where: { id: a.page.id }, data: { offerId: b.offer.id } });
    const d = (await loadBrief(a.workspaceId, a.page.id))!;
    expect(d.input.offer).toBeNull();
    expect(d.brief.gaps.join(" ")).toMatch(/Aucune offre/);
    expect(JSON.stringify(d.brief)).not.toContain("Propriétaires lyonnais");
  });
});

describe("generateContentBrief : appel explicite, journalisé", () => {
  it("un appel, une ligne AIGeneration (kind content_brief, page liée), schéma validé, prompt sans invention", async () => {
    const s = await seed();
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    const r = await generateContentBrief({ workspaceId: s.workspaceId, userId: s.userId, pageId: s.page.id });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].prompt).toContain("Devis salle de bain Lyon");
    expect(fake.calls[0].prompt).toMatch(/N'invente aucun chiffre/);
    expect(fake.calls[0].system).toMatch(/n'invente aucun chiffre/);
    const log = await db.aIGeneration.findUniqueOrThrow({ where: { id: r.generationId } });
    expect([log.kind, log.status, log.provider]).toEqual(["content_brief", "ok", "fake"]);
    expect((log.input as { landingPageId: string }).landingPageId).toBe(s.page.id);
    expect(r.ai.workingTitle).toBe("Rénover sa salle de bain à Lyon");
  });

  it("signale les chiffres inventés par l'IA (95 % absent des données)", async () => {
    const s = await seed();
    setAIProviderForTests(new Fake([GOOD]));
    const r = await generateContentBrief({ workspaceId: s.workspaceId, userId: s.userId, pageId: s.page.id });
    expect(r.figureWarnings.some((w) => w.includes("95"))).toBe(true);
  });

  it("données insuffisantes (ni titre SEO ni H1) : refus avant tout appel IA, rien de journalisé", async () => {
    const s = await seed();
    await db.landingPage.update({ where: { id: s.page.id }, data: { seoTitle: null, sections: [{ type: "footer", id: "f", text: "", links: [] }] } });
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    await expect(generateContentBrief({ workspaceId: s.workspaceId, userId: s.userId, pageId: s.page.id })).rejects.toThrow(/Données insuffisantes/);
    expect(fake.calls).toHaveLength(0);
    expect(await db.aIGeneration.count()).toBe(0);
  });

  it("page d'un autre espace : refus, aucun appel", async () => {
    const a = await seed("A");
    const b = await seed("B");
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    await expect(generateContentBrief({ workspaceId: b.workspaceId, userId: b.userId, pageId: a.page.id })).rejects.toThrow(/introuvable/);
    expect(fake.calls).toHaveLength(0);
  });

  it("l'historique relit les briefs de la page seulement, sans ceux d'un autre espace ni les sorties invalides", async () => {
    const a = await seed("A");
    const b = await seed("B");
    setAIProviderForTests(new Fake([GOOD]));
    await generateContentBrief({ workspaceId: a.workspaceId, userId: a.userId, pageId: a.page.id });
    await generateContentBrief({ workspaceId: b.workspaceId, userId: b.userId, pageId: b.page.id });
    await db.aIGeneration.create({ data: { workspaceId: a.workspaceId, kind: "content_brief", status: "ok", input: { landingPageId: a.page.id }, output: { nimporte: "quoi" } } });
    await db.aIGeneration.create({ data: { workspaceId: a.workspaceId, kind: "ad_copy", status: "ok", input: { landingPageId: a.page.id }, output: JSON.parse(GOOD) } });
    const list = await listGeneratedBriefs(a.workspaceId, a.page.id);
    expect(list).toHaveLength(1);
    expect(list[0].landingPageId).toBe(a.page.id);
    expect(await listGeneratedBriefs(a.workspaceId, b.page.id)).toHaveLength(0);
    expect((await listGeneratedBriefs(a.workspaceId, null)).length).toBe(1);
  });
});

describe("generateBriefAction : permissions, quota et pannes du service IA", () => {
  it("membre autorisé : succès, message qui rappelle de relire ; avertissement chiffré ajouté", async () => {
    const s = await seed("Acme", { role: "member" });
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    const r = await generateBriefAction({}, fd({ pageId: s.page.id }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/chiffre\(s\)/);
    expect(fake.calls).toHaveLength(1);
  });

  it("lecteur (viewer) : permission refusée, aucun appel IA, rien de journalisé", async () => {
    const s = await seed("Acme", { role: "viewer" });
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    const r = await generateBriefAction({}, fd({ pageId: s.page.id }));
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/permission/);
    expect(fake.calls).toHaveLength(0);
    expect(await db.aIGeneration.count()).toBe(0);
  });

  it("sans fournisseur configuré : message « Configuration requise », pas d'appel, pas de faux brief", async () => {
    const s = await seed();
    const r = await generateBriefAction({}, fd({ pageId: s.page.id }));
    expect(r.error).toMatch(/Configuration requise/);
    expect(await db.aIGeneration.count({ where: { kind: "content_brief" } })).toBe(0);
    expect(await listGeneratedBriefs(s.workspaceId, s.page.id)).toHaveLength(0);
  });

  it("quota quotidien atteint : refus explicite, le fournisseur n'est pas appelé", async () => {
    const s = await seed();
    await db.aIGeneration.createMany({ data: Array.from({ length: 700 }, () => ({ workspaceId: s.workspaceId, kind: "copilot", status: "ok" })) });
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    const r = await generateBriefAction({}, fd({ pageId: s.page.id }));
    expect(r.error).toMatch(/Quota quotidien/);
    expect(fake.calls).toHaveLength(0);
  });

  it("panne du fournisseur : message utilisateur propre, échec journalisé, aucun brief enregistré", async () => {
    const s = await seed();
    setAIProviderForTests(new Fake([new AIError("provider", "HTTP 500")]));
    const r = await generateBriefAction({}, fd({ pageId: s.page.id }));
    expect(r.error).toMatch(/fournisseur d'IA a renvoyé une erreur/);
    expect(await db.aIGeneration.count({ where: { kind: "content_brief", status: "error" } })).toBe(1);
    expect(await listGeneratedBriefs(s.workspaceId, s.page.id)).toHaveLength(0);
  });

  it("délai dépassé et réponse inexploitable : messages distincts", async () => {
    const s = await seed();
    setAIProviderForTests(new Fake([new AIError("timeout", "t")]));
    expect((await generateBriefAction({}, fd({ pageId: s.page.id }))).error).toMatch(/pas répondu à temps/);
    setAIProviderForTests(new Fake(['{"workingTitle":"x"}']));
    expect((await generateBriefAction({}, fd({ pageId: s.page.id }))).error).toMatch(/inexploitable/);
  });

  it("entrée invalide (identifiant vide ou absent) : erreur de validation, aucun appel", async () => {
    await seed();
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    expect((await generateBriefAction({}, fd({ pageId: "   " }))).error).toBeTruthy();
    expect((await generateBriefAction({}, new FormData())).error).toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });

  it("page d'un autre espace via l'action : introuvable, aucun appel", async () => {
    const a = await seed("A");
    await seed("B"); // état courant = espace B
    const fake = new Fake([GOOD]); setAIProviderForTests(fake);
    const r = await generateBriefAction({}, fd({ pageId: a.page.id }));
    expect(r.error).toMatch(/introuvable/);
    expect(fake.calls).toHaveLength(0);
  });
});
