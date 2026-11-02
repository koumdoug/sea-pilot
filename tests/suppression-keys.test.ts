import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { createLead, eraseLead, unsubscribeLead } from "@/lib/leads";
import { prepareFollowUpEmail, setEmailProviderForTests } from "@/lib/email";
import {
  UNKNOWN_KEY_REASON, backfillSuppressionKeys, erasedEmailKey, isEmailSuppressed, keyedEmailKey, suppressionCandidates, suppressionKeyring, suppressionStatus, suppressionWriteKey,
} from "@/lib/suppression";
import { FakeProvider } from "./followup-helpers";
import { makeWorkspace, resetDb } from "./helpers";

const KA = "cle-dediee-A-".padEnd(48, "a");
const KB = "cle-dediee-B-".padEnd(48, "b");
const VARS = ["SUPPRESSION_HMAC_KEY", "SUPPRESSION_HMAC_KEY_PREVIOUS", "ENCRYPTION_KEY"] as const;
const saved: Record<string, string | undefined> = {};
function keys(cur?: string, prev?: string) {
  if (cur === undefined) delete process.env.SUPPRESSION_HMAC_KEY; else process.env.SUPPRESSION_HMAC_KEY = cur;
  if (prev === undefined) delete process.env.SUPPRESSION_HMAC_KEY_PREVIOUS; else process.env.SUPPRESSION_HMAC_KEY_PREVIOUS = prev;
}
beforeEach(async () => { for (const v of VARS) saved[v] = process.env[v]; keys(); delete process.env.ENCRYPTION_KEY; await resetDb(); });
afterEach(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } setEmailProviderForTests(null); vi.restoreAllMocks(); });

const ADDR = "marie.suppr@exemple.test";
const rows = (workspaceId: string) => db.emailSuppression.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });

describe("liste de suppression : clé absente ou refusée (comportement sûr et explicite)", () => {
  it("sans clé : désinscription en clair, effacement par empreinte sans secret, avertissement journalisé sans valeur de clé", async () => {
    const warn = vi.spyOn(log, "warn");
    const { workspaceId } = await makeWorkspace();
    expect(suppressionKeyring().current).toBeNull();
    expect(suppressionWriteKey(workspaceId, `  ${ADDR.toUpperCase()} `, { fallback: "plain" })).toBe(ADDR);
    expect(suppressionWriteKey(workspaceId, ADDR, { fallback: "sha" })).toBe(erasedEmailKey(workspaceId, ADDR));
    expect(warn).toHaveBeenCalledWith("suppression.key_missing", expect.objectContaining({ problem: "SUPPRESSION_HMAC_KEY non définie" }));
  });

  it("clé trop courte, ou identique à SESSION_SECRET ou ENCRYPTION_KEY : refusée avec un motif, repli sûr, jamais de clé dans le journal", async () => {
    const warn = vi.spyOn(log, "warn");
    const { workspaceId } = await makeWorkspace();
    keys("court");
    expect(suppressionKeyring().current).toBeNull();
    expect(suppressionKeyring().problems[0]).toContain("moins de 32");
    expect(suppressionWriteKey(workspaceId, ADDR, { fallback: "plain" })).toBe(ADDR);
    keys(process.env.SESSION_SECRET!);
    expect(suppressionKeyring().current).toBeNull();
    expect(suppressionKeyring().problems[0]).toContain("SESSION_SECRET");
    process.env.ENCRYPTION_KEY = KA; keys(KA);
    expect(suppressionKeyring().current).toBeNull();
    for (const call of warn.mock.calls) for (const secret of ["court", process.env.SESSION_SECRET!, KA]) expect(JSON.stringify(call)).not.toContain(secret);
  });
});

