import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string; role: string } = { ws: "", role: "admin" };
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
import { PIPELINE_RANK, autoStatusChangeBlockedBy } from "@/lib/constants";
import { processDueFollowUps } from "@/lib/followups";
import { LEASE_MS, SimulatedCrash } from "@/lib/followup-runtime";
import { setEmailProviderForTests } from "@/lib/email";
import { ReviewError, resolveFollowUp, type ResolveInput } from "@/lib/followup-review";
import { changeLeadStatus, updateLeadDetails } from "@/lib/leads";
import { resolveFollowUpAction } from "../src/app/(app)/automations/actions";
import { FakeProvider, MIN, dbFixture, emailFixture, later, noRetryDelay, resetEngineTestState } from "./followup-helpers";
import { resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); noRetryDelay(); state.role = "admin"; });
afterEach(resetEngineTestState);

const row = (id: string) => db.followUp.findUniqueOrThrow({ where: { id } });
const lead = (id: string) => db.lead.findUniqueOrThrow({ where: { id } });
const toFd = (o: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };
const NOTE = "Le client n'a pas répondu mais un devis est en cours : on clôture.";
const crashAfterBody = () => {
  const orig = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
  vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
    orig(async (tx: unknown) => { await fn(tx); throw new SimulatedCrash("après le changement de statut"); }, opts)) as never);
};
const closure = (target: string = "lost") => dbFixture([{ day: 0, action: "status_change", status: target }, { day: 5, action: "task", title: "Suite" }]);
const input = async (f: { workspaceId: string; userId: string; fu: { id: string } }, action: ResolveInput["action"], extra: Partial<ResolveInput> = {}): Promise<ResolveInput> => {
  const r = await row(f.fu.id);
  return { workspaceId: f.workspaceId, userId: f.userId, id: f.fu.id, action, seen: { attemptCount: r.attemptCount, emailStatus: null }, ...extra };
};
/** Prospect qui a progressé avant la clôture automatique, relance passée en needs_review (status_progressed). */
async function progressedFixture(status = "qualified") {
  const f = await closure();
  state.ws = f.workspaceId;
  await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status, actorId: f.userId });
  await processDueFollowUps({ workspaceId: f.workspaceId });
  return f;
}

