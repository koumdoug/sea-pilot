import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { createLead, eraseLead, unsubscribeLead } from "@/lib/leads";
import { EmailError, prepareFollowUpEmail, setEmailProviderForTests } from "@/lib/email";
import { processDueFollowUps } from "@/lib/followups";
import { addProspect, checkEligibility, ensureDefaultProducts, PortfolioError } from "@/lib/portfolio/service";
import {
  UNKNOWN_KEY_REASON, backfillSuppressionKeys, erasedEmailKey, isEmailSuppressed, keyedEmailKey, resetSuppressionWarningsForTests, suppressionKeyring, suppressionStatus, suppressionWriteKey,
} from "@/lib/suppression";
import { FakeProvider, emailFixture, noRetryDelay, resetEngineTestState } from "./followup-helpers";
import { makeWorkspace, resetDb } from "./helpers";

const KA = "cle-dediee-A-".padEnd(48, "a");
const KB = "cle-dediee-B-".padEnd(48, "b");
const KC = "cle-dediee-C-".padEnd(48, "c");
const VARS = ["SUPPRESSION_HMAC_KEY", "SUPPRESSION_HMAC_KEY_PREVIOUS", "ENCRYPTION_KEY", "LOG_LEVEL"] as const;
const saved: Record<string, string | undefined> = {};
function keys(cur?: string, prev?: string) {
  if (cur === undefined) delete process.env.SUPPRESSION_HMAC_KEY; else process.env.SUPPRESSION_HMAC_KEY = cur;
  if (prev === undefined) delete process.env.SUPPRESSION_HMAC_KEY_PREVIOUS; else process.env.SUPPRESSION_HMAC_KEY_PREVIOUS = prev;
}
beforeEach(async () => { for (const v of VARS) saved[v] = process.env[v]; keys(); delete process.env.ENCRYPTION_KEY; await resetDb(); noRetryDelay(); });
afterEach(() => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } resetEngineTestState(); });

const Q = "q.supprime@exemple.test"; // adresse inscrite dans la liste (sous la clé A), prospect NON désinscrit
const Y = "y.libre@exemple.test"; // adresse jamais inscrite
const rows = (workspaceId: string) => db.emailSuppression.findMany({ where: { workspaceId } });

/** Configuration dégradée ou saine, appliquée APRÈS l'inscription de Q sous la clé A. */
type Scenario = { name: string; cur?: string; prev?: string; enc?: string; degraded: boolean };
const SCENARIOS: Scenario[] = [
  { name: "clé A seule (témoin)", cur: KA, degraded: false },
  { name: "clé A saisie entre guillemets (erreur de console d'hébergement)", cur: `"${KA}"`, degraded: false },
  { name: "SUPPRESSION_HMAC_KEY absente", degraded: true },
  { name: "clé trop courte", cur: "court", degraded: true },
  { name: "clé identique à SESSION_SECRET", cur: "SESSION", degraded: true },
  { name: "clé identique à ENCRYPTION_KEY", cur: KB, enc: KB, degraded: true },
  { name: "clé blanche (espaces)", cur: "     ", degraded: true },
  { name: "kid inconnu : clé B seule, clé A retirée", cur: KB, degraded: true },
  { name: "clé précédente absente", cur: KB, prev: undefined, degraded: true },
  { name: "clé précédente mal formée (trop courte)", cur: KB, prev: "court", degraded: true },
  { name: "précédente A correcte", cur: KB, prev: KA, degraded: false },
  { name: "plusieurs précédentes (C puis A)", cur: KB, prev: `${KC},${KA}`, degraded: false },
  { name: "doublons et segments vides dans la liste", cur: KB, prev: ` ${KA},${KA},, ${KB},  `, degraded: false },
];

