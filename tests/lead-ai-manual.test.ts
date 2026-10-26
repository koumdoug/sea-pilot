// Qualification IA réservée à une action manuelle explicite : la création d'un lead ne déclenche jamais d'appel IA,
// quel que soit le réglage `useAi` conservé en base (colonne désormais ignorée). L'action manuelle « Qualifier avec l'IA »
// garde ses permissions, la journalisation (AIGeneration) et le repli déterministe (absence ou échec du fournisseur).
// Les tests prouvent des appels (fake.calls, lignes AIGeneration, enregistrements AIQualification), pas seulement un rendu.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string; role: string; denyAi: boolean } = { ws: "", role: "owner", denyAi: false };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
// Contexte simulé, mais avec le VRAI contrôle de permission (assertCan) pour le rôle courant ; `denyAi` retire seulement la permission « ai ».
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
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: state.role, subscription: null, ent: { active: true }, can: (a: import("@/lib/permissions").Action) => !(state.denyAi && a === "ai") && can(state.role, a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { AIError } from "@/lib/ai/errors";
import { setAIProviderForTests, type AIProvider, type AIRequest } from "@/lib/ai/providers";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS } from "@/lib/landing";
import { createLead, qualifyLeadService } from "@/lib/leads";
import { submitToForm } from "@/lib/public-leads";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); state.role = "owner"; state.denyAi = false; });
afterEach(() => setAIProviderForTests(null));

class Fake implements AIProvider {
  readonly id = "fake";
  readonly model = "fake-1";
  calls: AIRequest[] = [];
  constructor(private replies: (string | Error)[]) {}
  async complete(req: AIRequest) {
    this.calls.push(req);
    const r = this.replies.length > 1 ? this.replies.shift()! : (this.replies[0] ?? "{}");
    if (r instanceof Error) throw r;
    return { text: r, model: this.model, promptTokens: 100, completionTokens: 50 };
  }
}
const REPLY = JSON.stringify({ adjustments: [{ key: "budget", value: 0.9, evidence: "Budget évoqué", quote: "budget confortable" }], nextAction: "Appeler aujourd'hui" });
const fd = (f: Record<string, string>) => { const x = new FormData(); for (const [k, v] of Object.entries(f)) x.set(k, v); return x; };
const setUseAi = (workspaceId: string, useAi: boolean) => db.qualificationConfig.update({ where: { workspaceId }, data: { useAi } });
const qualCount = (workspaceId: string, leadId?: string) => db.aIQualification.count({ where: { workspaceId, ...(leadId ? { leadId } : {}) } });
const genCount = (workspaceId: string) => db.aIGeneration.count({ where: { workspaceId } });
const MSG = "Nous avons un budget confortable pour ce projet";

async function setup(opts: { useAi?: boolean; provider?: Fake | null } = {}) {
  const w = await makeWorkspace();
  state.ws = w.workspaceId;
  if (opts.useAi !== undefined) await setUseAi(w.workspaceId, opts.useAi);
  if (opts.provider) setAIProviderForTests(opts.provider);
  return w;
}

