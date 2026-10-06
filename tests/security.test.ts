import { beforeEach, describe, expect, it } from "vitest";
import { decryptJson, encryptJson, hashIp, safeEqual, sha256, signToken, verifyToken } from "@/lib/crypto";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";
import { safeUrl, sectionsSchema, defaultSections, formFieldsSchema, isRenderable } from "@/lib/landing";
import { slugify } from "@/lib/workspaces";
import { db } from "@/lib/db";
import { exportUser, exportWorkspace } from "@/lib/data-export";
import { saveConnection } from "@/lib/integrations/service";
import { createLead } from "@/lib/leads";
import { GET as cron } from "@/app/api/cron/followups/route";
import { GET as health } from "@/app/api/health/route";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(() => { resetRateLimits(); });

describe("cryptographie", () => {
  it("AES-GCM : aller-retour, jetons uniques, altération détectée", () => {
    const enc = encryptJson({ a: 1 });
    expect(enc).not.toContain('"a"');
    expect(decryptJson(enc)).toEqual({ a: 1 });
    expect(encryptJson({ a: 1 })).not.toBe(enc); // IV aléatoire
    const parts = enc.split(".");
    expect(() => decryptJson([parts[0], parts[1], parts[2], Buffer.from("zzzz").toString("base64url")].join("."))).toThrow();
    expect(() => decryptJson("n.importe.quoi.x")).toThrow();
  });
  it("jetons signés : falsification refusée", () => {
    const t = signToken("u|ws|lead");
    expect(verifyToken(t)).toBe("u|ws|lead");
    expect(verifyToken(signToken("autre") + "x")).toBeNull();
    const [p, s] = t.split(".");
    expect(verifyToken(`${Buffer.from("u|ws|AUTRE").toString("base64url")}.${s}`)).toBeNull();
    expect(p.length).toBeGreaterThan(0);
  });
  it("comparaisons à temps constant et empreintes", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(sha256("x")).toHaveLength(64);
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toContain("1.2.3.4");
    expect(hashIp(null)).toBeNull();
  });
});

describe("limitation de débit", () => {
  it("fenêtre glissante par clé", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 1000, t + i).ok).toBe(true);
    const blocked = rateLimit("k", 3, 1000, t + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(rateLimit("autre", 3, 1000, t + 10).ok).toBe(true); // clés indépendantes
    expect(rateLimit("k", 3, 1000, t + 1500).ok).toBe(true); // la fenêtre a glissé
  });
});

describe("protection XSS / contenu des landing pages", () => {
  it("refuse les URL javascript:, data: et vbscript:", () => {
    for (const u of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>", "vbscript:x", "ftp://x"]) expect(safeUrl.safeParse(u).success).toBe(false);
    for (const u of ["https://ok.com", "http://ok.com/p?x=1", "/chemin", "#ancre", ""]) expect(safeUrl.safeParse(u).success).toBe(true);
  });
  it("les sections valident leur structure (type inconnu refusé, limites respectées)", () => {
    expect(sectionsSchema.safeParse(defaultSections({ name: "X" })).success).toBe(true);
    expect(sectionsSchema.safeParse([{ type: "script", id: "a", src: "x" }]).success).toBe(false);
    expect(sectionsSchema.safeParse([{ type: "hero", id: "a", headline: "x".repeat(500), subheadline: "", ctaLabel: "" }]).success).toBe(false);
    expect(sectionsSchema.safeParse([{ type: "footer", id: "a", text: "", links: [{ label: "l", url: "javascript:alert(1)" }] }]).success).toBe(false);
  });
  it("du HTML dans le texte reste du texte (échappé par React au rendu)", () => {
    const r = sectionsSchema.parse([{ type: "hero", id: "h", headline: "<img src=x onerror=alert(1)>", subheadline: "", ctaLabel: "Go" }]);
    expect(r[0].type === "hero" && r[0].headline).toBe("<img src=x onerror=alert(1)>"); // aucune interprétation côté serveur
  });
  it("sections vides masquées ; formulaire exige e-mail ou téléphone", () => {
    expect(isRenderable({ type: "faq", id: "f", title: "FAQ", items: [] })).toBe(false);
    expect(isRenderable({ type: "hero", id: "h", headline: "x", subheadline: "", ctaLabel: "" })).toBe(true);
    expect(formFieldsSchema.safeParse([{ key: "name", label: "N", type: "text", required: true }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ key: "Bad Key!", label: "N", type: "text", required: true }]).success).toBe(false);
  });
  it("slugify : accents, ponctuation, longueur", () => {
    expect(slugify("Rénovation & Salle-de-bain  !!")).toBe("renovation-salle-de-bain");
    expect(slugify("***")).toBe("page");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(48);
  });
});

