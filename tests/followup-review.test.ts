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
import { processDueFollowUps } from "@/lib/followups";
import { LEASE_MS, SimulatedCrash } from "@/lib/followup-runtime";
import { setEmailProviderForTests } from "@/lib/email";
import { setSendHooksForTests } from "@/lib/followup-send";
import { ReviewError, hasContradiction, listContradictions, listReviewItems, reconcileAcceptedReviews, resolveFollowUp, type ResolveInput } from "@/lib/followup-review";
import { emailAttemptLabel, reviewReason, verdictLabel } from "@/lib/followup-labels";
import { resolveFollowUpAction } from "../src/app/(app)/automations/actions";
import { FakeProvider, MIN, dbFixture, emailFixture, later, noRetryDelay, resetEngineTestState, taskFixture } from "./followup-helpers";
import { resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); noRetryDelay(); state.role = "admin"; });
afterEach(resetEngineTestState);

const row = (id: string) => db.followUp.findUniqueOrThrow({ where: { id } });
const logs = (id: string) => db.emailLog.findMany({ where: { followUpId: id }, orderBy: { attemptNo: "asc" } });
const NOTE = "Vérifié dans le tableau de bord du fournisseur (id msg_42).";

/** Relance e-mail dont le résultat est INCERTAIN (erreur réseau) : needs_review, tentative « uncertain ». */
async function uncertainFixture() {
  const f = await emailFixture();
  state.ws = f.workspaceId;
  const p = new FakeProvider(async () => { throw new Error("réseau indisponible"); });
  setEmailProviderForTests(p);
  await processDueFollowUps({ workspaceId: f.workspaceId });
  return { ...f, p };
}
/** Relance e-mail dont l'appel a POTENTIELLEMENT commencé (arrêt après la marque d'appel), reprise → needs_review ; tentative « attempting ». */
async function inFlightFixture() {
  const f = await emailFixture();
  state.ws = f.workspaceId;
  const p = new FakeProvider();
  setEmailProviderForTests(p);
  setSendHooksForTests({ afterP2: () => { throw new SimulatedCrash("afterP2"); } });
  await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
  setSendHooksForTests(null);
  await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
  return { ...f, p };
}
const input = async (f: { workspaceId: string; userId: string; fu: { id: string } }, action: ResolveInput["action"], extra: Partial<ResolveInput> = {}): Promise<ResolveInput> => {
  const r = await row(f.fu.id);
  const last = (await logs(f.fu.id)).filter((a) => a.status !== "aborted").at(-1);
  return { workspaceId: f.workspaceId, userId: f.userId, id: f.fu.id, action, seen: { attemptCount: r.attemptCount, emailStatus: last?.status ?? null }, ...extra };
};
const toFd = (o: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };

describe("droits : résolutions réservées aux administrateurs", () => {
  it.each(["member", "viewer"])("le rôle « %s » est refusé (côté serveur), rien n'est modifié", async (role) => {
    const f = await uncertainFixture();
    state.role = role;
    const r = await resolveFollowUpAction({}, toFd({ id: f.fu.id, action: "cancel", attemptCount: "1", emailStatus: "uncertain" }));
    expect(r.error).toMatch(/permission/);
    expect((await row(f.fu.id)).status).toBe("needs_review");
  });
  it.each(["admin", "owner"])("le rôle « %s » peut résoudre", async (role) => {
    const f = await uncertainFixture();
    state.role = role;
    const r = await resolveFollowUpAction({}, toFd({ id: f.fu.id, action: "cancel", attemptCount: "1", emailStatus: "uncertain" }));
    expect(r.ok).toBe(true);
    expect((await row(f.fu.id)).status).toBe("cancelled");
  });
  it("une relance d'un AUTRE espace est introuvable", async () => {
    const a = await uncertainFixture();
    const b = await dbFixture([{ day: 5, action: "task", title: "T" }]);
    state.ws = b.workspaceId;
    await expect(resolveFollowUp({ ...(await input(a, "cancel")), workspaceId: b.workspaceId })).rejects.toThrow(/introuvable/);
  });
});

