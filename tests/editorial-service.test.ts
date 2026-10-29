// Suivi éditorial persistant : création/validation, transitions, confirmation de publication, file, calendrier, isolation par espace,
// permissions côté serveur, absence de génération IA implicite, non-régression du brief. Base de test dédiée (globalSetup) ; aucun appel externe.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { ValidationError, UserError } from "@/lib/action";
import { setAIProviderForTests, type AIProvider, type AIRequest } from "@/lib/ai/providers";
import { changeContentState, createContentItem, deleteContentItem, loadEditorialBoard, updateContentItem } from "@/lib/editorial-service";
import { listGeneratedBriefs, loadBrief } from "@/lib/content-brief-service";
import { changeContentStateAction, createContentAction, deleteContentAction, updateContentAction } from "../src/app/(app)/editorial/actions";
import { NAV } from "@/components/nav";
import { makeWorkspace, resetDb } from "./helpers";

class Spy implements AIProvider {
  readonly id = "spy"; readonly model = "spy-1"; calls: AIRequest[] = [];
  async complete(req: AIRequest) { this.calls.push(req); return { text: "{}", model: this.model, promptTokens: 1, completionTokens: 1 }; }
}
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let n = 0;
async function seed(role = "owner") {
  const w = await makeWorkspace("Edito", { role });
  state.ws = w.workspaceId; state.role = role;
  return { ...w, scope: { workspaceId: w.workspaceId, actorId: w.userId } };
}
const mkPage = (workspaceId: string, name = "Page") => db.landingPage.create({ data: { workspaceId, name, slug: `p-${Date.now()}-${++n}`, status: "published", seoTitle: name, sections: [] } });
const mkProduct = (workspaceId: string, extra: { deletedAt?: Date } = {}) => db.product.create({ data: { workspaceId, name: "SaaS", slug: `s-${Date.now()}-${++n}`, ...extra } });
const input = (o: Record<string, string> = {}) => ({ title: "Guide SEO", priority: "medium", dueAt: "", landingPageId: "", productId: "", ...o });

beforeEach(async () => { await resetDb(); setAIProviderForTests(null); });

describe("création et validation", () => {
  it("crée un contenu avec les valeurs par défaut du schéma", async () => {
    const { scope, workspaceId } = await seed();
    const c = await createContentItem(scope, { title: "  Guide SEO  " });
    expect(c).toMatchObject({ workspaceId, title: "Guide SEO", state: "idea", priority: "medium", dueAt: null, landingPageId: null, productId: null, publishedConfirmedAt: null, publishedUrl: null });
    expect(await db.auditLog.count({ where: { workspaceId, action: "content.create", entityId: c.id } })).toBe(1);
  });
  it("accepte une échéance AAAA-MM-JJ stockée à minuit UTC", async () => {
    const { scope } = await seed();
    const c = await createContentItem(scope, input({ dueAt: "2026-11-04", priority: "high" }));
    expect(c.dueAt?.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(c.priority).toBe("high");
  });
  it.each([
    ["titre vide", { title: "   " }, "title"],
    ["titre trop long", { title: "x".repeat(201) }, "title"],
    ["priorité inconnue", { priority: "urgent" }, "priority"],
    ["date mal formée", { dueAt: "04/11/2026" }, "dueAt"],
    ["date inexistante", { dueAt: "2026-02-31" }, "dueAt"],
  ])("refuse : %s", async (_l, bad, field) => {
    const { scope, workspaceId } = await seed();
    const e = await createContentItem(scope, input(bad)).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).fieldErrors).toHaveProperty(field);
    expect(await db.contentItem.count({ where: { workspaceId } })).toBe(0);
  });
});

