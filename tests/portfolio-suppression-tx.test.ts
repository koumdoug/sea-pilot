import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { addProspect, ensureDefaultProducts, eraseProspect, logContact, logReply, optOutProspect, PortfolioError, reassignProspect } from "@/lib/portfolio/service";
import { TX_MAX_RETRIES, setRetryTimingForTests } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

// D1 — désinscription, effacement et réattribution des prospects : une seule transaction (tout ou rien), reprise COMPLÈTE sur P2002, rejeu sans effet (ou réparateur).
// Les échecs sont injectés DANS la transaction réelle (le reste s'exécute vraiment, Prisma annule en cas d'erreur) : fonctionne sous SQLite et PostgreSQL.
// La collision réelle entre connexions est exercée sur PostgreSQL dans tests/pg-portfolio-suppression-race.test.ts.

const EMAIL = "marie@roy.ca";
const collected = new Date("2026-10-01T00:00:00Z");
const person = (over: Record<string, unknown> = {}) => ({ name: "Marie Roy", company: "Plomberie Roy", email: EMAIL, source: "Site public de l'entreprise", collectedAt: collected, legalBasis: "implied_published", ...over });
const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError(`Erreur simulée ${code}`, { code, clientVersion: Prisma.prismaVersion.client });

/** `tx.<model>.<method>` lève `errorFor(tentative)` (ou s'exécute si `null`) ; compte les transactions ouvertes (une par tentative de `runTx`). */
function inject(model: string, method: string, errorFor: (attempt: number) => unknown | null) {
  const real = db.$transaction.bind(db) as unknown as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
  const state = { attempts: 0 };
  vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
    const attempt = ++state.attempts;
    return real((tx) => fn(new Proxy(tx as object, {
      get: (t, k, r) => (k === model
        ? new Proxy(Reflect.get(t, k, r) as object, { get: (o, m, rr) => (m === method ? (...a: unknown[]) => { const e = errorFor(attempt); if (e) throw e; return (o as Record<string, (...x: unknown[]) => unknown>)[method](...a); } : Reflect.get(o, m, rr)) })
        : Reflect.get(t, k, r)),
    })), opts);
  }) as never);
  return state;
}
const sleeps: number[] = [];

async function setup() {
  const a = await makeWorkspace("Portfolio");
  await ensureDefaultProducts(a.workspaceId, a.userId);
  const products = await db.product.findMany({ where: { workspaceId: a.workspaceId } });
  const by = (slug: string) => products.find((x) => x.slug === slug)!;
  const driver = by("driverpilot"), nexa = by("freelancenexa");
  const { prospect } = await addProspect(a.workspaceId, person({ productId: driver.id }));
  return { ...a, driver, nexa, prospect };
}
const row = (id: string) => db.prospect.findUniqueOrThrow({ where: { id } });
const suppressions = (workspaceId: string) => db.emailSuppression.findMany({ where: { workspaceId } });
const audits = (workspaceId: string, action: string) => db.auditLog.count({ where: { workspaceId, action } });

beforeEach(async () => { await resetDb(); sleeps.length = 0; setRetryTimingForTests({ sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 0 }); });
afterEach(() => { vi.restoreAllMocks(); setRetryTimingForTests(null); });