describe("marquer envoyé / non envoyé : confirmation humaine documentée", () => {
  it("« marquer envoyé » exige note et confirmation ; le résultat fournisseur n'est PAS modifié, le verdict humain est distinct", async () => {
    const f = await uncertainFixture();
    await expect(resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: "court" }))).rejects.toThrow(/note d'au moins 15/);
    await expect(resolveFollowUp(await input(f, "mark_sent", { note: NOTE }))).rejects.toThrow(/confirmation/);
    expect((await row(f.fu.id)).status).toBe("needs_review");
    await resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: NOTE }));
    const [e] = await logs(f.fu.id);
    expect([e.status, e.humanVerdict, e.humanVerdictById, e.humanNote]).toEqual(["uncertain", "confirmed_sent", f.userId, NOTE]);
    expect(e.humanVerdictAt).not.toBeNull();
    expect(e.providerMessageId).toBeNull(); // jamais présenté comme une acceptation du fournisseur
    const r = await row(f.fu.id);
    expect([r.status, r.result]).toEqual(["done", expect.stringContaining("non confirmée par le fournisseur")]);
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { workspaceId: f.workspaceId, action: "followup.resolved" } })).toBe(1);
    expect(f.p.calls).toHaveLength(1);
  });

  it("« marquer non envoyé » : relance bloquée + tâche manuelle déterministe ; aucun envoi", async () => {
    const f = await uncertainFixture();
    await resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE }));
    expect((await logs(f.fu.id))[0].humanVerdict).toBe("confirmed_not_sent");
    expect((await row(f.fu.id)).status).toBe("blocked");
    expect((await db.task.findMany({ where: { leadId: f.lead.id } })).map((t) => t.id)).toEqual([`fut:${f.fu.id}`]);
    expect(f.p.calls).toHaveLength(1);
  });

  it("deux administrateurs simultanés : une seule décision est enregistrée, l'autre est refusée sans rien écraser", async () => {
    const f = await uncertainFixture();
    const [a, b] = await Promise.allSettled([
      resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: NOTE })),
      resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE })),
    ]);
    expect([a.status, b.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    const rejected = [a, b].find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReviewError);
    const [e] = await logs(f.fu.id);
    const r = await row(f.fu.id);
    expect((e.humanVerdict === "confirmed_sent") === (r.status === "done")).toBe(true);
  });

  it("état modifié depuis l'affichage : la décision est refusée", async () => {
    const f = await uncertainFixture();
    const stale = await input(f, "cancel");
    await expect(resolveFollowUp({ ...stale, seen: { attemptCount: 0, emailStatus: "uncertain" } })).rejects.toThrow(/a changé/);
    await expect(resolveFollowUp({ ...stale, seen: { attemptCount: 1, emailStatus: "attempting" } })).rejects.toThrow(/a changé/);
    expect((await row(f.fu.id)).status).toBe("needs_review");
  });

  it("e-mail accepté par le fournisseur : « marquer non envoyé » et « annuler » refusés ; « finaliser » finalise sans renvoyer", async () => {
    const f = await inFlightFixture();
    // résultat tardif du fournisseur enregistré dans sa tentative (écriture conditionnelle de l'envoi)
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "sent", providerMessageId: "msg_late", finishedAt: new Date() } });
    await expect(resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE }))).rejects.toThrow(ReviewError);
    await expect(resolveFollowUp(await input(f, "cancel"))).rejects.toThrow(/accepté/);
    await resolveFollowUp(await input(f, "finalize"));
    expect((await row(f.fu.id)).status).toBe("done");
    expect(f.p.calls).toHaveLength(0);
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(1);
  });

  it("la réconciliation automatique finalise une acceptation tardive, sauf si un verdict humain existe", async () => {
    const f = await inFlightFixture();
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "sent", finishedAt: new Date() } });
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id }, data: { humanVerdict: "confirmed_not_sent" } });
    expect(await reconcileAcceptedReviews()).toBe(0);
    expect((await row(f.fu.id)).status).toBe("needs_review");
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id }, data: { humanVerdict: null } });
    expect(await reconcileAcceptedReviews()).toBe(1);
    expect((await row(f.fu.id)).status).toBe("done");
  });
});