describe("modification", () => {
  it("modifie titre, priorité, échéance et associations, sans toucher l'état", async () => {
    const { scope, workspaceId } = await seed();
    const page = await mkPage(workspaceId); const prod = await mkProduct(workspaceId);
    const c = await createContentItem(scope, input());
    await updateContentItem(scope, c.id, input({ title: "Nouveau", priority: "low", dueAt: "2026-12-01", landingPageId: page.id, productId: prod.id }));
    const r = await db.contentItem.findUniqueOrThrow({ where: { id: c.id } });
    expect(r).toMatchObject({ title: "Nouveau", priority: "low", landingPageId: page.id, productId: prod.id, state: "idea" });
    expect(r.dueAt?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    await updateContentItem(scope, c.id, input({ title: "Nouveau", dueAt: "" }));
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).dueAt).toBeNull();
  });
  it("un contenu inexistant est refusé", async () => {
    const { scope } = await seed();
    await expect(updateContentItem(scope, "nope", input())).rejects.toBeInstanceOf(UserError);
  });
  it("l'état et la confirmation ne peuvent pas être forcés par la modification", async () => {
    const { scope } = await seed();
    const c = await createContentItem(scope, input());
    await updateContentItem(scope, c.id, { ...input(), state: "published", publishedConfirmedAt: new Date().toISOString() });
    const r = await db.contentItem.findUniqueOrThrow({ where: { id: c.id } });
    expect(r.state).toBe("idea"); expect(r.publishedConfirmedAt).toBeNull();
  });
});

describe("transitions et publication", () => {
  async function at(scope: Awaited<ReturnType<typeof seed>>["scope"], to: string[]) {
    const c = await createContentItem(scope, input());
    for (const t of to) await changeContentState(scope, { id: c.id, to: t });
    return c;
  }
  it("avance d'un cran à la fois puis refuse les sauts et les mêmes états", async () => {
    const { scope } = await seed();
    const c = await at(scope, ["brief_todo", "ready"]);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).state).toBe("ready");
    await expect(changeContentState(scope, { id: c.id, to: "published", confirmPublished: "on" })).rejects.toThrow(/impossible/);
    await expect(changeContentState(scope, { id: c.id, to: "idea" })).rejects.toThrow(/impossible/);
    await expect(changeContentState(scope, { id: c.id, to: "ready" })).rejects.toThrow(/impossible/);
    await expect(changeContentState(scope, { id: c.id, to: "bidon" })).rejects.toBeInstanceOf(ValidationError);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).state).toBe("ready");
  });
  it("« Publié » exige la confirmation explicite", async () => {
    const { scope } = await seed();
    const c = await at(scope, ["brief_todo", "ready", "writing"]);
    for (const confirmPublished of [undefined, "", "off", "false"]) {
      await expect(changeContentState(scope, { id: c.id, to: "published", ...(confirmPublished === undefined ? {} : { confirmPublished }) })).rejects.toThrow(/confirmation explicite/);
    }
    const r = await db.contentItem.findUniqueOrThrow({ where: { id: c.id } });
    expect(r.state).toBe("writing"); expect(r.publishedConfirmedAt).toBeNull();
    await changeContentState(scope, { id: c.id, to: "published", confirmPublished: "on", publishedUrl: "https://exemple.fr/guide" });
    const p = await db.contentItem.findUniqueOrThrow({ where: { id: c.id } });
    expect(p.state).toBe("published"); expect(p.publishedConfirmedAt).toBeInstanceOf(Date); expect(p.publishedUrl).toBe("https://exemple.fr/guide");
  });
  it("une URL de publication invalide est refusée", async () => {
    const { scope } = await seed();
    const c = await at(scope, ["brief_todo", "ready", "writing"]);
    for (const publishedUrl of ["javascript:alert(1)", "pas une url", "ftp://x.fr"]) {
      const e = await changeContentState(scope, { id: c.id, to: "published", confirmPublished: "on", publishedUrl }).catch((x) => x);
      expect(e).toBeInstanceOf(ValidationError);
    }
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).state).toBe("writing");
  });
  it("« Publié » est terminal", async () => {
    const { scope } = await seed();
    const c = await at(scope, ["brief_todo", "ready", "writing"]);
    await changeContentState(scope, { id: c.id, to: "published", confirmPublished: "on" });
    await expect(changeContentState(scope, { id: c.id, to: "writing" })).rejects.toThrow(/impossible/);
  });
  it("un retour arrière efface la confirmation de publication déjà enregistrée", async () => {
    const { scope } = await seed();
    const c = await at(scope, ["brief_todo", "ready", "writing"]);
    // Cas de données : un contenu non publié portant une confirmation résiduelle la perd au premier changement d'état.
    await db.contentItem.update({ where: { id: c.id }, data: { publishedConfirmedAt: new Date(), publishedUrl: "https://x.fr" } });
    await changeContentState(scope, { id: c.id, to: "ready" });
    const r = await db.contentItem.findUniqueOrThrow({ where: { id: c.id } });
    expect(r.state).toBe("ready"); expect(r.publishedConfirmedAt).toBeNull(); expect(r.publishedUrl).toBeNull();
  });
  it("deux changements simultanés ne sautent pas d'étape", async () => {
    const { scope } = await seed();
    const c = await createContentItem(scope, input());
    const r = await Promise.allSettled([changeContentState(scope, { id: c.id, to: "brief_todo" }), changeContentState(scope, { id: c.id, to: "brief_todo" })]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).state).toBe("brief_todo");
  });
});