describe("configuration de la clé : aucun envoi ne part sans contrôle de suppression fiable, Leads comme Portfolio", () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      keys(KA);
      const { workspaceId, userId } = await makeWorkspace();
      await ensureDefaultProducts(workspaceId, userId);
      const product = await db.product.findFirstOrThrow({ where: { workspaceId } });
      await db.product.update({ where: { id: product.id }, data: { status: "commercialisation" } });
      await db.outreachChannel.upsert({ where: { workspaceId_channel: { workspaceId, channel: "email" } }, create: { workspaceId, channel: "email", enabled: true }, update: { enabled: true } });
      const leadQ = await createLead({ workspaceId, name: "Q", email: Q, consentMarketing: true });
      const leadY = await createLead({ workspaceId, name: "Y", email: Y, consentMarketing: true });
      const leadN = await createLead({ workspaceId, name: "N", email: "n.nouveau@exemple.test", consentMarketing: true });
      await db.emailSuppression.create({ data: { workspaceId, email: suppressionWriteKey(workspaceId, Q, { fallback: "plain" }), reason: "unsubscribe" } }); // inscrite sous A
      const prospectQ = await addProspect(workspaceId, { name: "PQ", email: Q, source: "test", collectedAt: new Date("2026-10-01"), legalBasis: "implied_published", productId: product.id });
      const prospectY = await addProspect(workspaceId, { name: "PY", email: Y, source: "test", collectedAt: new Date("2026-10-01"), legalBasis: "implied_published", productId: product.id });
      expect(prospectQ.prospect.status).toBe("do_not_contact");
      expect(prospectY.prospect.status).toBe("identified");

      // configuration à éprouver
      if (sc.enc) process.env.ENCRYPTION_KEY = sc.enc;
      keys(sc.cur === "SESSION" ? process.env.SESSION_SECRET : sc.cur, sc.prev);
      setEmailProviderForTests(new FakeProvider());

      // Leads : envoi marketing
      const sendQ = await prepareFollowUpEmail({ workspaceId, leadId: leadQ.lead.id, subject: "S", body: "B" });
      const sendY = await prepareFollowUpEmail({ workspaceId, leadId: leadY.lead.id, subject: "S", body: "B" });
      expect(sendQ.ok).toBe(false); // une adresse inscrite n'est jamais ignorée, quelle que soit la configuration
      if (sc.degraded) {
        expect(sendQ).toEqual({ ok: false, reason: UNKNOWN_KEY_REASON }); // erreur claire, pas un faux « désinscrit »
        expect(sendY).toEqual({ ok: false, reason: UNKNOWN_KEY_REASON }); // échec fermé : le statut d'une adresse ne peut pas être vérifié
      } else {
        expect(sendQ).toEqual({ ok: false, reason: "Adresse dans la liste de suppression." });
        expect(sendY.ok).toBe(true);
      }

      // Portfolio : mêmes décisions
      const elig = async (id: string) => { const r = await checkEligibility({ workspaceId, prospectId: id, productId: product.id, channel: "email" }); return r.ok ? [] : r.reasons; };
      const reasonsY = await elig(prospectY.prospect.id);
      if (sc.degraded) { expect(reasonsY).toContain(UNKNOWN_KEY_REASON); expect(reasonsY).not.toContain("L'adresse figure dans la liste de désinscription."); }
      else { expect(reasonsY).not.toContain(UNKNOWN_KEY_REASON); expect(reasonsY).not.toContain("L'adresse figure dans la liste de désinscription."); }
      expect((await elig(prospectQ.prospect.id)).length).toBeGreaterThan(0); // l'adresse inscrite n'est jamais éligible
      const added = await addProspect(workspaceId, { name: "PN", email: "p.nouveau@exemple.test", source: "test", collectedAt: new Date("2026-10-01"), legalBasis: "implied_published", productId: product.id }).then((r) => r, (e) => e);
      if (sc.degraded) {
        expect(added).toBeInstanceOf(PortfolioError); // aucune fiche n'est créée (ni « ne pas contacter » à tort, ni « identifiée » sans contrôle)
        expect((added as Error).message).toBe(UNKNOWN_KEY_REASON);
        expect(await db.prospect.count({ where: { workspaceId, email: "p.nouveau@exemple.test" } })).toBe(0);
      } else expect(added.prospect.status).toBe("identified");

      // une nouvelle désinscription est TOUJOURS enregistrée, et immédiatement reconnue
      expect(await unsubscribeLead(workspaceId, leadN.lead.id)).toBe(true);
      expect(await suppressionStatus(db, workspaceId, "n.nouveau@exemple.test")).toBe("listed");
    });
  }

  it("sans entrée HMAC et sans clé : comportement inchangé (adresse en clair bloquée, autres adresses envoyables)", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.emailSuppression.create({ data: { workspaceId, email: Q, reason: "unsubscribe" } });
    expect(await suppressionStatus(db, workspaceId, Q)).toBe("listed");
    expect(await suppressionStatus(db, workspaceId, Y)).toBe("clear");
  });

  it("entrée « h1: » à l'identifiant illisible : échec fermé ; entrée à identifiant connu mais empreinte illisible : inerte et comptée", async () => {
    keys(KA);
    const { workspaceId } = await makeWorkspace();
    const kid = suppressionKeyring().current!.kid;
    await db.emailSuppression.create({ data: { workspaceId, email: `h1:${kid}:zzz`, reason: "unsubscribe" } });
    expect(await suppressionStatus(db, workspaceId, Y)).toBe("clear");
    expect((await backfillSuppressionKeys({ workspaceId })).malformedKeyed).toBe(1);
    await db.emailSuppression.create({ data: { workspaceId, email: "h1:xyz", reason: "unsubscribe" } });
    expect(await suppressionStatus(db, workspaceId, Y)).toBe("unknown_key");
    expect((await backfillSuppressionKeys({ workspaceId })).malformedKeyed).toBe(2);
  });
});