describe("routes protégées", () => {
  it("cron : 503 sans secret, 401 sans/avec mauvais secret, 200 avec le bon", async () => {
    delete process.env.CRON_SECRET;
    expect((await cron(new Request("http://x/api/cron/followups"))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret-value-for-tests";
    expect((await cron(new Request("http://x/api/cron/followups"))).status).toBe(401);
    expect((await cron(new Request("http://x/api/cron/followups", { headers: { authorization: "Bearer mauvais" } }))).status).toBe(401);
    const ok = await cron(new Request("http://x/api/cron/followups?sync=0", { headers: { authorization: "Bearer s3cret-value-for-tests" } }));
    expect(ok.status).toBe(200);
    delete process.env.CRON_SECRET;
  });
  it("health : base joignable", async () => {
    const r = await health();
    expect(r.status).toBe(200);
    expect((await r.json()).db).toBe("up");
  });
});

describe("export RGPD", () => {
  beforeEach(resetDb);
  it("l'export de l'espace contient les données de CET espace seulement, et jamais de secrets", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    await createLead({ workspaceId: a.workspaceId, name: "Lead A", email: "la@a.com" });
    await createLead({ workspaceId: b.workspaceId, name: "Lead B", email: "lb@b.com" });
    await saveConnection(a.workspaceId, "email", { credentials: { apiKey: "re_TOPSECRET", from: "x <x@y.com>" } });
    const ex = await exportWorkspace(a.workspaceId);
    expect(ex.leads.map((l) => l.name)).toEqual(["Lead A"]);
    const json = JSON.stringify(ex);
    expect(json).not.toContain("Lead B");
    expect(json).not.toContain("re_TOPSECRET");
    expect(json).not.toContain("passwordHash");
    expect(json).not.toContain("credentials");
    expect(ex.integrations[0]).toMatchObject({ provider: "email", status: "connected" });
  });
  it("l'export utilisateur ne contient ni mot de passe ni données d'un autre compte", async () => {
    const a = await makeWorkspace("A");
    await makeWorkspace("B");
    const ex = await exportUser(a.userId);
    expect(JSON.stringify(ex)).not.toContain("passwordHash");
    expect(ex.user!.id).toBe(a.userId);
    expect(ex.user!.memberships).toHaveLength(1);
  });
  it("supprimer un espace supprime en cascade toutes ses données", async () => {
    const a = await makeWorkspace("A");
    const { lead } = await createLead({ workspaceId: a.workspaceId, name: "L", email: "l@a.com" });
    await db.campaign.create({ data: { workspaceId: a.workspaceId, name: "C" } });
    await db.workspace.delete({ where: { id: a.workspaceId } });
    for (const n of [await db.lead.count(), await db.campaign.count(), await db.subscription.count(), await db.analyticsEvent.count(), await db.aIQualification.count(), await db.leadActivity.count(), await db.notification.count(), await db.consent.count()]) expect(n).toBe(0);
    expect(await db.lead.findUnique({ where: { id: lead.id } })).toBeNull();
  });
});