describe("file de travail, calendrier et résultats", () => {
  it("ordonne : retard, puis priorité, puis échéance (sans échéance en dernier) ; exclut les publiés", async () => {
    const { scope } = await seed();
    const now = new Date("2026-11-04T10:00:00Z");
    const mk = async (title: string, priority: string, dueAt: string) => (await createContentItem(scope, input({ title, priority, dueAt }))).id;
    await mk("sans date haute", "high", "");
    await mk("futur basse", "low", "2026-11-20");
    await mk("retard basse", "low", "2026-11-01");
    await mk("futur haute tard", "high", "2026-11-25");
    await mk("futur haute tôt", "high", "2026-11-10");
    const pub = await createContentItem(scope, input({ title: "publié" }));
    for (const t of ["brief_todo", "ready", "writing"]) await changeContentState(scope, { id: pub.id, to: t });
    await changeContentState(scope, { id: pub.id, to: "published", confirmPublished: "on" });
    const b = await loadEditorialBoard(scope.workspaceId, now);
    expect(b.queue.map((i) => i.title)).toEqual(["retard basse", "futur haute tôt", "futur haute tard", "sans date haute", "futur basse"]);
    expect(b.published.map((i) => i.title)).toEqual(["publié"]);
  });
  it("calendrier par semaine commençant le lundi ; sans échéance à part ; publiés exclus", async () => {
    const { scope } = await seed();
    await createContentItem(scope, input({ title: "dimanche", dueAt: "2026-11-01" })); // dimanche → semaine du lundi 26 oct.
    await createContentItem(scope, input({ title: "lundi", dueAt: "2026-11-02" }));
    await createContentItem(scope, input({ title: "vendredi", dueAt: "2026-11-06" }));
    await createContentItem(scope, input({ title: "sans date" }));
    const b = await loadEditorialBoard(scope.workspaceId, new Date("2026-11-04T00:00:00Z"));
    expect(b.calendar.weeks.map((w) => [w.monday, w.items.map((i) => i.title)])).toEqual([["2026-10-26", ["dimanche"]], ["2026-11-02", ["lundi", "vendredi"]]]);
    expect(b.calendar.undated.map((i) => i.title)).toEqual(["sans date"]);
  });
  it("résultats observés : uniquement les mesures réelles de la page, jamais inventées", async () => {
    const { scope, workspaceId } = await seed();
    const page = await mkPage(workspaceId, "Ma page");
    const pub = async (title: string, landingPageId: string) => {
      const c = await createContentItem(scope, input({ title, landingPageId }));
      for (const t of ["brief_todo", "ready", "writing"]) await changeContentState(scope, { id: c.id, to: t });
      await changeContentState(scope, { id: c.id, to: "published", confirmPublished: "on" });
      return c.id;
    };
    const idNoViews = await pub("sans visite", page.id);
    let b = await loadEditorialBoard(workspaceId);
    expect(b.items.find((i) => i.id === idNoViews)!.results).toMatchObject({ available: false, text: expect.stringContaining("Aucune visite mesurée") });
    await db.analyticsEvent.createMany({ data: [1, 2, 3].map(() => ({ workspaceId, type: "page_view", landingPageId: page.id })) });
    await db.lead.create({ data: { workspaceId, name: "L", email: "l@x.fr", landingPageId: page.id } });
    b = await loadEditorialBoard(workspaceId);
    expect(b.items.find((i) => i.id === idNoViews)!.results).toMatchObject({ available: true, text: expect.stringMatching(/3 visite.*1 lead.*non attribuées à ce contenu/) });
    const idNoPage = (await createContentItem(scope, input({ title: "sans page" }))).id;
    b = await loadEditorialBoard(workspaceId);
    expect(b.items.find((i) => i.id === idNoPage)!.results.available).toBe(false);
  });
});