describe("rotation réelle de clé", () => {
  it("A → B (A en lecture) → nouvelle entrée → A retirée → A restaurée → plusieurs précédentes : aucune adresse n'est réautorisée en silence", async () => {
    const { workspaceId } = await makeWorkspace();
    const st = (e: string) => suppressionStatus(db, workspaceId, e);
    keys(KA); // 1. clé A seule
    const kidA = suppressionKeyring().current!.kid;
    const oldLead = await createLead({ workspaceId, name: "Ancien", email: "ancien@exemple.test", consentMarketing: true });
    await unsubscribeLead(workspaceId, oldLead.lead.id);
    expect(await st("ancien@exemple.test")).toBe("listed");
    keys(KB, KA); // 2. rotation : B courante, A déclarée précédente
    expect(await st("ancien@exemple.test")).toBe("listed"); // 4. ancienne entrée (créée avec A) toujours lue
    expect(await st(Y)).toBe("clear");
    const newLead = await createLead({ workspaceId, name: "Nouveau", email: "nouveau@exemple.test", consentMarketing: true });
    await unsubscribeLead(workspaceId, newLead.lead.id); // 3. nouvelle entrée avec B
    expect(await st("nouveau@exemple.test")).toBe("listed"); // immédiatement reconnue
    const kidB = suppressionKeyring().current!.kid;
    expect((await rows(workspaceId)).map((r) => r.email.split(":")[1]).sort()).toEqual([kidA, kidB].sort());
    keys(KB); // 5. A retirée
    expect(await st("ancien@exemple.test")).toBe("unknown_key"); // 6. l'ancienne adresse n'est PAS redevenue envoyable
    expect(await isEmailSuppressed(db, workspaceId, "ancien@exemple.test")).toBe(true);
    expect(await isEmailSuppressed(db, workspaceId, Y)).toBe(true); // échec fermé explicite
    keys(KB, KA); // 7. A restaurée
    expect(await st("ancien@exemple.test")).toBe("listed");
    expect(await st(Y)).toBe("clear");
    keys(KC, `${KB},${KA}`); // 8. plusieurs précédentes
    expect([await st("ancien@exemple.test"), await st("nouveau@exemple.test"), await st(Y)]).toEqual(["listed", "listed", "clear"]);
    keys(KC, `${KB},court`); // 10. précédente mal configurée (A manquante, « court » ignorée)
    expect(await st("ancien@exemple.test")).toBe("unknown_key");
    expect(suppressionKeyring().problems[0]).toContain("moins de 32");
    keys(KC, KB); // 9. identifiant (kid) inconnu : les entrées de A ne sont plus lisibles
    expect(await st("ancien@exemple.test")).toBe("unknown_key");
  });
});

