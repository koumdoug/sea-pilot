import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Atomicité du changement de statut d'un prospect et transitions AUTOMATIQUES conditionnées au statut attendu.
// Exécuté sous SQLite (suite par défaut) ET sous PostgreSQL jetable (vitest.pg.config.mts) ; les courses réelles n'ont de portée que sous PostgreSQL.
const state: { ws: string } = { ws: "" };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
// Contexte simulé avec le VRAI contrôle de permission (assertCan) pour le rôle courant.
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan("owner", opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: null, ent: { active: true }, can: (a: import("@/lib/permissions").Action) => can("owner", a) } as never;
    },
  };
});

import { db, isPostgres } from "@/lib/db";
import { changeLeadStatus, createLead, qualifyLeadService } from "@/lib/leads";
import { setRetryTimingForTests } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

const isPg = isPostgres;
if (isPg) {
  const host = new URL(process.env.DATABASE_URL as string).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error(`Test PostgreSQL interrompu : l'hôte « ${host} » n'est ni 127.0.0.1 ni localhost.`);
}

beforeEach(async () => { await resetDb(); setRetryTimingForTests({ sleep: async () => {}, jitter: () => 0 }); });
afterEach(async () => { vi.restoreAllMocks(); await dropFailure(); setRetryTimingForTests(null); });

const FAIL = "sea_test_lead_status_fail";
/** Fait échouer l'INSERT d'une ligne précise au niveau de la base (même client transactionnel que le code testé). */
async function failOnInsert(table: "AnalyticsEvent" | "Customer" | "LeadActivity", when: string) {
  await dropFailure();
  if (isPg) {
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${FAIL}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'echec injecte'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${FAIL} BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (${when.replace(/\bNEW\b/g, "NEW")}) EXECUTE FUNCTION ${FAIL}()`);
  } else {
    await db.$executeRawUnsafe(`CREATE TRIGGER ${FAIL} BEFORE INSERT ON "${table}" WHEN ${when} BEGIN SELECT RAISE(ABORT, 'echec injecte'); END`);
  }
  failTable = table;
}
let failTable: string | null = null;
async function dropFailure() {
  if (!failTable) return;
  if (isPg) { await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL} ON "${failTable}"`); await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FAIL}()`); }
  else await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL}`);
  failTable = null;
}

/**
 * Simule une LECTURE PÉRIMÉE (le prospect a progressé en base après la lecture du statut par la transaction) : pour les `times` premières transactions,
 * la lecture du prospect renvoie le statut `stale` alors que la base contient un autre statut. L'écriture conditionnelle doit alors échouer (conflit).
 * Déterministe, valable sous SQLite (une connexion) comme sous PostgreSQL. Compte les transactions ouvertes.
 */
function interceptStaleRead(times: number, stale: string) {
  const real = db.$transaction.bind(db) as unknown as (fn: (tx: any) => Promise<unknown>, o?: unknown) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = { transactions: 0 };
  vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: any) => Promise<unknown>, o?: unknown) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const n = ++c.transactions;
    return real((tx) => {
      if (n > times) return fn(tx);
      const lead = new Proxy(tx.lead, {
        get(t, k) {
          if (k === "findFirst") return async (a: unknown) => { const r = await t.findFirst(a); return r ? { ...r, status: stale } : r; };
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      return fn(new Proxy(tx, { get: (t, k) => (k === "lead" ? lead : Reflect.get(t, k)) }));
    }, o);
  }) as never);
  return c;
}

async function newLead(status: string = "new") {
  const { workspaceId, userId } = await makeWorkspace();
  const { lead } = await createLead({ workspaceId, name: "Prospect", email: `p${Math.random().toString(36).slice(2)}@exemple.test`, message: "Besoin urgent d'un devis" });
  if (lead.status !== status) await db.lead.update({ where: { id: lead.id }, data: { status } });
  await db.leadActivity.deleteMany({ where: { leadId: lead.id, type: "status_changed" } }); // repart d'un historique de statut vide
  return { workspaceId, userId, leadId: lead.id };
}
const statusActs = (leadId: string) => db.leadActivity.findMany({ where: { leadId, type: "status_changed" }, orderBy: { createdAt: "asc" } });
const hotConfig = (workspaceId: string) => db.qualificationConfig.upsert({ where: { workspaceId }, create: { workspaceId, criteria: [], hotThreshold: 0, warmThreshold: 0, autoQualify: true }, update: { hotThreshold: 0, warmThreshold: 0, autoQualify: true } });