describe("optOutProspect — une transaction : statut du prospect ET entrée de suppression", () => {
  it("désinscription normale : prospect bloqué, entrée de suppression unique, audit unique, état cohérent", async () => {
    const { workspaceId, prospect } = await setup();
    const u = await optOutProspect({ workspaceId, prospectId: prospect.id, reason: "test" });
    expect(u).toMatchObject({ status: "do_not_contact", campaignId: null, nextFollowUpAt: null });
    expect(u.optedOutAt).not.toBeNull();
    expect(await row(prospect.id)).toMatchObject({ status: "do_not_contact" });
    const s = await suppressions(workspaceId);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ email: EMAIL, reason: "prospect_opt_out" });
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
  });

  it("échec de l'écriture de la suppression : TOUT est annulé (prospect non désinscrit), erreur relancée, aucun audit", async () => {
    const { workspaceId, prospect } = await setup();
    const st = inject("emailSuppression", "create", () => new Error("écriture de la suppression impossible"));
    await expect(optOutProspect({ workspaceId, prospectId: prospect.id })).rejects.toThrow(/suppression impossible/);
    expect(st.attempts).toBe(1);
    expect(await row(prospect.id)).toMatchObject({ status: "identified", optedOutAt: null }); // pas « désinscrit sans suppression »
    expect(await suppressions(workspaceId)).toHaveLength(0);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(0);
  });

  it("échec de la mise à jour du prospect : aucune entrée de suppression orpheline, erreur relancée", async () => {
    const { workspaceId, prospect } = await setup();
    inject("prospect", "update", () => new Error("mise à jour impossible"));
    await expect(optOutProspect({ workspaceId, prospectId: prospect.id })).rejects.toThrow(/mise à jour impossible/);
    expect(await row(prospect.id)).toMatchObject({ status: "identified", optedOutAt: null });
    expect(await suppressions(workspaceId)).toHaveLength(0);
  });

  it("P2002 à la 1re tentative (création concurrente de l'entrée) : 2 transactions, reprise COMPLÈTE, état final cohérent, audit unique", async () => {
    const { workspaceId, prospect } = await setup();
    const st = inject("emailSuppression", "create", (n) => (n === 1 ? prismaError("P2002") : null));
    const u = await optOutProspect({ workspaceId, prospectId: prospect.id });
    expect(st.attempts).toBe(2);
    expect(sleeps).toEqual([0]);
    expect(u.status).toBe("do_not_contact");
    // Preuve de l'annulation de la 1re tentative : elle avait déjà mis le prospect à jour AVANT l'erreur. Si cette écriture avait survécu, la 2e verrait « déjà désinscrit » (aucun changement) et
    // n'écrirait AUCUN audit (l'audit n'est émis que par la transaction qui a réellement changé le statut). L'audit unique prouve donc l'annulation puis la reprise complète.
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
  });

  it("P2002 persistante : arrêtée au nombre maximal de tentatives, erreur relancée, prospect NON désinscrit, aucune suppression", async () => {
    const { workspaceId, prospect } = await setup();
    const st = inject("emailSuppression", "create", () => prismaError("P2002"));
    await expect(optOutProspect({ workspaceId, prospectId: prospect.id })).rejects.toMatchObject({ code: "P2002" });
    expect(st.attempts).toBe(1 + TX_MAX_RETRIES);
    expect(sleeps).toHaveLength(TX_MAX_RETRIES);
    expect(await row(prospect.id)).toMatchObject({ status: "identified", optedOutAt: null });
    expect(await suppressions(workspaceId)).toHaveLength(0);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(0);
  });

  it("code de reprise historique conservé (P2034) ; autre code Prisma : jamais repris", async () => {
    const { workspaceId, prospect } = await setup();
    const a = inject("emailSuppression", "create", (n) => (n === 1 ? prismaError("P2034") : null));
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    expect(a.attempts).toBe(2);
    vi.restoreAllMocks(); setRetryTimingForTests({ sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 0 });
    const other = await setup();
    const err = prismaError("P2003");
    const b = inject("emailSuppression", "create", () => err);
    await expect(optOutProspect({ workspaceId: other.workspaceId, prospectId: other.prospect.id })).rejects.toBe(err);
    expect(b.attempts).toBe(1);
    expect(await row(other.prospect.id)).toMatchObject({ status: "identified" });
  });

  it("idempotence : un second appel ne change rien (même date d'opposition, une entrée, un audit)", async () => {
    const { workspaceId, prospect } = await setup();
    const first = await optOutProspect({ workspaceId, prospectId: prospect.id });
    const second = await optOutProspect({ workspaceId, prospectId: prospect.id });
    expect(second.optedOutAt!.getTime()).toBe(first.optedOutAt!.getTime());
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
  });

  it("rejeu RÉPARATEUR : prospect déjà désinscrit mais entrée de suppression absente (ancienne version ou échec passé) → l'entrée est écrite, sans nouvel audit ni nouvelle date", async () => {
    const { workspaceId, prospect } = await setup();
    const when = new Date("2026-11-01T00:00:00Z");
    await db.prospect.update({ where: { id: prospect.id }, data: { status: "do_not_contact", optedOutAt: when } }); // état incohérent hérité
    expect(await suppressions(workspaceId)).toHaveLength(0);
    const u = await optOutProspect({ workspaceId, prospectId: prospect.id });
    expect(u.optedOutAt!.getTime()).toBe(when.getTime());
    const s = await suppressions(workspaceId);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ email: EMAIL, reason: "prospect_opt_out" });
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(0);
  });

  it("prospect sans adresse e-mail : désinscrit sans entrée de suppression ; prospect d'un autre espace : introuvable, rien d'écrit", async () => {
    const { workspaceId } = await setup();
    const { prospect: noMail } = await addProspect(workspaceId, person({ email: undefined, phone: "514-555-0100", name: "Sans Courriel" }));
    const u = await optOutProspect({ workspaceId, prospectId: noMail.id });
    expect(u.status).toBe("do_not_contact");
    expect(await suppressions(workspaceId)).toHaveLength(0);
    const foreign = await setup();
    await expect(optOutProspect({ workspaceId, prospectId: foreign.prospect.id })).rejects.toBeInstanceOf(PortfolioError);
    expect(await row(foreign.prospect.id)).toMatchObject({ status: "identified" });
  });

  it("cohérence : un prospect désinscrit est inéligible ET son adresse figure dans la liste", async () => {
    const { workspaceId, prospect, driver } = await setup();
    await db.product.update({ where: { id: driver.id }, data: { status: "commercialisation" } });
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    const t = await db.messageTemplate.create({ data: { workspaceId, productId: driver.id, channel: "email", name: "t", subject: "s", body: "b", status: "approved" } as never });
    const r = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: t.id });
    expect(r.eligibility.ok).toBe(false);
    expect((await suppressions(workspaceId)).map((x) => x.email)).toEqual([EMAIL]);
  });
});