describe("règle : une relance automatisée ne doit jamais écraser une progression commerciale", () => {
  it("table de décision de autoStatusChangeBlockedBy", () => {
    expect(PIPELINE_RANK).toEqual({ new: 0, contacted: 1, qualified: 2, proposal: 3 });
    const t: [string, string, string | null][] = [
      ["new", "lost", null], ["contacted", "lost", null], ["qualified", "lost", "closure_after_progress"], ["proposal", "lost", "closure_after_progress"],
      ["qualified", "disqualified", "closure_after_progress"], ["new", "disqualified", null],
      ["qualified", "contacted", "regression"], ["proposal", "qualified", "regression"], ["contacted", "new", "regression"],
      ["new", "qualified", null], ["contacted", "proposal", null], ["qualified", "qualified", null],
      ["qualified", "won", null], ["proposal", "won", null], ["new", "won", null],
      ["won", "lost", null], ["lost", "qualified", null], // terminaux : traités avant (relance annulée)
    ];
    for (const [cur, target, expected] of t) expect(autoStatusChangeBlockedBy(cur, target), `${cur} → ${target}`).toBe(expected);
  });

  it.each(["qualified", "proposal"])("progression AVANT la première réservation (« %s ») : clôture « perdu » non appliquée, rien n'est écrasé, relance à examiner, trace d'audit", async (status) => {
    const f = await closure();
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status, actorId: f.userId, value: 1200 });
    await db.lead.update({ where: { id: f.lead.id }, data: { score: 77 } });
    const before = await lead(f.lead.id);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.needsReview).toBe(1);
    const after = await lead(f.lead.id);
    expect(after).toEqual(before); // aucune colonne du prospect n'a été touchée (statut, valeur, score, dates)
    expect([after.status, after.lostAt, after.lostReason]).toEqual([status, null, null]);
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind, r.leaseToken]).toEqual(["needs_review", "status_progressed", null]);
    expect(r.result).toMatch(new RegExp(`statut « ${status} »`));
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(1); // celle de l'utilisateur
    expect(await db.notification.count({ where: { id: `fur:${f.fu.id}:status_progressed` } })).toBe(1);
    const a = await db.auditLog.findFirstOrThrow({ where: { workspaceId: f.workspaceId, action: "followup.status_not_applied" } });
    expect(a.meta).toEqual({ kind: "status_progressed", observedStatus: status, targetStatus: "lost" });
    expect((await processDueFollowUps({ workspaceId: f.workspaceId, now: later(30 * 86_400_000) })).needsReview).toBe(0); // jamais reprise automatiquement
  });

  it("« new » et « contacted » ne sont pas des progressions : la clôture « perdu » s'applique", async () => {
    for (const status of ["new", "contacted"]) {
      const f = await closure();
      if (status === "contacted") await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status, actorId: f.userId });
      expect((await processDueFollowUps({ workspaceId: f.workspaceId })).done).toBeGreaterThanOrEqual(1);
      expect((await lead(f.lead.id)).status).toBe("lost");
    }
  });

  it("retour en arrière dans le pipeline : non appliqué ; progression vers l'avant et « won » : appliqués", async () => {
    const back = await dbFixture([{ day: 0, action: "status_change", status: "contacted" }]);
    await changeLeadStatus({ workspaceId: back.workspaceId, leadId: back.lead.id, status: "qualified", actorId: back.userId });
    expect((await processDueFollowUps({ workspaceId: back.workspaceId })).needsReview).toBe(1);
    expect((await lead(back.lead.id)).status).toBe("qualified");
    const fwd = await dbFixture([{ day: 0, action: "status_change", status: "qualified" }]);
    expect((await processDueFollowUps({ workspaceId: fwd.workspaceId })).done).toBe(1);
    expect((await lead(fwd.lead.id)).status).toBe("qualified");
    const won = await dbFixture([{ day: 0, action: "status_change", status: "won" }]);
    await changeLeadStatus({ workspaceId: won.workspaceId, leadId: won.lead.id, status: "proposal", actorId: won.userId });
    expect((await processDueFollowUps({ workspaceId: won.workspaceId })).done).toBe(1);
    expect((await lead(won.lead.id)).status).toBe("won");
  });

  it("progression APRÈS une réservation interrompue : reprise → relance à examiner, la progression est conservée", async () => {
    const f = await closure();
    crashAfterBody();
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "proposal", actorId: f.userId });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect(s.needsReview).toBe(1);
    expect((await lead(f.lead.id)).status).toBe("proposal");
    expect((await row(f.fu.id)).failureKind).toBe("status_progressed");
  });

  it("changement de statut ENTRE la lecture et l'écriture : écriture conditionnelle refusée, relance à examiner, le statut le plus récent est conservé", async () => {
    const f = await dbFixture([{ day: 0, action: "status_change", status: "qualified" }]);
    const orig = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let injected = false;
    vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: Record<string, unknown>) => Promise<unknown>, opts: unknown) =>
      orig((tx: Record<string, unknown>) => {
        // simule une validation concurrente juste avant l'écriture conditionnelle du statut : la lecture (« new ») est périmée
        const lead = tx.lead as { updateMany: (a: { where?: { status?: string } }) => Promise<unknown>; update: (a: unknown) => Promise<unknown> };
        const proxied = new Proxy(lead, { get(t, p) {
          if (p === "updateMany") return async (args: { where?: { status?: string } }) => { if (!injected && args.where?.status) { injected = true; await t.update({ where: { id: f.lead.id }, data: { status: "contacted" } }); } return t.updateMany(args); };
          return (t as never)[p];
        } });
        return fn(new Proxy(tx, { get(t, p) { return p === "lead" ? proxied : t[p as string]; } }));
      }, opts)) as never);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(injected).toBe(true);
    expect(s.needsReview).toBe(1);
    expect((await lead(f.lead.id)).status).toBe("contacted"); // jamais écrasé par « qualified »
    expect((await row(f.fu.id)).failureKind).toBe("status_conflict");
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(0);
  });

  it("prospect déjà dans un état terminal : la relance est annulée (arrêt normal des relances), rien n'est modifié", async () => {
    const f = await closure();
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "lost", lostReason: "décision humaine" });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.needsReview).toBe(0);
    expect((await lead(f.lead.id)).lostReason).toBe("décision humaine");
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(1);
  });
});