describe("isolation multi-tenant et associations", () => {
  it("un espace ne voit, ne modifie, ne change et ne supprime pas le contenu d'un autre", async () => {
    const a = await seed(); const ca = await createContentItem(a.scope, input({ title: "Secret A" }));
    const b = await seed();
    expect((await loadEditorialBoard(b.workspaceId)).items).toHaveLength(0);
    await expect(updateContentItem(b.scope, ca.id, input({ title: "Piraté" }))).rejects.toBeInstanceOf(UserError);
    await expect(changeContentState(b.scope, { id: ca.id, to: "brief_todo" })).rejects.toBeInstanceOf(UserError);
    await expect(deleteContentItem(b.scope, ca.id)).rejects.toBeInstanceOf(UserError);
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: ca.id } })).toMatchObject({ title: "Secret A", state: "idea", workspaceId: a.workspaceId });
    expect((await loadEditorialBoard(a.workspaceId)).items).toHaveLength(1);
  });
  it("refuse une landing page ou un produit d'un autre espace (création et modification)", async () => {
    const a = await seed(); const pageA = await mkPage(a.workspaceId); const prodA = await mkProduct(a.workspaceId);
    const b = await seed();
    await expect(createContentItem(b.scope, input({ landingPageId: pageA.id }))).rejects.toThrow(/Landing page introuvable/);
    await expect(createContentItem(b.scope, input({ productId: prodA.id }))).rejects.toThrow(/Produit introuvable/);
    const cb = await createContentItem(b.scope, input());
    await expect(updateContentItem(b.scope, cb.id, input({ landingPageId: pageA.id }))).rejects.toThrow(/Landing page introuvable/);
    await expect(updateContentItem(b.scope, cb.id, input({ productId: prodA.id }))).rejects.toThrow(/Produit introuvable/);
    await expect(createContentItem(b.scope, input({ landingPageId: "inexistante" }))).rejects.toBeInstanceOf(UserError);
    expect(await db.contentItem.count({ where: { workspaceId: b.workspaceId } })).toBe(1);
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: cb.id } })).landingPageId).toBeNull();
  });
  it("refuse un produit supprimé", async () => {
    const a = await seed(); const dead = await mkProduct(a.workspaceId, { deletedAt: new Date() });
    await expect(createContentItem(a.scope, input({ productId: dead.id }))).rejects.toThrow(/Produit introuvable/);
  });
  it("une page supprimée détache le contenu (SET NULL) et supprimer l'espace le supprime (CASCADE)", async () => {
    const a = await seed(); const page = await mkPage(a.workspaceId);
    const c = await createContentItem(a.scope, input({ landingPageId: page.id }));
    await db.landingPage.delete({ where: { id: page.id } });
    expect((await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).landingPageId).toBeNull();
    await db.workspace.delete({ where: { id: a.workspaceId } });
    expect(await db.contentItem.count({ where: { id: c.id } })).toBe(0);
  });
  it("les données d'un autre espace n'apparaissent pas dans le nom de page / produit affichés", async () => {
    const a = await seed(); const pageA = await mkPage(a.workspaceId, "Page privée A");
    const b = await seed();
    // Donnée incohérente forcée en base : le contenu de B pointe vers une page de A.
    await db.contentItem.create({ data: { workspaceId: b.workspaceId, title: "x", landingPageId: pageA.id } });
    const board = await loadEditorialBoard(b.workspaceId);
    expect(board.items[0].landingPageName).toBeNull();
    expect(JSON.stringify(board)).not.toContain("Page privée A");
  });
});