describe("eraseProspect — une transaction : suppression ET anonymisation", () => {
  async function richProspect() {
    const s = await setup();
    await db.prospectContact.create({ data: { workspaceId: s.workspaceId, prospectId: s.prospect.id, productId: s.driver.id, channel: "email", direction: "outbound", summary: "Contenu personnel", outcome: "sent" } as never });
    await db.prospectProduct.create({ data: { workspaceId: s.workspaceId, prospectId: s.prospect.id, productId: s.nexa.id, note: "intérêt" } });
    return s;
  }

  it("effacement normal : fiche anonymisée, contacts et intérêts supprimés, adresse en suppression (raison « prospect_erased »), audit unique", async () => {
    const { workspaceId, prospect } = await richProspect();
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id })).toBe(true);
    const p = await row(prospect.id);
    expect(p).toMatchObject({ name: "Prospect effacé", email: null, company: null, phone: null, status: "do_not_contact" });
    expect(p.deletedAt).not.toBeNull();
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(0);
    expect(await db.prospectProduct.count({ where: { workspaceId, prospectId: prospect.id } })).toBe(0);
    const s = await suppressions(workspaceId);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ email: EMAIL, reason: "prospect_erased" });
    expect(await audits(workspaceId, "prospect.erased")).toBe(1);
  });

  it("échec de l'écriture de la suppression : rien n'est effacé (fiche, contacts, intérêts intacts), aucune entrée, aucun audit", async () => {
    const { workspaceId, prospect } = await richProspect();
    const st = inject("emailSuppression", "create", () => new Error("écriture de la suppression impossible"));
    await expect(eraseProspect({ workspaceId, prospectId: prospect.id })).rejects.toThrow(/suppression impossible/);
    expect(st.attempts).toBe(1);
    expect(await row(prospect.id)).toMatchObject({ name: "Marie Roy", email: EMAIL, deletedAt: null });
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(1);
    expect(await db.prospectProduct.count({ where: { workspaceId, prospectId: prospect.id } })).toBe(1);
    expect(await suppressions(workspaceId)).toHaveLength(0);
    expect(await audits(workspaceId, "prospect.erased")).toBe(0);
  });

  it("échec de la mise à jour de la fiche (après la suppression et les effacements DANS la transaction) : tout est annulé, y compris l'entrée de suppression", async () => {
    const { workspaceId, prospect } = await richProspect();
    inject("prospect", "update", () => new Error("mise à jour impossible"));
    await expect(eraseProspect({ workspaceId, prospectId: prospect.id })).rejects.toThrow(/mise à jour impossible/);
    expect(await row(prospect.id)).toMatchObject({ name: "Marie Roy", email: EMAIL, deletedAt: null });
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(1);
    expect(await suppressions(workspaceId)).toHaveLength(0); // pas d'entrée orpheline : la fiche est intacte
  });

  it("P2002 à la 1re tentative : 2 transactions, effacement complet, entrée unique, audit unique", async () => {
    const { workspaceId, prospect } = await richProspect();
    const st = inject("emailSuppression", "create", (n) => (n === 1 ? prismaError("P2002") : null));
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id })).toBe(true);
    expect(st.attempts).toBe(2);
    expect((await row(prospect.id)).name).toBe("Prospect effacé");
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.erased")).toBe(1);
  });

  it("P2002 persistante : arrêtée au maximum, erreur relancée, fiche NON effacée, aucune suppression", async () => {
    const { workspaceId, prospect } = await richProspect();
    const st = inject("emailSuppression", "create", () => prismaError("P2002"));
    await expect(eraseProspect({ workspaceId, prospectId: prospect.id })).rejects.toMatchObject({ code: "P2002" });
    expect(st.attempts).toBe(1 + TX_MAX_RETRIES);
    expect(await row(prospect.id)).toMatchObject({ email: EMAIL, deletedAt: null });
    expect(await suppressions(workspaceId)).toHaveLength(0);
  });

  it("idempotence : rejeu sans nouvel audit ni nouvelle entrée ; prospect d'un autre espace : false, intact", async () => {
    const { workspaceId, prospect } = await richProspect();
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id })).toBe(true);
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id })).toBe(true);
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.erased")).toBe(1);
    const other = await setup();
    expect(await eraseProspect({ workspaceId, prospectId: other.prospect.id })).toBe(false);
    expect((await row(other.prospect.id)).name).toBe("Marie Roy");
  });

  it("entrée déjà présente (désinscription antérieure) : conservée telle quelle, jamais dupliquée ; effacement complet", async () => {
    const { workspaceId, prospect } = await richProspect();
    await db.emailSuppression.create({ data: { workspaceId, email: EMAIL, reason: "unsubscribe" } });
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id })).toBe(true);
    const s = await suppressions(workspaceId);
    expect(s).toHaveLength(1);
    expect(s[0].reason).toBe("unsubscribe");
    expect((await row(prospect.id)).email).toBeNull();
  });
});