describe("création d'un lead : aucun appel IA automatique", () => {
  for (const useAi of [true, false]) {
    it(`useAi=${useAi}, fournisseur configuré : aucun appel, aucune génération journalisée, qualification déterministe enregistrée`, async () => {
      const fake = new Fake([REPLY]);
      const { workspaceId } = await setup({ useAi, provider: fake });
      const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
      expect(fake.calls).toHaveLength(0);
      expect(await genCount(workspaceId)).toBe(0);
      const rec = await db.aIQualification.findFirstOrThrow({ where: { workspaceId, leadId: lead.id } });
      expect(rec.method).toBe("rules");
      expect(rec.provider).toBeNull();
      const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(stored.score).not.toBeNull();
      expect(stored.qualificationLevel).not.toBeNull();
    });
  }

  it("useAi=true, formulaire public, fournisseur configuré : aucun appel, lead qualifié par les règles", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId } = await setup({ useAi: true, provider: fake });
    const page = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp", status: "published", sections: [] } });
    const form = await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", fields: DEFAULT_FORM_FIELDS as object[], consentText: DEFAULT_CONSENT } });
    const r = await submitToForm(form.id, { values: { name: "Visiteur", email: "v@y.com", message: MSG }, consent: true });
    expect(fake.calls).toHaveLength(0);
    expect(await genCount(workspaceId)).toBe(0);
    expect((await db.aIQualification.findFirstOrThrow({ where: { workspaceId, leadId: r.lead.id } })).method).toBe("rules");
  });

  it("qualification automatique désactivée + useAi=true : ni qualification, ni appel IA, le lead est bien créé", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId } = await setup({ provider: fake });
    await db.qualificationConfig.update({ where: { workspaceId }, data: { autoQualify: false, useAi: true } });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    expect(fake.calls).toHaveLength(0);
    expect(await qualCount(workspaceId)).toBe(0);
    expect(await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).toBeTruthy();
  });

  it("service : sans demande explicite (allowAi absent), useAi=true en base n'active pas l'IA", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId, userId } = await setup({ useAi: true, provider: fake });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    const r = await qualifyLeadService({ workspaceId, leadId: lead.id, userId });
    expect(r.method).toBe("rules");
    expect(fake.calls).toHaveLength(0);
    const explicitFalse = await qualifyLeadService({ workspaceId, leadId: lead.id, userId, allowAi: false });
    expect(explicitFalse.method).toBe("rules");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("qualification IA manuelle (action « Qualifier avec l'IA »)", () => {
  const act = async (f: Record<string, string>) => (await import("@/app/(app)/leads/actions")).qualifyAction({}, fd(f));

  it("rôle autorisé, fournisseur disponible : un appel, méthode rules+ai, génération journalisée", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId } = await setup({ useAi: false, provider: fake });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    expect(fake.calls).toHaveLength(0);
    const r = await act({ id: lead.id, ai: "1" });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/règles \+ analyse IA/) });
    expect(fake.calls).toHaveLength(1);
    const gen = await db.aIGeneration.findFirstOrThrow({ where: { workspaceId } });
    expect(gen).toMatchObject({ kind: "qualification", status: "ok", provider: "fake" });
    const last = await db.aIQualification.findFirstOrThrow({ where: { workspaceId, leadId: lead.id }, orderBy: { createdAt: "desc" } });
    expect(last.method).toBe("rules+ai");
    expect(last.provider).toBe("fake");
  });

  it("bouton « Qualifier » sans IA, même avec useAi=true en base : aucun appel (le réglage est sans effet)", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId } = await setup({ useAi: true, provider: fake });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    const r = await act({ id: lead.id });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/règles configurables/) });
    expect(fake.calls).toHaveLength(0);
    expect(await genCount(workspaceId)).toBe(0);
  });

  it("fournisseur absent : repli sur les règles avec message explicite, qualification enregistrée", async () => {
    const { workspaceId } = await setup();
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    const before = await qualCount(workspaceId, lead.id);
    const r = await act({ id: lead.id, ai: "1" });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/l'IA n'a pas pu être utilisée/) });
    expect(await qualCount(workspaceId, lead.id)).toBe(before + 1);
    expect((await db.aIQualification.findFirstOrThrow({ where: { workspaceId, leadId: lead.id }, orderBy: { createdAt: "desc" } })).method).toBe("rules");
    expect(await genCount(workspaceId)).toBe(0);
  });

  it("échec du fournisseur : repli sur les règles, lead intact, échec journalisé", async () => {
    const fake = new Fake([new AIError("provider", "HTTP 500")]);
    const { workspaceId } = await setup({ provider: fake });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    const scoreBefore = (await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).score;
    const r = await act({ id: lead.id, ai: "1" });
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/l'IA n'a pas pu être utilisée/) });
    expect(fake.calls).toHaveLength(1);
    const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(stored.name).toBe("Q");
    expect(stored.score).toBe(scoreBefore); // qualification déterministe identique
    expect((await db.aIQualification.findFirstOrThrow({ where: { workspaceId, leadId: lead.id }, orderBy: { createdAt: "desc" } })).method).toBe("rules");
    expect(await db.aIGeneration.count({ where: { workspaceId, status: "error" } })).toBe(1);
  });

  it("rôle sans permission d'écriture (viewer) : action refusée côté serveur, avec ou sans IA, aucun appel", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId } = await setup({ provider: fake });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    const before = await qualCount(workspaceId, lead.id);
    state.role = "viewer";
    const attempts: Record<string, string>[] = [{ id: lead.id, ai: "1" }, { id: lead.id }];
    for (const f of attempts) {
      const r = await act(f);
      expect(r).toMatchObject({ error: expect.stringMatching(/permission/) });
    }
    expect(fake.calls).toHaveLength(0);
    expect(await qualCount(workspaceId, lead.id)).toBe(before);
    expect(await genCount(workspaceId)).toBe(0);
  });

  it("rôle qui écrit mais sans permission « ai » : l'IA est refusée côté serveur, la qualification par règles reste permise", async () => {
    const fake = new Fake([REPLY]);
    const { workspaceId } = await setup({ provider: fake });
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: MSG });
    state.role = "member";
    state.denyAi = true;
    const denied = await act({ id: lead.id, ai: "1" });
    expect(denied).toMatchObject({ error: "Votre rôle ne permet pas d'utiliser l'IA." });
    expect(fake.calls).toHaveLength(0);
    expect(await genCount(workspaceId)).toBe(0);
    expect(await act({ id: lead.id })).toMatchObject({ ok: true });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("réglages de qualification : le champ « useAi » n'est plus enregistré", () => {
  const save = async (extra: Record<string, string>) => (await import("@/app/(app)/settings/actions")).saveQualificationAction({}, fd({ hot: "70", warm: "40", e_need: "on", w_need: "50", autoQualify: "on", ...extra }));

  it("un champ useAi=on soumis ne modifie pas la colonne ; seuils et qualification automatique sont enregistrés", async () => {
    const { workspaceId } = await setup();
    expect(await save({ useAi: "on", hot: "80" })).toMatchObject({ ok: true });
    const cfg = await db.qualificationConfig.findUniqueOrThrow({ where: { workspaceId } });
    expect(cfg.useAi).toBe(false);
    expect(cfg.hotThreshold).toBe(80);
    expect(cfg.autoQualify).toBe(true);
  });

  it("un enregistrement sans champ useAi ne remet pas la colonne conservée à false (aucune écriture de la colonne)", async () => {
    const { workspaceId } = await setup({ useAi: true });
    expect(await save({})).toMatchObject({ ok: true });
    expect((await db.qualificationConfig.findUniqueOrThrow({ where: { workspaceId } })).useAi).toBe(true);
  });
});