describe("décision humaine après un conflit de statut", () => {
  it("« replanifier » est refusé pour une progression (la relance re-bloquerait aussitôt) ; « annuler » conserve le statut du prospect", async () => {
    const f = await progressedFixture();
    await expect(resolveFollowUp(await input(f, "replan"))).rejects.toThrow(/progressé/);
    await resolveFollowUp(await input(f, "cancel"));
    expect((await row(f.fu.id)).status).toBe("cancelled");
    expect((await lead(f.lead.id)).status).toBe("qualified");
  });

  it("« appliquer le statut » exige note et confirmation ; par un administrateur : statut appliqué, historique avec l'auteur, étapes restantes arrêtées, audit sans donnée personnelle", async () => {
    const f = await progressedFixture();
    await expect(resolveFollowUp(await input(f, "apply_status", { confirm: true, note: "court" }))).rejects.toThrow(/note d'au moins 15/);
    await expect(resolveFollowUp(await input(f, "apply_status", { note: NOTE }))).rejects.toThrow(/confirmation/);
    expect((await lead(f.lead.id)).status).toBe("qualified");
    const out = await resolveFollowUp(await input(f, "apply_status", { confirm: true, note: NOTE }));
    expect(out.message).toMatch(/décision humaine documentée/);
    const l = await lead(f.lead.id);
    expect([l.status, l.lostReason]).toEqual(["lost", expect.stringContaining("Décision humaine")]);
    expect((await row(f.fu.id)).status).toBe("done");
    const act = (await db.leadActivity.findMany({ where: { leadId: f.lead.id, type: "status_changed" } })).find((a) => (a.data as { to: string }).to === "lost")!;
    expect([act.actorId, (act.data as { from: string }).from]).toEqual([f.userId, "qualified"]);
    expect((await row(f.fus[1].id)).status).toBe("cancelled"); // statut terminal : relances restantes arrêtées
    const a = await db.auditLog.findMany({ where: { workspaceId: f.workspaceId, action: { in: ["followup.resolved", "lead.status_changed"] } } });
    expect(a.map((x) => x.action).sort()).toEqual(["followup.resolved", "lead.status_changed", "lead.status_changed"]);
    expect(JSON.stringify(a.map((x) => x.meta))).not.toMatch(/@y\.com/);
  });

  it("deux administrateurs simultanés : une seule application du statut", async () => {
    const f = await progressedFixture();
    const [a, b] = await Promise.allSettled([resolveFollowUp(await input(f, "apply_status", { confirm: true, note: NOTE })), resolveFollowUp(await input(f, "apply_status", { confirm: true, note: NOTE }))]);
    expect([a.status, b.status].filter((x) => x === "fulfilled")).toHaveLength(1);
    expect(((([a, b].find((x) => x.status === "rejected")) as PromiseRejectedResult).reason)).toBeInstanceOf(ReviewError);
    const toLost = (await db.leadActivity.findMany({ where: { leadId: f.lead.id, type: "status_changed" } })).filter((x) => (x.data as { to: string }).to === "lost");
    expect(toLost).toHaveLength(1);
  });

  it("droits : l'action serveur exige « approve_outreach » (membre refusé, administrateur accepté)", async () => {
    const f = await progressedFixture();
    const fd = () => toFd({ id: f.fu.id, action: "apply_status", attemptCount: "1", note: NOTE, confirm: "on" });
    state.role = "member";
    expect((await resolveFollowUpAction({}, fd())).error).toMatch(/permission/);
    expect((await lead(f.lead.id)).status).toBe("qualified");
    state.role = "admin";
    expect((await resolveFollowUpAction({}, fd())).ok).toBe(true);
    expect((await lead(f.lead.id)).status).toBe("lost");
  });

  it("conflit « statut modifié » (pas une progression) : la replanification est permise et applique le statut une fois l'état redevenu compatible", async () => {
    const f = await dbFixture([{ day: 0, action: "status_change", status: "qualified" }]);
    state.ws = f.workspaceId;
    crashAfterBody();
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "contacted", actorId: f.userId });
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect((await row(f.fu.id)).failureKind).toBe("status_conflict");
    await resolveFollowUp(await input(f, "replan"));
    expect((await processDueFollowUps({ workspaceId: f.workspaceId })).done).toBe(1);
    expect((await lead(f.lead.id)).status).toBe("qualified");
  });

  it("« appliquer le statut » est refusé pour toute autre relance", async () => {
    const f = await emailFixture();
    state.ws = f.workspaceId;
    await expect(resolveFollowUp(await input(f, "apply_status", { confirm: true, note: NOTE }))).rejects.toBeInstanceOf(ReviewError);
  });
});

