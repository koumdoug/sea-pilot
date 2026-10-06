import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS, formFieldsSchema } from "@/lib/landing";
import { SubmitError, submitToForm, validateValues } from "@/lib/public-leads";
import { POST as publicLead } from "@/app/api/public/leads/route";
import { POST as track } from "@/app/api/track/route";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

async function publishedPageWithForm(workspaceId: string, extra: Partial<{ campaignId: string }> = {}) {
  const page = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp", status: "published", sections: [], ...extra } });
  const form = await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", fields: DEFAULT_FORM_FIELDS as object[], consentText: DEFAULT_CONSENT } });
  return { page, form };
}
const post = (body: unknown, ip = "1.1.1.1") => publicLead(new Request("http://x/api/public/leads", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));

describe("validation du formulaire", () => {
  const fields = formFieldsSchema.parse(DEFAULT_FORM_FIELDS);
  it("champs obligatoires, formats e-mail et téléphone", () => {
    expect(validateValues(fields, {}).errors).toMatchObject({ name: expect.any(String), email: expect.any(String) });
    expect(validateValues(fields, { name: "A", email: "pas-un-email" }).errors.email).toMatch(/invalide/);
    expect(validateValues(fields, { name: "A", email: "a@b.co", phone: "abc" }).errors.phone).toMatch(/invalide/);
    expect(validateValues(fields, { name: "A", email: "a@b.co", phone: "+33 6 00 00 00 00" }).errors).toEqual({});
  });
  it("les clés inconnues sont ignorées (pas d'injection de colonnes)", () => {
    const v: Record<string, unknown> = { name: "A", email: "a@b.co", status: "won", workspaceId: "autre", value: 99999 };
    const { clean } = validateValues(fields, v);
    expect(Object.keys(clean).sort()).toEqual(["email", "name"]);
  });
  it("longueur maximale", () => {
    expect(validateValues(fields, { name: "A", email: "a@b.co", message: "x".repeat(4001) }).errors.message).toMatch(/Maximum/);
  });
});

describe("soumission publique", () => {
  it("crée le lead dans le bon espace avec campagne, UTM, consentement et événement form_submit", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "Camp" } });
    const { form } = await publishedPageWithForm(workspaceId, { campaignId: c.id });
    const r = await submitToForm(form.id, { values: { name: "Marie", email: "marie@x.com", message: "bonjour" }, consent: true, utm: { source: "meta", medium: "paid_social", campaign: "x" }, ipHash: "h" });
    expect(r.lead.workspaceId).toBe(workspaceId);
    expect(r.lead.campaignId).toBe(c.id);
    expect(r.lead.utmSource).toBe("meta");
    expect(r.lead.consentMarketing).toBe(true);
    expect(r.lead.consentText).toBe(DEFAULT_CONSENT);
    expect(await db.analyticsEvent.count({ where: { workspaceId, type: "form_submit" } })).toBe(1);
  });

  it("les champs qualifiants vont dans customFields et alimentent la qualification", async () => {
    const { workspaceId } = await makeWorkspace();
    const page = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp2", status: "published", sections: [] } });
    const form = await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", consentText: "c", fields: [...DEFAULT_FORM_FIELDS, { key: "budget", label: "Budget", type: "text", required: false }] as object[] } });
    const r = await submitToForm(form.id, { values: { name: "A", email: "a@b.co", budget: "5000" } });
    expect(r.lead.customFields).toEqual({ budget: "5000" });
    const q = await db.aIQualification.findFirstOrThrow({ where: { leadId: r.lead.id } });
    expect(JSON.stringify(q.facts)).toContain("budget");
  });

  it("une page non publiée ou un formulaire inactif ne reçoit rien", async () => {
    const { workspaceId } = await makeWorkspace();
    const { page, form } = await publishedPageWithForm(workspaceId);
    await db.landingPage.update({ where: { id: page.id }, data: { status: "draft" } });
    await expect(submitToForm(form.id, { values: { name: "A", email: "a@b.co" } })).rejects.toThrow(SubmitError);
    await db.landingPage.update({ where: { id: page.id }, data: { status: "published" } });
    await db.form.update({ where: { id: form.id }, data: { active: false } });
    await expect(submitToForm(form.id, { values: { name: "A", email: "a@b.co" } })).rejects.toThrow(SubmitError);
    expect(await db.lead.count({ where: { workspaceId } })).toBe(0);
  });

  it("route HTTP : succès, validation 422, honeypot silencieux, JSON invalide 400", async () => {
    const { workspaceId } = await makeWorkspace();
    const { form } = await publishedPageWithForm(workspaceId);
    const ok = await post({ formId: form.id, values: { name: "Marie", email: "m@x.com" }, consent: false, utm: { source: "google" } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect(await db.lead.count({ where: { workspaceId } })).toBe(1);

    const bad = await post({ formId: form.id, values: { name: "", email: "x" } }, "2.2.2.2");
    expect(bad.status).toBe(422);
    expect((await bad.json()).fieldErrors).toBeTruthy();

    const bot = await post({ formId: form.id, values: { name: "Bot", email: "bot@x.com" }, hp: "http://spam" }, "3.3.3.3");
    expect(bot.status).toBe(200);
    expect(await db.lead.count({ where: { workspaceId } })).toBe(1); // le robot n'a rien créé

    const junk = await publicLead(new Request("http://x/api/public/leads", { method: "POST", headers: { "x-forwarded-for": "4.4.4.4" }, body: "pas du json" }));
    expect(junk.status).toBe(400);
  });

  it("limitation de débit par IP et formulaire", async () => {
    const { workspaceId } = await makeWorkspace();
    const { form } = await publishedPageWithForm(workspaceId);
    let last = 200;
    for (let i = 0; i < 10; i++) last = (await post({ formId: form.id, values: { name: "A", email: `a${i}@x.com` } }, "9.9.9.9")).status;
    expect(last).toBe(429);
  });
});

describe("mesure d'audience /api/track", () => {
  const send = (body: unknown, ip = "5.5.5.5") => track(new Request("http://x/api/track", { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body) }));
  it("enregistre une visite avec UTM, sans PII, uniquement pour une page publiée", async () => {
    const { workspaceId } = await makeWorkspace();
    const { page } = await publishedPageWithForm(workspaceId);
    expect((await send({ pageId: page.id, type: "page_view", sessionId: "s1", utm: { source: "google", campaign: "c" } })).status).toBe(204);
    const e = await db.analyticsEvent.findFirstOrThrow({ where: { workspaceId, type: "page_view" } });
    expect([e.utmSource, e.utmCampaign, e.landingPageId]).toEqual(["google", "c", page.id]);
    await db.landingPage.update({ where: { id: page.id }, data: { status: "draft" } });
    expect((await send({ pageId: page.id, type: "page_view" })).status).toBe(404);
    expect((await send({ pageId: "x", type: "autre" })).status).toBe(400);
  });
});