describe("reassignProspect — une transaction : intérêt conservé ET prospect déplacé", () => {
  it("réattribution normale : ancien produit conservé comme intérêt, nouveau retiré des intérêts, prospect déplacé", async () => {
    const { workspaceId, prospect, driver, nexa } = await setup();
    await db.prospectProduct.create({ data: { workspaceId, prospectId: prospect.id, productId: nexa.id, note: "intérêt" } });
    const u = await reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "Travailleur autonome" });
    expect(u).toMatchObject({ productId: nexa.id, campaignId: null });
    const interests = await db.prospectProduct.findMany({ where: { prospectId: prospect.id } });
    expect(interests.map((i) => i.productId)).toEqual([driver.id]);
    expect(await audits(workspaceId, "prospect.reassigned")).toBe(1);
  });

  it("échec du déplacement : aucun intérêt créé (tout ou rien), prospect inchangé", async () => {
    const { workspaceId, prospect, driver, nexa } = await setup();
    inject("prospect", "update", () => new Error("déplacement impossible"));
    await expect(reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "Travailleur autonome" })).rejects.toThrow(/déplacement impossible/);
    expect((await row(prospect.id)).productId).toBe(driver.id);
    expect(await db.prospectProduct.count({ where: { prospectId: prospect.id } })).toBe(0);
  });

  it("P2002 à la 1re tentative sur l'intérêt : reprise complète, un seul intérêt, prospect déplacé ; même produit : rejeu sans effet", async () => {
    const { workspaceId, prospect, driver, nexa } = await setup();
    const st = inject("prospectProduct", "create", (n) => (n === 1 ? prismaError("P2002") : null));
    const u = await reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "Travailleur autonome" });
    expect(st.attempts).toBe(2);
    expect(u.productId).toBe(nexa.id);
    expect((await db.prospectProduct.findMany({ where: { prospectId: prospect.id } })).map((i) => i.productId)).toEqual([driver.id]);
    vi.restoreAllMocks();
    const again = await reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "Travailleur autonome" });
    expect(again.productId).toBe(nexa.id);
    expect(await db.prospectProduct.count({ where: { prospectId: prospect.id } })).toBe(1);
    expect(await audits(workspaceId, "prospect.reassigned")).toBe(1);
  });
});