describe("changement manuel : atomicité", () => {
  it("vers « won » : prospect, historique, client et événement écrits ensemble", async () => {
    const { workspaceId, leadId } = await newLead("contacted");
    const l = await changeLeadStatus({ workspaceId, leadId, status: "won", value: 500 });
    expect(l.status).toBe("won");
    expect(l.customerId).not.toBeNull();
    expect(await statusActs(leadId)).toHaveLength(1);
    expect(await db.customer.count({ where: { workspaceId } })).toBe(1);
    expect(await db.analyticsEvent.count({ where: { leadId, type: "customer_won" } })).toBe(1);
  });

  for (const [table, when, label] of [
    ["AnalyticsEvent", "NEW.\"type\" = 'customer_won'", "dernière écriture (événement customer_won)"],
    ["Customer", "1 = 1", "création du client"],
    ["LeadActivity", "NEW.\"type\" = 'status_changed'", "historique du statut"],
  ] as const) {
    it(`échec à la ${label} : aucun état partiel, puis la même demande aboutit complètement`, async () => {
      const { workspaceId, leadId } = await newLead("contacted");
      await failOnInsert(table, when);
      await expect(changeLeadStatus({ workspaceId, leadId, status: "won", value: 500 })).rejects.toThrow();
      const after = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
      expect([after.status, after.wonAt, after.customerId, after.value]).toEqual(["contacted", null, null, null]);
      expect(await statusActs(leadId)).toHaveLength(0);
      expect(await db.customer.count({ where: { workspaceId } })).toBe(0);
      expect(await db.analyticsEvent.count({ where: { leadId, type: "customer_won" } })).toBe(0);
      expect(await db.auditLog.count({ where: { workspaceId, action: "lead.status_changed" } })).toBe(0);
      await dropFailure();
      const ok = await changeLeadStatus({ workspaceId, leadId, status: "won", value: 500 });
      expect([ok.status, ok.customerId !== null]).toEqual(["won", true]);
      expect(await db.customer.count({ where: { workspaceId } })).toBe(1);
      expect(await statusActs(leadId)).toHaveLength(1);
    });
  }

  it("deux changements manuels concurrents, 20 fois : l'historique s'enchaîne (chaque « from » est le statut réellement remplacé)", async () => {
    for (let i = 0; i < 20; i++) {
      const { workspaceId, userId, leadId } = await newLead("new");
      await Promise.all([
        changeLeadStatus({ workspaceId, leadId, status: "contacted", actorId: userId }),
        changeLeadStatus({ workspaceId, leadId, status: "qualified", actorId: userId }),
      ]);
      const acts = (await statusActs(leadId)).map((a) => a.data as { from: string; to: string });
      expect(acts, `itération ${i}`).toHaveLength(2);
      const first = acts.find((a) => a.from === "new")!;
      const second = acts.find((a) => a !== first)!;
      expect(second.from, `itération ${i}`).toBe(first.to);
      expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe(second.to);
    }
  }, 120_000);

  it("statut invalide et prospect d'un autre espace : refus, rien d'écrit", async () => {
    const a = await newLead("new");
    const b = await makeWorkspace("Autre");
    await expect(changeLeadStatus({ workspaceId: a.workspaceId, leadId: a.leadId, status: "n-importe-quoi" })).rejects.toThrow();
    await expect(changeLeadStatus({ workspaceId: b.workspaceId, leadId: a.leadId, status: "won" })).rejects.toThrow();
    await expect(changeLeadStatus({ workspaceId: b.workspaceId, leadId: a.leadId, status: "won", expectedFrom: "new" })).rejects.toThrow();
    expect((await db.lead.findUniqueOrThrow({ where: { id: a.leadId } })).status).toBe("new");
    expect(await statusActs(a.leadId)).toHaveLength(0);
  });
});