describe("migration progressive : comptage avant / après, sans exposer d'adresse", () => {
  const census = async (workspaceId: string) => {
    const r = await rows(workspaceId);
    return {
      plain: r.filter((x) => !x.email.startsWith("h1:") && !x.email.startsWith("erased:")).length, erased: r.filter((x) => x.email.startsWith("erased:")).length,
      hmacValid: r.filter((x) => /^h1:[0-9a-f]{12}:[0-9a-f]{64}$/.test(x.email)).length, hmacMalformed: r.filter((x) => x.email.startsWith("h1:") && !/^h1:[0-9a-f]{12}:[0-9a-f]{64}$/.test(x.email)).length,
    };
  };
  it("entrées en clair, équivalentes après normalisation, « erased: », HMAC valide et invalide, deux espaces", async () => {
    keys(KA);
    const ring = suppressionKeyring().current!;
    const w1 = await makeWorkspace(), w2 = await makeWorkspace();
    const W1 = w1.workspaceId, W2 = w2.workspaceId;
    const add = (workspaceId: string, email: string, reason = "unsubscribe") => db.emailSuppression.create({ data: { workspaceId, email, reason } });
    await add(W1, "x.migr@exemple.test"); await add(W1, "X.MIGR@EXEMPLE.TEST"); // équivalentes après normalisation
    await add(W1, erasedEmailKey(W1, "z.migr@exemple.test"), "erasure");
    await add(W1, keyedEmailKey(W1, "v.migr@exemple.test", ring), "unsubscribe"); // HMAC valide existant
    await add(W1, `h1:${ring.kid}:zzz`); // HMAC invalide (identifiant connu, empreinte illisible)
    await add(W2, "x.migr@exemple.test"); await add(W2, "u.migr@exemple.test", "prospect_opt_out"); // deuxième espace, même adresse
    const before = { w1: await census(W1), w2: await census(W2) };
    expect(before).toEqual({ w1: { plain: 2, erased: 1, hmacValid: 1, hmacMalformed: 1 }, w2: { plain: 2, erased: 0, hmacValid: 0, hmacMalformed: 0 } });
    const w2Snapshot = JSON.stringify(await rows(W2));

    const s = await backfillSuppressionKeys({ workspaceId: W1, dryRun: false, deletePlain: true });
    expect(s).toMatchObject({ scanned: 2, created: 1, alreadyKeyed: 1, deletedPlain: 2, keptUnverified: 0, legacyHashedNotConvertible: 1, malformedKeyed: 1 });
    const after = { w1: await census(W1), w2: await census(W2) };
    expect(after).toEqual({ w1: { plain: 0, erased: 1, hmacValid: 2, hmacMalformed: 1 }, w2: { plain: 2, erased: 0, hmacValid: 0, hmacMalformed: 0 } });
    expect(JSON.stringify(await rows(W2))).toBe(w2Snapshot); // l'autre espace n'a pas bougé

    for (const e of ["x.migr@exemple.test", "X.Migr@Exemple.test", " x.migr@exemple.test ", "v.migr@exemple.test", "z.migr@exemple.test"]) expect(await isEmailSuppressed(db, W1, e), e).toBe(true); // doublons : jamais réautorisées
    expect(await isEmailSuppressed(db, W1, "u.migr@exemple.test")).toBe(false); // l'adresse de l'autre espace n'est pas dans celui-ci
    expect(JSON.stringify(await rows(W1))).not.toContain("exemple.test");
    await backfillSuppressionKeys({ workspaceId: W2, dryRun: false, deletePlain: true });
    expect(await census(W2)).toEqual({ plain: 0, erased: 0, hmacValid: 2, hmacMalformed: 0 });
    expect(await census(W1)).toEqual(after.w1);
  });
});