describe("liste de suppression : clé dédiée", () => {
  it("désinscription : entrée HMAC (jamais l'adresse en clair), adresse bloquée, normalisation cohérente", async () => {
    keys(KA);
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "M", email: ADDR, consentMarketing: true });
    await unsubscribeLead(workspaceId, lead.id);
    const r = await rows(workspaceId);
    expect(r).toHaveLength(1);
    expect(r[0].email).toMatch(/^h1:[0-9a-f]{12}:[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain("exemple.test");
    expect(r[0].reason).toBe("unsubscribe");
    for (const variant of [ADDR, ` ${ADDR.toUpperCase()} `, "Marie.Suppr@Exemple.TEST"]) expect(await isEmailSuppressed(db, workspaceId, variant)).toBe(true);
    expect(await isEmailSuppressed(db, workspaceId, "autre@exemple.test")).toBe(false);
  });

  it("isolation entre espaces : même adresse, empreintes différentes, aucune fuite de blocage", async () => {
    keys(KA);
    const a = await makeWorkspace(), b = await makeWorkspace();
    const { lead } = await createLead({ workspaceId: a.workspaceId, name: "M", email: ADDR, consentMarketing: true });
    await unsubscribeLead(a.workspaceId, lead.id);
    expect(await isEmailSuppressed(db, a.workspaceId, ADDR)).toBe(true);
    expect(await isEmailSuppressed(db, b.workspaceId, ADDR)).toBe(false);
    const ring = suppressionKeyring().current!;
    expect(keyedEmailKey(a.workspaceId, ADDR, ring)).not.toBe(keyedEmailKey(b.workspaceId, ADDR, ring));
    expect(await rows(b.workspaceId)).toHaveLength(0);
  });

  it("effacement : entrée HMAC, preuve de consentement pseudonymisée avec la même clé, aucune adresse en clair", async () => {
    keys(KA);
    const { workspaceId, userId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "M", email: ADDR, consentMarketing: true });
    await unsubscribeLead(workspaceId, lead.id); // entrée issue d'une désinscription
    await db.emailSuppression.create({ data: { workspaceId, email: ADDR, reason: "unsubscribe" } }); // ancienne entrée en clair
    await eraseLead(workspaceId, lead.id, userId);
    const r = await rows(workspaceId);
    expect(r.every((x) => x.email.startsWith("h1:"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("exemple.test");
    const consents = await db.consent.findMany({ where: { leadId: lead.id } });
    expect(consents.length).toBeGreaterThan(0);
    expect(new Set(consents.map((c) => c.email)).size).toBe(1);
    expect(consents[0].email).toBe(keyedEmailKey(workspaceId, ADDR, suppressionKeyring().current!));
    expect(await isEmailSuppressed(db, workspaceId, ADDR)).toBe(true);
  });

  it("anciennes entrées (en clair, empreinte sans secret) : toujours reconnues quand une clé dédiée est configurée", async () => {
    keys(KA);
    const { workspaceId } = await makeWorkspace();
    await db.emailSuppression.create({ data: { workspaceId, email: "ancien@exemple.test", reason: "unsubscribe" } });
    await db.emailSuppression.create({ data: { workspaceId, email: erasedEmailKey(workspaceId, "efface@exemple.test"), reason: "erasure" } });
    expect(await suppressionStatus(db, workspaceId, "ancien@exemple.test")).toBe("listed");
    expect(await suppressionStatus(db, workspaceId, "EFFACE@exemple.test")).toBe("listed");
    expect(await suppressionStatus(db, workspaceId, "libre@exemple.test")).toBe("clear");
    expect(suppressionCandidates(workspaceId, "x@y.test")).toHaveLength(3); // clair, empreinte sans secret, HMAC courant
  });
});

describe("liste de suppression : rotation de clé", () => {
  it("l'ancienne clé en lecture seule garde les adresses désinscrites bloquées ; les nouvelles entrées utilisent la nouvelle clé", async () => {
    keys(KA);
    const { workspaceId } = await makeWorkspace();
    const old = await createLead({ workspaceId, name: "Ancien", email: "ancien@exemple.test", consentMarketing: true });
    await unsubscribeLead(workspaceId, old.lead.id);
    const kidA = suppressionKeyring().current!.kid;
    keys(KB, KA); // rotation : B courante, A conservée en lecture
    const ring = suppressionKeyring();
    expect(ring.current!.kid).not.toBe(kidA);
    expect(ring.all.map((k) => k.kid)).toEqual([ring.current!.kid, kidA]);
    expect(await suppressionStatus(db, workspaceId, "ancien@exemple.test")).toBe("listed"); // protégée par A
    expect(await suppressionStatus(db, workspaceId, "libre@exemple.test")).toBe("clear");
    const nouveau = await createLead({ workspaceId, name: "Nouveau", email: "nouveau@exemple.test", consentMarketing: true });
    await unsubscribeLead(workspaceId, nouveau.lead.id);
    const r = await rows(workspaceId);
    expect(r.map((x) => x.email.split(":")[1]).sort()).toEqual([kidA, ring.current!.kid].sort());
    expect(await suppressionStatus(db, workspaceId, "nouveau@exemple.test")).toBe("listed");
  });

  it("clé retirée sans la conserver en lecture : aucune adresse n'est réautorisée en silence — l'espace est bloqué avec un motif explicite", async () => {
    keys(KA);
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "M", email: ADDR, consentMarketing: true });
    await unsubscribeLead(workspaceId, lead.id);
    const autre = await createLead({ workspaceId, name: "Autre", email: "autre@exemple.test", consentMarketing: true });
    for (const config of [[KB, undefined], [undefined, undefined], [KB, "trop-court"]] as const) {
      keys(config[0], config[1]);
      expect(await suppressionStatus(db, workspaceId, ADDR)).toBe("unknown_key"); // l'adresse désinscrite n'est PAS redevenue envoyable
      expect(await isEmailSuppressed(db, workspaceId, ADDR)).toBe(true);
      expect(await isEmailSuppressed(db, workspaceId, "autre@exemple.test")).toBe(true); // échec fermé : l'espace ne peut plus envoyer tant que la clé manque
      setEmailProviderForTests(new FakeProvider());
      const prep = await prepareFollowUpEmail({ workspaceId, leadId: autre.lead.id, subject: "S", body: "B" });
      expect(prep).toEqual({ ok: false, reason: UNKNOWN_KEY_REASON });
    }
    keys(KB, KA); // la clé réapparaît : le blocage est levé, l'adresse reste bloquée
    expect(await suppressionStatus(db, workspaceId, ADDR)).toBe("listed");
    expect(await suppressionStatus(db, workspaceId, "autre@exemple.test")).toBe("clear");
  });

  it("un autre espace sans entrée HMAC n'est pas touché par l'échec fermé d'un espace voisin", async () => {
    keys(KA);
    const a = await makeWorkspace(), b = await makeWorkspace();
    const { lead } = await createLead({ workspaceId: a.workspaceId, name: "M", email: ADDR, consentMarketing: true });
    await unsubscribeLead(a.workspaceId, lead.id);
    keys(KB);
    expect(await suppressionStatus(db, a.workspaceId, "x@exemple.test")).toBe("unknown_key");
    expect(await suppressionStatus(db, b.workspaceId, "x@exemple.test")).toBe("clear");
  });
});