describe("consentement : comportement complet vérifié", () => {
  it("prospect sans consentement journalisé (consentMarketing vrai mais aucune ligne de consentement) : aucun envoi, relance bloquée", async () => {
    const f = await emailFixture();
    await db.consent.deleteMany({ where: { leadId: f.lead.id } });
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.blocked).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await row(f.fu.id)).result).toMatch(/Aucun consentement marketing enregistré pour cette adresse/);
  });

  it("les relances annulées par un changement d'adresse ne sont JAMAIS réactivées automatiquement, même après un consentement explicite pour la nouvelle adresse", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await updateLeadDetails({ workspaceId: f.workspaceId, leadId: f.lead.id, name: "Marie Durand", email: "nouvelle@y.com", phone: null, company: null, value: null });
    await updateLeadDetails({ workspaceId: f.workspaceId, leadId: f.lead.id, name: "Marie Durand", email: "nouvelle@y.com", phone: null, company: null, value: null, consentForEmail: true });
    expect((await lead(f.lead.id)).consentMarketing).toBe(true);
    const before = await db.followUp.findMany({ where: { leadId: f.lead.id }, orderBy: { id: "asc" } });
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(30 * 86_400_000) });
    expect(p.calls).toHaveLength(0);
    expect(await db.followUp.findMany({ where: { leadId: f.lead.id }, orderBy: { id: "asc" } })).toEqual(before);
    expect(before.map((x) => [x.status, x.failureKind])).toEqual([["cancelled", "email_changed"]]);
  });

  it("preuve et source du consentement : adresse, source, texte et date sont enregistrés pour chaque ligne ; consentement attesté par un utilisateur du SaaS ≠ consentement obtenu auprès du prospect", async () => {
    const f = await emailFixture();
    await updateLeadDetails({ workspaceId: f.workspaceId, leadId: f.lead.id, name: "Marie Durand", email: "nouvelle@y.com", phone: null, company: null, value: null, consentForEmail: true });
    const rows = await db.consent.findMany({ where: { leadId: f.lead.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.email, r.granted, r.source])).toEqual([["m@y.com", true, "manual"], ["m@y.com", false, "email_changed"], ["nouvelle@y.com", true, "manual_email_change"]]);
    expect(rows.every((r) => r.createdAt instanceof Date && r.type === "marketing")).toBe(true);
    expect(rows[2].text).toMatch(/attesté par l'utilisateur de SEA Pilot/);
    const l = await lead(f.lead.id);
    expect(l.consentAt).not.toBeNull();
    expect(l.consentText).toMatch(/attesté par l'utilisateur/);
  });
});