describe("transition automatique : conditionnée au statut attendu", () => {
  it("statut toujours « new » : appliquée une fois (historique, date de qualification, audit)", async () => {
    const { workspaceId, leadId } = await newLead("new");
    const l = await changeLeadStatus({ workspaceId, leadId, status: "qualified", expectedFrom: "new" });
    expect([l.status, l.qualifiedAt !== null]).toEqual(["qualified", true]);
    expect((await statusActs(leadId)).map((a) => a.data)).toEqual([{ from: "new", to: "qualified" }]);
    expect(await db.auditLog.count({ where: { workspaceId, action: "lead.status_changed" } })).toBe(1);
  });

  for (const advanced of ["contacted", "proposal", "won", "lost"]) {
    it(`prospect déjà « ${advanced} » : refusée, ni statut ni historique ni dates modifiés`, async () => {
      const { workspaceId, leadId } = await newLead(advanced);
      const wonAt = advanced === "won" ? new Date("2026-01-02T03:04:05Z") : null;
      if (wonAt) await db.lead.update({ where: { id: leadId }, data: { wonAt } });
      const before = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
      const l = await changeLeadStatus({ workspaceId, leadId, status: "qualified", expectedFrom: "new" });
      expect(l.status).toBe(advanced);
      const after = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
      expect([after.status, after.wonAt, after.qualifiedAt, after.lostAt]).toEqual([before.status, before.wonAt, before.qualifiedAt, before.lostAt]);
      expect(await statusActs(leadId)).toHaveLength(0);
      expect(await db.auditLog.count({ where: { workspaceId, action: "lead.status_changed" } })).toBe(0);
    });
  }

  it("conflit à l'écriture (lecture périmée : le prospect a déjà progressé) : une seule transaction, aucune reprise, prospect laissé tel quel", async () => {
    const { workspaceId, leadId } = await newLead("proposal");
    const c = interceptStaleRead(1, "new");
    const l = await changeLeadStatus({ workspaceId, leadId, status: "qualified", expectedFrom: "new" });
    expect(l.status).toBe("proposal");
    expect(c.transactions).toBe(1); // aucune reprise
    expect(await statusActs(leadId)).toHaveLength(0);
    expect(await db.auditLog.count({ where: { workspaceId, action: "lead.status_changed" } })).toBe(0);
  });

  it("chemin manuel dans la même situation : la décision de l'utilisateur est réappliquée sur l'état réel (reprises contrôlées conservées)", async () => {
    const { workspaceId, userId, leadId } = await newLead("proposal");
    const c = interceptStaleRead(1, "new");
    const l = await changeLeadStatus({ workspaceId, leadId, status: "qualified", actorId: userId });
    expect(l.status).toBe("qualified");
    expect(c.transactions).toBe(2);
    expect((await statusActs(leadId)).map((a) => a.data)).toEqual([{ from: "proposal", to: "qualified" }]);
  });

  it("chemin manuel : conflit à chaque essai : 3 essais au plus, erreur explicite, aucune écriture partielle", async () => {
    const { workspaceId, userId, leadId } = await newLead("contacted");
    const c = interceptStaleRead(99, "new");
    await expect(changeLeadStatus({ workspaceId, leadId, status: "won", value: 10, actorId: userId })).rejects.toThrow(/modifié en continu/);
    expect(c.transactions).toBe(3);
    expect(await db.customer.count({ where: { workspaceId } })).toBe(0);
    expect(await statusActs(leadId)).toHaveLength(0);
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("contacted");
  });

  it("qualification automatique d'un prospect « new » chaud : passe à « qualified »", async () => {
    const { workspaceId, leadId } = await newLead("new");
    await hotConfig(workspaceId);
    await qualifyLeadService({ workspaceId, leadId, userId: null, allowAi: false });
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("qualified");
    expect((await statusActs(leadId)).map((a) => a.data)).toEqual([{ from: "new", to: "qualified" }]);
  });

  it("qualification automatique : le prospect progresse PENDANT la qualification (lecture périmée) : statut conservé, aucune activité de statut", async () => {
    const { workspaceId, userId, leadId } = await newLead("new");
    await hotConfig(workspaceId);
    // Après la lecture initiale du prospect et avant la transition : un utilisateur le fait passer à « proposal ».
    const realCreate = db.analyticsEvent.create.bind(db.analyticsEvent) as (a: unknown) => Promise<unknown>;
    vi.spyOn(db.analyticsEvent, "create").mockImplementation(((a: unknown) => {
      return (async () => {
        await db.lead.update({ where: { id: leadId }, data: { status: "proposal" } });
        return realCreate(a);
      })();
    }) as never);
    const r = await qualifyLeadService({ workspaceId, leadId, userId, allowAi: false });
    vi.restoreAllMocks();
    expect(r.qualification.level).toBe("hot");
    const after = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(after.status).toBe("proposal");
    expect(await statusActs(leadId)).toHaveLength(0);
    expect(after.score).toBe(r.qualification.score); // le score et le niveau sont, eux, bien enregistrés
  });

  it("automatique contre manuel, 30 fois en même temps : le choix manuel l'emporte toujours, historique cohérent", async () => {
    for (let i = 0; i < 30; i++) {
      const { workspaceId, userId, leadId } = await newLead("new");
      await Promise.all([
        changeLeadStatus({ workspaceId, leadId, status: "qualified", expectedFrom: "new" }),
        changeLeadStatus({ workspaceId, leadId, status: "contacted", actorId: userId }),
      ]);
      const acts = (await statusActs(leadId)).map((a) => a.data as { from: string; to: string });
      expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status, `itération ${i}`).toBe("contacted");
      expect(acts.length, `itération ${i}`).toBeGreaterThanOrEqual(1);
      expect(acts.length, `itération ${i}`).toBeLessThanOrEqual(2);
      expect(acts[acts.length - 1].to, `itération ${i}`).toBe("contacted");
      if (acts.length === 2) expect(acts, `itération ${i}`).toEqual([{ from: "new", to: "qualified" }, { from: "qualified", to: "contacted" }]);
    }
  }, 120_000);
});