describe("contradiction entre le verdict humain et le résultat du fournisseur", () => {
  it("verdict « non envoyé » puis résultat tardif « accepté » : la relance et le verdict ne sont pas écrasés ; aucun renvoi ; acquittement documenté sans effet sur l'envoi", async () => {
    const f = await inFlightFixture();
    await resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE }));
    expect((await row(f.fu.id)).status).toBe("blocked");
    // résultat fournisseur tardif : écriture conditionnelle de l'envoi (status = attempting), indépendante du verdict humain
    const late = await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "sent", providerMessageId: "msg_late", finishedAt: new Date() } });
    expect(late.count).toBe(1);
    const [e] = await logs(f.fu.id);
    expect([e.status, e.humanVerdict, hasContradiction(e)]).toEqual(["sent", "confirmed_not_sent", true]);
    expect((await row(f.fu.id)).status).toBe("blocked");
    expect(await listContradictions(f.workspaceId)).toHaveLength(1);
    await expect(resolveFollowUp(await input(f, "resend", { confirm: true }))).rejects.toThrow(ReviewError);
    await expect(resolveFollowUp(await input(f, "ack_contradiction", { attemptId: e.id, confirm: true, typed: "COMPRIS", note: "trop court" }))).rejects.toThrow(/note d'au moins 20/);
    await expect(resolveFollowUp(await input(f, "ack_contradiction", { attemptId: e.id, confirm: true, note: "Preuve : message livré, id msg_late, vérifié sur le tableau de bord." }))).rejects.toThrow(/COMPRIS/);
    await resolveFollowUp(await input(f, "ack_contradiction", { attemptId: e.id, confirm: true, typed: "COMPRIS", note: "Preuve : message livré, id msg_late, vérifié sur le tableau de bord." }));
    const e2 = (await logs(f.fu.id))[0];
    expect([e2.contradictionAckById, e2.status, e2.humanVerdict]).toEqual([f.userId, "sent", "confirmed_not_sent"]);
    expect((await row(f.fu.id)).status).toBe("blocked"); // l'acquittement n'ouvre aucun renvoi
    expect(await listContradictions(f.workspaceId)).toHaveLength(0);
    expect(f.p.calls).toHaveLength(0);
  });

  it("verdict « envoyé » puis refus tardif du fournisseur : contradiction signalée, relance inchangée", async () => {
    const f = await inFlightFixture();
    await resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: NOTE }));
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "failed", httpStatus: 422, finishedAt: new Date() } });
    const [e] = await logs(f.fu.id);
    expect([e.status, e.humanVerdict, hasContradiction(e)]).toEqual(["failed", "confirmed_sent", true]);
    expect((await row(f.fu.id)).status).toBe("done");
  });

  it("« marquer envoyé » est refusé quand le fournisseur a déjà refusé explicitement", async () => {
    const f = await inFlightFixture();
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "failed", httpStatus: 422 } });
    await expect(resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: NOTE }))).rejects.toThrow(ReviewError);
  });
});