describe("liste de suppression : migration progressive des entrées en clair", () => {
  async function seed() {
    const { workspaceId } = await makeWorkspace();
    await db.emailSuppression.create({ data: { workspaceId, email: "un@exemple.test", reason: "unsubscribe" } });
    await db.emailSuppression.create({ data: { workspaceId, email: "deux@exemple.test", reason: "prospect_opt_out" } });
    await db.emailSuppression.create({ data: { workspaceId, email: erasedEmailKey(workspaceId, "trois@exemple.test"), reason: "erasure" } });
    return workspaceId;
  }

  it("sans clé : refus explicite, rien n'est converti", async () => {
    const workspaceId = await seed();
    await expect(backfillSuppressionKeys({ workspaceId, dryRun: false })).rejects.toThrow("SUPPRESSION_HMAC_KEY absente");
    expect(await rows(workspaceId)).toHaveLength(3);
  });

  it("simulation par défaut ; ajout additif ; suppression des lignes en clair seulement après vérification ; l'adresse reste bloquée à chaque étape", async () => {
    keys(KA);
    const workspaceId = await seed();
    const blocked = async () => [await isEmailSuppressed(db, workspaceId, "un@exemple.test"), await isEmailSuppressed(db, workspaceId, "deux@exemple.test"), await isEmailSuppressed(db, workspaceId, "trois@exemple.test")];
    expect(await backfillSuppressionKeys({ workspaceId })).toMatchObject({ dryRun: true, scanned: 2, created: 0, legacyHashedNotConvertible: 1 });
    expect(await rows(workspaceId)).toHaveLength(3);
    expect(await backfillSuppressionKeys({ workspaceId, dryRun: false })).toMatchObject({ created: 2, deletedPlain: 0 });
    expect(await rows(workspaceId)).toHaveLength(5); // additif : les lignes en clair sont toujours là (retour arrière possible)
    expect(await blocked()).toEqual([true, true, true]);
    expect(await backfillSuppressionKeys({ workspaceId, dryRun: false })).toMatchObject({ created: 0, alreadyKeyed: 2 }); // idempotent
    expect(await backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true })).toMatchObject({ deletedPlain: 2 });
    const r = await rows(workspaceId);
    expect(r).toHaveLength(3);
    expect(r.filter((x) => !x.email.startsWith("h1:") && !x.email.startsWith("erased:"))).toHaveLength(0);
    expect(r.map((x) => x.reason).sort()).toEqual(["erasure", "prospect_opt_out", "unsubscribe"]); // motifs conservés
    expect(await blocked()).toEqual([true, true, true]); // toujours bloquées, sans adresse en clair
  });

  it("limité à l'espace demandé", async () => {
    keys(KA);
    const a = await seed(), b = await seed();
    await backfillSuppressionKeys({ workspaceId: a, dryRun: false, deletePlain: true });
    expect((await rows(b)).filter((x) => x.email.endsWith("@exemple.test"))).toHaveLength(2);
  });
});