describe("actions serveur : permissions, erreurs, et absence de génération IA implicite", () => {
  it("un lecteur ne peut ni créer, ni modifier, ni changer l'état, ni supprimer", async () => {
    const o = await seed(); const c = await createContentItem(o.scope, input());
    state.role = "viewer";
    for (const r of [await createContentAction({}, fd(input())), await updateContentAction({}, fd({ ...input({ title: "Hack" }), id: c.id })), await changeContentStateAction({}, fd({ id: c.id, to: "brief_todo" })), await deleteContentAction({}, fd({ id: c.id }))]) {
      expect(r.ok).toBeFalsy(); expect(r.error).toMatch(/permission/i);
    }
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ title: "Guide SEO", state: "idea" });
    expect(await db.contentItem.count()).toBe(1);
  });
  it("un membre écrit mais ne supprime pas ; un admin supprime", async () => {
    const o = await seed("member");
    const created = await createContentAction({}, fd(input({ title: "Par membre" })));
    expect(created.ok).toBe(true);
    const c = await db.contentItem.findFirstOrThrow({ where: { workspaceId: o.workspaceId } });
    const up = await updateContentAction({}, fd({ ...input({ title: "Renommé" }), id: c.id }));
    expect(up.ok).toBe(true);
    expect((await changeContentStateAction({}, fd({ id: c.id, to: "brief_todo" }))).ok).toBe(true);
    expect((await deleteContentAction({}, fd({ id: c.id }))).error).toMatch(/permission/i);
    state.role = "admin";
    expect((await deleteContentAction({}, fd({ id: c.id }))).ok).toBe(true);
    expect(await db.contentItem.count()).toBe(0);
  });
  it("renvoie des erreurs de champ, de transition et d'espace sans détail technique", async () => {
    const a = await seed(); const ca = await createContentItem(a.scope, input());
    const bad = await createContentAction({}, fd(input({ title: "" })));
    expect(bad.error).toBeTruthy(); expect(bad.fieldErrors).toHaveProperty("title");
    const skip = await changeContentStateAction({}, fd({ id: ca.id, to: "writing" }));
    expect(skip.error).toMatch(/impossible/);
    const noConfirm = await (async () => { for (const t of ["brief_todo", "ready", "writing"]) await changeContentState(a.scope, { id: ca.id, to: t }); return changeContentStateAction({}, fd({ id: ca.id, to: "published" })); })();
    expect(noConfirm.error).toMatch(/confirmation explicite/);
    const b = await seed();
    const other = await updateContentAction({}, fd({ ...input({ title: "Piraté" }), id: ca.id }));
    expect(other).toEqual({ error: "Contenu introuvable." });
    expect(b.workspaceId).not.toBe(a.workspaceId);
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: ca.id } })).toMatchObject({ title: "Guide SEO" });
    const noId = await deleteContentAction({}, fd({}));
    expect(noId.error).toBeTruthy();
  });
  it("données de formulaire hostiles : état, confirmation, espace et identifiant imposés par le client sont ignorés", async () => {
    const a = await seed(); const b = await seed();
    const evil = { ...input({ title: "Hostile" }), state: "published", publishedConfirmedAt: "2020-01-01T00:00:00Z", publishedUrl: "https://x.fr", workspaceId: a.workspaceId, id: "forcé", createdAt: "2000-01-01T00:00:00Z" };
    expect((await createContentAction({}, fd(evil))).ok).toBe(true);
    const row = await db.contentItem.findFirstOrThrow({ where: { title: "Hostile" } });
    expect(row.workspaceId).toBe(b.workspaceId); // l'espace vient de la session, jamais du formulaire
    expect(row).toMatchObject({ state: "idea", publishedConfirmedAt: null, publishedUrl: null });
    expect(row.id).not.toBe("forcé"); expect(row.createdAt.getFullYear()).toBeGreaterThan(2020);
    const up = await updateContentAction({}, fd({ ...evil, id: row.id, title: "Hostile 2" }));
    expect(up.ok).toBe(true);
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ title: "Hostile 2", workspaceId: b.workspaceId, state: "idea", publishedConfirmedAt: null, publishedUrl: null });
    // « to=published » sans case cochée, même avec une URL : refusé.
    for (const t of ["brief_todo", "ready", "writing"]) await changeContentState(b.scope, { id: row.id, to: t });
    const r = await changeContentStateAction({}, fd({ id: row.id, to: "published", publishedUrl: "https://x.fr", publishedConfirmedAt: "2020-01-01T00:00:00Z" }));
    expect(r.error).toMatch(/confirmation explicite/);
    expect(await db.contentItem.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ state: "writing", publishedConfirmedAt: null });
  });
  it("les actions refusent une page ou un produit d'un autre espace sans révéler son existence", async () => {
    const a = await seed(); const pageA = await mkPage(a.workspaceId, "Secrète"); const prodA = await mkProduct(a.workspaceId);
    await seed();
    const r1 = await createContentAction({}, fd(input({ landingPageId: pageA.id })));
    const r2 = await createContentAction({}, fd(input({ productId: prodA.id })));
    const r3 = await createContentAction({}, fd(input({ landingPageId: "n'existe-pas" })));
    expect(r1.error).toBe("Landing page introuvable dans cet espace de travail.");
    expect(r1.error).toBe(r3.error); // même message : l'existence d'une page d'un autre espace n'est pas révélée
    expect(r2.error).toBe("Produit introuvable dans cet espace de travail.");
    expect(JSON.stringify([r1, r2, r3])).not.toMatch(/Secrète|SaaS/);
    expect(await db.contentItem.count()).toBe(0);
  });
  it("aucune génération IA ni ligne AIGeneration n'est produite par le suivi éditorial", async () => {
    const spy = new Spy(); setAIProviderForTests(spy);
    const o = await seed(); const page = await mkPage(o.workspaceId);
    const c = await createContentItem(o.scope, input({ landingPageId: page.id }));
    await updateContentItem(o.scope, c.id, input({ landingPageId: page.id, title: "B" }));
    for (const t of ["brief_todo", "ready", "writing"]) await changeContentState(o.scope, { id: c.id, to: t });
    await changeContentState(o.scope, { id: c.id, to: "published", confirmPublished: "on" });
    await loadEditorialBoard(o.workspaceId);
    await createContentAction({}, fd(input())); await deleteContentItem(o.scope, c.id);
    expect(spy.calls).toHaveLength(0);
    expect(await db.aIGeneration.count({ where: { workspaceId: o.workspaceId } })).toBe(0);
  });
});

describe("non-régression du brief et de la navigation", () => {
  it("le brief d'une page reste lisible et isolé, avec ou sans contenu éditorial associé", async () => {
    const a = await seed(); const page = await mkPage(a.workspaceId, "Page brief");
    await createContentItem(a.scope, input({ landingPageId: page.id }));
    const d = await loadBrief(a.workspaceId, page.id);
    expect(d?.input.page.id).toBe(page.id);
    expect(await listGeneratedBriefs(a.workspaceId, page.id)).toEqual([]);
    const b = await seed();
    expect(await loadBrief(b.workspaceId, page.id)).toBeNull();
  });
  it("la navigation expose /editorial une seule fois", () => {
    expect(NAV.filter((x) => x.href === "/editorial")).toEqual([{ href: "/editorial", label: "Éditorial", icon: "editorial" }]);
  });
});