describe("journaux et erreurs : aucune donnée personnelle ni clé", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0; resetSuppressionWarningsForTests();
    process.env.LOG_LEVEL = "debug"; // le journal n'écrit pas pendant les tests sinon : on observe la sortie RÉELLE (avec masquage)
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); });
  });
  const FORBIDDEN = () => ["m@y.com", "Marie", "Durand", KA, KB, process.env.SESSION_SECRET!];
  const expectClean = (extra: string[] = []) => { const all = lines.join("\n"); for (const s of [...FORBIDDEN(), ...extra]) expect(all, s).not.toContain(s); expect(all).not.toMatch(/h1:[0-9a-f]{12}:[0-9a-f]{64}/); expect(all).not.toMatch(/erased:[0-9a-f]{64}/); };

  it("le masquage s'applique aussi aux VALEURS : une adresse ou une empreinte dans un texte d'erreur ne sort jamais", () => {
    log.error("followup.failed", { id: "fu_1", error: `échec pour m@y.com (h1:abcdef012345:${"a".repeat(64)}) et erased:${"b".repeat(64)}`, code: "P2002" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("m@y.com");
    expect(lines[0]).not.toMatch(/h1:[0-9a-f]{12}:[0-9a-f]{64}/);
    expect(lines[0]).not.toMatch(/erased:[0-9a-f]{64}/);
    expect(lines[0]).toContain("fu_1"); // le diagnostic technique reste lisible
    expect(lines[0]).toContain("P2002");
  });

  it("désinscription, effacement, backfill, rotation, clé inconnue, clé absente : aucun journal ne contient clé, adresse, nom ou empreinte", async () => {
    keys(KA);
    const f = await emailFixture();
    await unsubscribeLead(f.workspaceId, f.lead.id);
    const g = await emailFixture({ email: "m@y.com" }); // même adresse dans un autre espace
    await eraseLead(g.workspaceId, g.lead.id, g.userId);
    await db.emailSuppression.create({ data: { workspaceId: f.workspaceId, email: "m@y.com", reason: "unsubscribe" } });
    await backfillSuppressionKeys({ workspaceId: f.workspaceId, dryRun: false, deletePlain: true });
    keys(KB, KA); await suppressionStatus(db, f.workspaceId, "m@y.com");
    keys(KB); await suppressionStatus(db, f.workspaceId, "m@y.com"); // clé inconnue
    keys(); suppressionWriteKey(f.workspaceId, "m@y.com", { fallback: "plain" }); // clé absente
    await expect(backfillSuppressionKeys({ workspaceId: f.workspaceId })).rejects.toThrow("SUPPRESSION_HMAC_KEY absente");
    expect(lines.some((l) => l.includes("suppression.backfill"))).toBe(true);
    expect(lines.some((l) => l.includes("suppression.unknown_key"))).toBe(true);
    expect(lines.some((l) => l.includes("suppression.key_missing"))).toBe(true);
    expectClean();
    const audit = JSON.stringify(await db.auditLog.findMany({}));
    for (const s of ["m@y.com", "Marie", "Durand", KA]) expect(audit).not.toContain(s);
  });

  for (const c of [
    { name: "envoi accepté", behavior: async () => ({ id: "msg_ok", httpStatus: 200 }) },
    { name: "envoi refusé (texte du fournisseur citant l'adresse)", behavior: async () => { throw new EmailError("refus : m@y.com de Marie Durand invalide", { kind: "rejected", status: 422 }); } },
    { name: "résultat incertain (exception citant l'adresse)", behavior: async () => { throw new Error("réseau : connexion à m@y.com / Marie Durand perdue"); } },
  ]) {
    it(`${c.name} : journaux, journal d'e-mails, relances, tâches et audit sans donnée personnelle (hors l'adresse du journal d'e-mails avant effacement)`, async () => {
      keys(KA);
      const f = await emailFixture();
      setEmailProviderForTests(new FakeProvider(c.behavior));
      await processDueFollowUps({ workspaceId: f.workspaceId });
      expectClean();
      const stored = JSON.stringify({ fus: await db.followUp.findMany({ where: { leadId: f.lead.id } }), audit: await db.auditLog.findMany({ where: { workspaceId: f.workspaceId } }), notifs: await db.notification.findMany({ where: { workspaceId: f.workspaceId, href: "/automations" } }), logsErr: (await db.emailLog.findMany({ where: { workspaceId: f.workspaceId } })).map((l) => l.error) });
      for (const s of ["m@y.com", "Marie Durand", "invalide", "connexion"]) expect(stored, s).not.toContain(s);
    });
  }

  it("messages d'erreur exposés : motif de clé inconnue et refus de backfill sans valeur de clé", async () => {
    keys(KA);
    await expect((async () => { keys("court"); await backfillSuppressionKeys(); })()).rejects.toThrow(/moins de 32/);
    for (const msg of [UNKNOWN_KEY_REASON]) for (const s of [KA, KB, process.env.SESSION_SECRET!]) expect(msg).not.toContain(s);
    keys(KA);
    try { keys("court"); await backfillSuppressionKeys(); } catch (e) { expect(String((e as Error).message)).not.toContain("court-"); }
  });
});