describe("renvoi manuel", () => {
  it("exige la confirmation ; dans la fenêtre d'idempotence, la clé du premier envoi est réutilisée ; hors plafond ; historique distinct de chaque tentative", async () => {
    const f = await uncertainFixture();
    const first = (await logs(f.fu.id))[0];
    f.p.behavior = async () => ({ id: "msg_2", httpStatus: 200 });
    await expect(resolveFollowUp(await input(f, "resend"))).rejects.toThrow(/confirmation/);
    expect(f.p.calls).toHaveLength(1);
    const out = await resolveFollowUp(await input(f, "resend", { confirm: true }));
    expect(out.message).toMatch(/renvoyé/);
    expect(f.p.calls).toHaveLength(2);
    expect(f.p.calls[1].idempotencyKey).toBe(first.idempotencyKey); // même contenu, moins de 23 h : la protection du fournisseur s'applique
    const l = await logs(f.fu.id);
    expect(l.map((x) => [x.attemptNo, x.status])).toEqual([[1, "uncertain"], [2, "sent"]]);
    expect(l[1].id).toBe(`el:${f.fu.id}:2`);
    const r = await row(f.fu.id);
    expect([r.status, r.attemptCount]).toEqual(["done", 1]); // un renvoi humain ne consomme pas le plafond
  });

  it("plus de 24 h : avertissement renforcé (mot de confirmation) et NOUVELLE clé d'idempotence", async () => {
    const f = await uncertainFixture();
    const first = (await logs(f.fu.id))[0];
    await db.emailLog.update({ where: { id: first.id }, data: { authorizedAt: new Date(Date.now() - 25 * 3_600_000) } });
    f.p.behavior = async () => ({ id: "msg_2", httpStatus: 200 });
    await expect(resolveFollowUp(await input(f, "resend", { confirm: true }))).rejects.toThrow(/RENVOYER/);
    expect(f.p.calls).toHaveLength(1);
    await resolveFollowUp(await input(f, "resend", { confirm: true, typed: "renvoyer" }));
    expect(f.p.calls).toHaveLength(2);
    expect(f.p.calls[1].idempotencyKey).toBe(`fu:${f.fu.id}:2`);
    expect(f.p.calls[1].idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("refusé : tentative acceptée ou refusée, ancienne ligne, séquence supprimée ou désactivée, prospect désinscrit (contrôle juste avant l'envoi)", async () => {
    const f = await uncertainFixture();
    await db.followUpSequence.update({ where: { id: f.seq.id }, data: { sendEmails: false } });
    await expect(resolveFollowUp(await input(f, "resend", { confirm: true }))).rejects.toThrow(/séquence/);
    await db.followUpSequence.update({ where: { id: f.seq.id }, data: { sendEmails: true } });
    await db.lead.update({ where: { id: f.lead.id }, data: { consentMarketing: false } });
    const out = await resolveFollowUp(await input(f, "resend", { confirm: true }));
    expect(out.message).toMatch(/n'a pas été envoyé/);
    expect(f.p.calls).toHaveLength(1); // aucun envoi : consentement retiré
    expect(await logs(f.fu.id)).toHaveLength(1);
  });
});

describe("anciennes lignes « running » sans bail et relances techniques", () => {
  it("liste de revue : anciennes lignes et needs_review avec leurs tentatives", async () => {
    const f = await taskFixture();
    state.ws = f.workspaceId;
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "running" } });
    const items = await listReviewItems(f.workspaceId);
    expect(items).toHaveLength(1);
    expect([items[0].legacy, items[0].status]).toEqual([true, "running"]);
    expect(reviewReason(items[0])).toMatch(/sans bail/);
  });

  it("tâche : replanification confirmée (compteurs remis à 0) puis exécution unique ; annulation possible", async () => {
    const f = await taskFixture();
    state.ws = f.workspaceId;
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "running", attemptCount: 2, technicalFailureCount: 4 } });
    await expect(resolveFollowUp(await input(f, "replan"))).rejects.toThrow(/confirmation/);
    await resolveFollowUp(await input(f, "replan", { confirm: true }));
    const r = await row(f.fu.id);
    expect([r.status, r.attemptCount, r.technicalFailureCount, r.leaseToken]).toEqual(["pending", 0, 0, null]);
    await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(1);
  });

  it("replanification refusée si la séquence est inactive ; relance annulable", async () => {
    const f = await taskFixture();
    state.ws = f.workspaceId;
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "running" } });
    await db.followUpSequence.update({ where: { id: f.seq.id }, data: { active: false } });
    await expect(resolveFollowUp(await input(f, "replan", { confirm: true }))).rejects.toThrow(/inactive/);
    await resolveFollowUp(await input(f, "cancel"));
    expect((await row(f.fu.id)).status).toBe("cancelled");
  });

  it("e-mail ancien : jamais replanifié ni renvoyé ; « marquer non envoyé » documenté ; « marquer envoyé » sans acceptation du fournisseur", async () => {
    const f = await emailFixture();
    state.ws = f.workspaceId;
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "running" } });
    await expect(resolveFollowUp(await input(f, "replan", { confirm: true }))).rejects.toThrow(ReviewError);
    await expect(resolveFollowUp(await input(f, "resend", { confirm: true }))).rejects.toThrow(ReviewError);
    await resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: NOTE }));
    const r = await row(f.fu.id);
    expect(r.status).toBe("done");
    expect(r.result).toMatch(/non confirmée par le fournisseur/);
    expect(await logs(f.fu.id)).toHaveLength(0); // aucune tentative inventée
  });

  it("échec technique persistant : replanification possible (aucun effet externe) ; compteurs remis à 0", async () => {
    const f = await taskFixture();
    state.ws = f.workspaceId;
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "needs_review", failureKind: "technical_persistent", technicalFailureCount: 12 } });
    await resolveFollowUp(await input(f, "replan"));
    const r = await row(f.fu.id);
    expect([r.status, r.technicalFailureCount, r.failureKind]).toEqual(["pending", 0, null]);
  });
});

describe("libellés : le résultat du fournisseur et la décision humaine sont toujours distincts", () => {
  it("« attempting » n'est jamais présenté comme « envoyé »", () => {
    expect(emailAttemptLabel({ status: "attempting", callStartedAt: new Date() })).toBe("Envoi potentiellement effectué — vérification nécessaire");
    expect(emailAttemptLabel({ status: "attempting", callStartedAt: null })).toMatch(/non commencé/);
    expect(emailAttemptLabel({ status: "sent", callStartedAt: new Date() })).toBe("Accepté par le fournisseur");
    expect(emailAttemptLabel({ status: "failed", callStartedAt: new Date() })).toBe("Refusé par le fournisseur");
    expect(emailAttemptLabel({ status: "uncertain", callStartedAt: new Date() })).toMatch(/incertain/);
    expect(emailAttemptLabel({ status: "aborted", callStartedAt: null })).toMatch(/Non envoyé/);
  });
  it("verdict humain : confirmation humaine distincte de l'acceptation du fournisseur", () => {
    expect(verdictLabel("confirmed_sent", "uncertain")).toMatch(/non confirmée par le fournisseur/);
    expect(verdictLabel("confirmed_sent", "sent")).not.toMatch(/non confirmée/);
    expect(verdictLabel("confirmed_not_sent", "uncertain")).toMatch(/non envoyé/);
    expect(verdictLabel(null, "sent")).toBeNull();
  });
});