describe("logReply — une transaction : ligne de contact ET effet (statut ou opposition)", () => {
  const contacts = (workspaceId: string, prospectId: string) => db.prospectContact.findMany({ where: { workspaceId, prospectId, direction: "inbound" } });

  it("réponse simple : contact enregistré (« replied »), prospect « a répondu », aucun audit d'opposition", async () => {
    const { workspaceId, prospect } = await setup();
    const u = await logReply({ workspaceId, prospectId: prospect.id, channel: "email", summary: "Intéressé" });
    expect(u.status).toBe("replied");
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(1);
    expect((await contacts(workspaceId, prospect.id))[0].outcome).toBe("replied");
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(0);
  });

  it("réponse avec opposition : contact « opted_out », prospect désinscrit, entrée de suppression unique, audit unique avec le motif de la réponse", async () => {
    const { workspaceId, prospect } = await setup();
    const u = await logReply({ workspaceId, prospectId: prospect.id, channel: "email", optOut: true });
    expect(u.status).toBe("do_not_contact");
    const c = await contacts(workspaceId, prospect.id);
    expect(c).toHaveLength(1);
    expect(c[0].outcome).toBe("opted_out");
    expect((await suppressions(workspaceId)).map((s) => [s.email, s.reason])).toEqual([[EMAIL, "prospect_opt_out"]]);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
    const a = await db.auditLog.findFirstOrThrow({ where: { workspaceId, action: "prospect.opted_out" } });
    expect(JSON.stringify(a.meta)).toContain("opposition dans la réponse");
  });

  it("opposition : échec de l'écriture de la suppression → AUCUNE ligne de contact conservée, prospect inchangé, aucun audit, erreur relancée", async () => {
    const { workspaceId, prospect } = await setup();
    const st = inject("emailSuppression", "create", () => new Error("écriture de la suppression impossible"));
    await expect(logReply({ workspaceId, prospectId: prospect.id, channel: "email", optOut: true })).rejects.toThrow(/suppression impossible/);
    expect(st.attempts).toBe(1);
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(0); // avant le correctif : la réponse « opposition » restait consignée sans désinscription
    expect(await row(prospect.id)).toMatchObject({ status: "identified", optedOutAt: null });
    expect(await suppressions(workspaceId)).toHaveLength(0);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(0);
  });

  it("opposition : échec de la mise à jour du prospect → aucune ligne de contact, aucune entrée de suppression", async () => {
    const { workspaceId, prospect } = await setup();
    inject("prospect", "update", () => new Error("mise à jour impossible"));
    await expect(logReply({ workspaceId, prospectId: prospect.id, channel: "email", optOut: true })).rejects.toThrow(/mise à jour impossible/);
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(0);
    expect(await suppressions(workspaceId)).toHaveLength(0);
    expect(await row(prospect.id)).toMatchObject({ status: "identified" });
  });

  it("réponse simple : échec de la mise à jour du statut → aucune ligne de contact conservée", async () => {
    const { workspaceId, prospect } = await setup();
    inject("prospect", "update", () => new Error("mise à jour impossible"));
    await expect(logReply({ workspaceId, prospectId: prospect.id, channel: "email" })).rejects.toThrow(/mise à jour impossible/);
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(0);
    expect(await row(prospect.id)).toMatchObject({ status: "identified" });
  });

  it("P2002 à la 1re tentative (entrée de suppression créée en même temps) : 2 transactions, reprise COMPLÈTE, UNE seule ligne de contact, audit unique", async () => {
    const { workspaceId, prospect } = await setup();
    const st = inject("emailSuppression", "create", (n) => (n === 1 ? prismaError("P2002") : null));
    const u = await logReply({ workspaceId, prospectId: prospect.id, channel: "email", optOut: true });
    expect(st.attempts).toBe(2);
    expect(u.status).toBe("do_not_contact");
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(1); // la ligne de la 1re tentative a été annulée, pas dupliquée
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
  });

  it("P2002 persistante : arrêtée au maximum, erreur relancée, AUCUNE ligne de contact, prospect non désinscrit", async () => {
    const { workspaceId, prospect } = await setup();
    const st = inject("emailSuppression", "create", () => prismaError("P2002"));
    await expect(logReply({ workspaceId, prospectId: prospect.id, channel: "email", optOut: true })).rejects.toMatchObject({ code: "P2002" });
    expect(st.attempts).toBe(1 + TX_MAX_RETRIES);
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(0);
    expect(await row(prospect.id)).toMatchObject({ status: "identified", optedOutAt: null });
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(0);
  });

  it("opposition sur un prospect déjà désinscrit : contact consigné, aucune nouvelle entrée ni nouvel audit ; statut « demo/trial/customer » conservé pour une réponse simple", async () => {
    const { workspaceId, prospect } = await setup();
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    await logReply({ workspaceId, prospectId: prospect.id, channel: "email", optOut: true });
    expect(await contacts(workspaceId, prospect.id)).toHaveLength(1);
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
    const other = await setup();
    await db.prospect.update({ where: { id: other.prospect.id }, data: { status: "trial" } });
    expect((await logReply({ workspaceId: other.workspaceId, prospectId: other.prospect.id, channel: "email" })).status).toBe("trial");
  });

  it("prospect introuvable, effacé ou d'un autre espace : erreur, aucune ligne de contact", async () => {
    const { workspaceId } = await setup();
    const foreign = await setup();
    await expect(logReply({ workspaceId, prospectId: foreign.prospect.id, channel: "email" })).rejects.toBeInstanceOf(PortfolioError);
    expect(await db.prospectContact.count({ where: { prospectId: foreign.prospect.id } })).toBe(0);
    await eraseProspect({ workspaceId: foreign.workspaceId, prospectId: foreign.prospect.id });
    await expect(logReply({ workspaceId: foreign.workspaceId, prospectId: foreign.prospect.id, channel: "email" })).rejects.toBeInstanceOf(PortfolioError);
  });
});

