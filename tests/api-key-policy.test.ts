// Politique 3 des clés API : elles appartiennent à l'ESPACE. Retirer un membre ne les révoque pas (aucune intégration interrompue) ;
// elles sont détectées, journalisées au retrait, signalées aux gestionnaires, et la révocation manuelle reste possible.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const { entitlementForWorkspace } = await import("@/lib/free-access");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws }, include: { subscription: true } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws, role: "owner" }, include: { user: true } });
      if (opts.action) assertCan("owner", opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: ws.subscription, ent: await entitlementForWorkspace(ws.id, ws.subscription), can: (a: import("@/lib/permissions").Action) => can("owner", a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { activeKeysCreatedBy, activeKeysOfRemovedMembers } from "@/lib/api-key-creators";
import { POST as apiLeads } from "@/app/api/v1/leads/route";
import { removeMemberAction, revokeApiKeyAction } from "../src/app/(app)/settings/actions";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
let n = 0;
async function setup() {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "pro", status: "active", stripeSubscriptionId: `sub_${w.workspaceId}`, stripeCustomerId: `cus_${w.workspaceId}`, currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) } });
  state.ws = w.workspaceId;
  const admin = await db.user.create({ data: { email: `admin${++n}-${Date.now()}@test.local`, name: "Ancien admin", passwordHash: "x" } });
  await db.membership.create({ data: { userId: admin.id, workspaceId: w.workspaceId, role: "admin" } });
  const key = async (createdById: string | null, extra: Record<string, unknown> = {}) => {
    const secret = `sp_policy_${++n}_` + "x".repeat(24);
    const row = await db.apiKey.create({ data: { workspaceId: w.workspaceId, name: `Clé ${n}`, prefix: secret.slice(0, 10), keyHash: sha256(secret), createdById, ...extra } });
    return { secret, row };
  };
  return { ...w, admin, key };
}
const lead = (secret: string) => apiLeads(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ name: "Prospect", email: `p${++n}@client.test` }) }));

describe("politique 3 — retrait d'un membre", () => {
  it("les clés du membre retiré restent actives et continuent de fonctionner (aucune intégration interrompue)", async () => {
    const s = await setup();
    const k = await s.key(s.admin.id);
    const r = await removeMemberAction({}, fd({ userId: s.admin.id }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/1 clé\(s\) API créée\(s\) par ce membre restent actives/);
    expect(await db.membership.count({ where: { userId: s.admin.id, workspaceId: s.workspaceId } })).toBe(0);
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: k.row.id } })).revokedAt).toBeNull();
    expect((await lead(k.secret)).status).toBe(201);
  });

  it("le journal d'audit consigne le retrait ET les clés conservées (identifiants seulement : ni secret ni préfixe)", async () => {
    const s = await setup();
    const k = await s.key(s.admin.id); const k2 = await s.key(s.admin.id);
    await removeMemberAction({}, fd({ userId: s.admin.id }));
    const removed = await db.auditLog.findFirstOrThrow({ where: { workspaceId: s.workspaceId, action: "member.removed" } });
    expect(removed.meta).toMatchObject({ apiKeysKept: 2 });
    const info = await db.auditLog.findFirstOrThrow({ where: { workspaceId: s.workspaceId, action: "apikey.creator_removed" } });
    expect(info.entityId).toBe(s.admin.id);
    expect(info.meta).toEqual({ count: 2, keyIds: [k.row.id, k2.row.id] }); // identifiants seulement
    const dump = JSON.stringify(info.meta) + JSON.stringify(removed.meta);
    for (const key of [k, k2]) { expect(dump).not.toContain(key.secret); expect(dump).not.toContain(key.row.prefix); expect(dump).not.toContain(key.secret.slice(0, 4)); }
    expect(JSON.stringify(info)).not.toContain(k.row.prefix); // ni dans l'enregistrement complet du journal
  });

  it("membre sans clé : aucune entrée « clé conservée » ni message d'alerte", async () => {
    const s = await setup();
    const r = await removeMemberAction({}, fd({ userId: s.admin.id }));
    expect(r).toEqual({ ok: true });
    expect(await db.auditLog.count({ where: { workspaceId: s.workspaceId, action: "apikey.creator_removed" } })).toBe(0);
    expect((await db.auditLog.findFirstOrThrow({ where: { workspaceId: s.workspaceId, action: "member.removed" } })).meta).toMatchObject({ apiKeysKept: 0 });
  });

  it("les clés d'un autre membre ou du propriétaire ne sont pas concernées par le retrait", async () => {
    const s = await setup();
    const mine = await s.key(s.userId);
    await s.key(s.admin.id);
    await removeMemberAction({}, fd({ userId: s.admin.id }));
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: mine.row.id } })).revokedAt).toBeNull();
    expect((await activeKeysOfRemovedMembers(s.workspaceId)).map((x) => x.id)).not.toContain(mine.row.id);
  });
});

describe("politique 3 — détection et révocation manuelle", () => {
  it("détecte les clés actives dont le créateur n'est plus membre ; ignore révoquées, clés de membres actuels et clés sans créateur", async () => {
    const s = await setup();
    const orphan = await s.key(s.admin.id);
    await s.key(s.userId);
    await s.key(null);
    await s.key(s.admin.id, { revokedAt: new Date() });
    expect(await activeKeysOfRemovedMembers(s.workspaceId)).toEqual([]); // l'admin est encore membre
    await db.membership.deleteMany({ where: { userId: s.admin.id, workspaceId: s.workspaceId } });
    const found = await activeKeysOfRemovedMembers(s.workspaceId);
    expect(found.map((x) => x.id)).toEqual([orphan.row.id]);
    expect(found[0]).not.toHaveProperty("keyHash");
  });

  it("compte supprimé : ses clés sont détectées de la même façon", async () => {
    const s = await setup();
    const k = await s.key(s.admin.id);
    await db.user.delete({ where: { id: s.admin.id } }); // supprime aussi l'appartenance (cascade)
    expect((await activeKeysOfRemovedMembers(s.workspaceId)).map((x) => x.id)).toEqual([k.row.id]);
  });

  it("isolation : les clés d'un autre espace ne sont jamais listées", async () => {
    const a = await setup();
    const k = await a.key(a.admin.id);
    await db.membership.deleteMany({ where: { userId: a.admin.id, workspaceId: a.workspaceId } });
    const b = await makeWorkspace();
    expect(await activeKeysOfRemovedMembers(b.workspaceId)).toEqual([]);
    expect((await activeKeysOfRemovedMembers(a.workspaceId)).map((x) => x.id)).toEqual([k.row.id]);
    expect(await activeKeysCreatedBy(b.workspaceId, a.admin.id)).toEqual([]);
  });

  it("la révocation manuelle existante fonctionne : la clé est refusée puis disparaît de la détection", async () => {
    const s = await setup();
    const k = await s.key(s.admin.id);
    await removeMemberAction({}, fd({ userId: s.admin.id }));
    expect((await lead(k.secret)).status).toBe(201);
    expect((await revokeApiKeyAction({}, fd({ id: k.row.id }))).ok).toBe(true);
    expect((await lead(k.secret)).status).toBe(401);
    expect(await activeKeysOfRemovedMembers(s.workspaceId)).toEqual([]);
  });
});