describe("message sortant (addConversationAction)", () => {
  const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  const send = async (leadId: string, extra: Record<string, string> = {}) =>
    (await import("@/app/(app)/leads/actions")).addConversationAction({}, fd({ id: leadId, channel: "email", direction: "outbound", body: "Bonjour", ...extra }));

  it("premier contact sortant d'un prospect « new » : passe à « contacted »", async () => {
    const { workspaceId, leadId } = await newLead("new");
    state.ws = workspaceId;
    expect(await send(leadId)).toMatchObject({ ok: true });
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("contacted");
    expect(await db.conversation.count({ where: { leadId } })).toBe(1);
    expect((await statusActs(leadId)).map((a) => a.data)).toEqual([{ from: "new", to: "contacted" }]);
  });

  it("prospect devenu « proposal » entre la lecture et la transition : message enregistré, statut conservé", async () => {
    const { workspaceId, leadId } = await newLead("new");
    state.ws = workspaceId;
    const realCreate = db.leadActivity.create.bind(db.leadActivity) as (a: unknown) => Promise<unknown>;
    vi.spyOn(db.leadActivity, "create").mockImplementation(((a: { data: { type?: string } }) => {
      return (async () => {
        if (a?.data?.type === "note") await db.lead.update({ where: { id: leadId }, data: { status: "proposal" } });
        return realCreate(a);
      })();
    }) as never);
    expect(await send(leadId)).toMatchObject({ ok: true });
    vi.restoreAllMocks();
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("proposal");
    expect(await db.conversation.count({ where: { leadId } })).toBe(1);
    expect(await statusActs(leadId)).toHaveLength(0);
  });

  it("note, message entrant ou prospect déjà avancé : aucun changement de statut", async () => {
    const { workspaceId, leadId } = await newLead("new");
    state.ws = workspaceId;
    await send(leadId, { channel: "note" });
    await send(leadId, { direction: "inbound" });
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("new");
    await db.lead.update({ where: { id: leadId }, data: { status: "qualified" } });
    await send(leadId);
    expect((await db.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("qualified");
    expect(await statusActs(leadId)).toHaveLength(0);
  });
});
