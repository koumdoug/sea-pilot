import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { eraseLead } from "@/lib/leads";
import { processDueFollowUps } from "@/lib/followups";
import { EmailError, setEmailProviderForTests, storableProviderError } from "@/lib/email";
import { setSendHooksForTests } from "@/lib/followup-send";
import { FakeProvider, emailFixture, gate, noRetryDelay, resetEngineTestState, stallOnce } from "./followup-helpers";
import { resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); noRetryDelay(); });
afterEach(resetEngineTestState);

const PII = ["m@y.com", "Marie", "Durand"];
const LEAK = "refus : l'adresse m@y.com de Marie Durand est invalide";

type Case = { name: string; expected: "sent" | "failed" | "uncertain"; behavior: () => Promise<{ id: string | null; httpStatus: number }> };
const CASES: Case[] = [
  { name: "accepté", expected: "sent", behavior: async () => ({ id: "msg_ok", httpStatus: 200 }) },
  { name: "refusé (message du fournisseur citant l'adresse)", expected: "failed", behavior: async () => { throw new EmailError(LEAK, { kind: "rejected", status: 422 }); } },
  { name: "incertain (EmailError citant l'adresse)", expected: "uncertain", behavior: async () => { throw new EmailError(LEAK, { kind: "uncertain", status: 502 }); } },
  { name: "incertain (exception quelconque citant l'adresse)", expected: "uncertain", behavior: async () => { throw new Error(LEAK); } },
];

/** Tout ce que le moteur persiste autour d'une tentative : journal, relances, tâches, notifications, audit. */
async function persisted(workspaceId: string, leadId: string) {
  return JSON.stringify({
    logs: await db.emailLog.findMany({ where: { workspaceId } }), fus: await db.followUp.findMany({ where: { leadId } }), tasks: await db.task.findMany({ where: { workspaceId } }),
    notifs: await db.notification.findMany({ where: { workspaceId, href: { not: { startsWith: "/leads/" } } } }), audit: await db.auditLog.findMany({ where: { workspaceId, action: { not: "workspace.created" } } }),
  });
}

describe("résultat fournisseur tardif et effacement", () => {
  for (const c of CASES) {
    it(`${c.name} : RÉSULTAT APRÈS l'effacement (appel parti, effacement validé, puis résultat) — aucune donnée personnelle réintroduite`, async () => {
      const f = await emailFixture();
      setEmailProviderForTests(new FakeProvider(c.behavior));
      const g = gate();
      setSendHooksForTests({ afterSend: stallOnce(g) }); // l'appel a abouti (ou échoué) ; le résultat n'est pas encore écrit
      const worker = processDueFollowUps({ workspaceId: f.workspaceId });
      await g.reached;
      expect(await eraseLead(f.workspaceId, f.lead.id, f.userId)).toBe(true);
      g.release();
      await worker;
      const log = await db.emailLog.findFirstOrThrow({ where: { leadId: f.lead.id } });
      expect([log.to, log.subject]).toEqual(["[effacé]", "[effacé]"]);
      expect(log.status).toBe(c.expected); // le résultat technique est enregistré (conservation de la preuve d'un envoi éventuel)
      if (c.expected === "sent") expect(log.providerMessageId).toBe("msg_ok");
      const text = await persisted(f.workspaceId, f.lead.id);
      for (const s of PII) expect(text, s).not.toContain(s);
    });

    it(`${c.name} : résultat AVANT l'effacement — journal complet puis anonymisé`, async () => {
      const f = await emailFixture();
      setEmailProviderForTests(new FakeProvider(c.behavior));
      await processDueFollowUps({ workspaceId: f.workspaceId });
      const before = await db.emailLog.findFirstOrThrow({ where: { leadId: f.lead.id } });
      expect([before.to, before.status]).toEqual(["m@y.com", c.expected]);
      for (const s of PII) expect(before.error ?? "", s).not.toContain(s); // même avant l'effacement : jamais de texte libre du fournisseur
      await eraseLead(f.workspaceId, f.lead.id, f.userId);
      const after = await db.emailLog.findFirstOrThrow({ where: { leadId: f.lead.id } });
      expect([after.to, after.subject, after.status]).toEqual(["[effacé]", "[effacé]", c.expected]);
      for (const s of PII) expect(await persisted(f.workspaceId, f.lead.id), s).not.toContain(s);
    });
  }

  it("texte d'erreur stockable : les messages fixes connus sont conservés, tout autre texte est remplacé par un libellé neutre", () => {
    expect(storableProviderError(new EmailError("Resend HTTP 422", { kind: "rejected", status: 422 }))).toBe("Resend HTTP 422");
    expect(storableProviderError(new EmailError("Resend injoignable ou délai dépassé"))).toBe("Resend injoignable ou délai dépassé");
    expect(storableProviderError(new EmailError(LEAK, { kind: "rejected", status: 422 }))).toBe("Refus du fournisseur (HTTP 422)");
    expect(storableProviderError(new EmailError(LEAK, { kind: "uncertain", status: 502 }))).toBe("Résultat indéterminé (HTTP 502)");
    expect(storableProviderError(new EmailError(LEAK))).toBe("Résultat indéterminé");
    expect(storableProviderError(new Error(LEAK))).toBe("Résultat indéterminé (erreur technique du fournisseur)");
    for (const e of [new Error(LEAK), new EmailError(LEAK, { status: 400 })]) for (const s of PII) expect(storableProviderError(e)).not.toContain(s);
  });
});