describe("logReply — le statut « ne pas contacter » n'est jamais écrasé par une réponse simple (D5)", () => {
  it("prospect désinscrit : une réponse simple est consignée mais le statut, la date d'opposition et l'entrée de suppression restent inchangés", async () => {
    const { workspaceId, prospect } = await setup();
    const opted = await optOutProspect({ workspaceId, prospectId: prospect.id });
    const u = await logReply({ workspaceId, prospectId: prospect.id, channel: "email", summary: "Merci quand même" });
    expect(u.status).toBe("do_not_contact");
    expect(u.optedOutAt!.getTime()).toBe(opted.optedOutAt!.getTime());
    expect(await row(prospect.id)).toMatchObject({ status: "do_not_contact" });
    expect(await db.prospectContact.count({ where: { workspaceId, prospectId: prospect.id, direction: "inbound", outcome: "replied" } })).toBe(1);
    expect(await suppressions(workspaceId)).toHaveLength(1);
    expect(await audits(workspaceId, "prospect.opted_out")).toBe(1); // aucun nouvel audit
  });

  it("état hérité incohérent (date d'opposition présente, statut différent) : la réponse simple ne change pas le statut", async () => {
    const { workspaceId, prospect } = await setup();
    await db.prospect.update({ where: { id: prospect.id }, data: { status: "contacted", optedOutAt: new Date("2026-11-01T00:00:00Z") } });
    expect((await logReply({ workspaceId, prospectId: prospect.id, channel: "email" })).status).toBe("contacted");
  });

  it("prospect non désinscrit : comportement inchangé (« a répondu »), « demo / trial / customer » conservés", async () => {
    const { workspaceId, prospect } = await setup();
    expect((await logReply({ workspaceId, prospectId: prospect.id, channel: "email" })).status).toBe("replied");
    for (const status of ["demo", "trial", "customer"]) {
      await db.prospect.update({ where: { id: prospect.id }, data: { status } });
      expect((await logReply({ workspaceId, prospectId: prospect.id, channel: "email" })).status).toBe(status);
    }
  });
});
