import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { log, errMsg } from "../logger";
import { rateLimit } from "../rate-limit";
import { AIError } from "./errors";
import { getProvider } from "./providers";
import { entitlement, limitOf } from "../plans";

export type GenerateParams<S extends z.ZodType> = {
  workspaceId: string;
  userId?: string | null;
  kind: "strategy" | "research" | "offer" | "campaign" | "ad_copy" | "qualification" | "copilot";
  campaignId?: string | null;
  system: string;
  prompt: string;
  schema: S;
  temperature?: number;
  /** données d'entrée à journaliser (jamais de secrets) */
  input?: Record<string, unknown>;
};

export type GenerateResult<S extends z.ZodType> = { data: z.output<S>; generationId: string; provider: string; model: string; promptTokens: number; completionTokens: number; costUsd: number | null };

export function estimateCostUsd(promptTokens: number, completionTokens: number): number | null {
  const pin = env.aiPricePerMTokIn, pout = env.aiPricePerMTokOut;
  if (!pin || !pout) return null; // pas de tarif configuré : on n'invente pas un coût
  return (promptTokens * pin + completionTokens * pout) / 1_000_000;
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch { /* tente d'isoler l'objet */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("no json");
}

/** Point d'entrée UNIQUE pour tout appel IA : configuration, quotas, débit, validation, journalisation. */
export async function generate<S extends z.ZodType>(p: GenerateParams<S>): Promise<GenerateResult<S>> {
  const provider = getProvider();
  if (!provider) throw new AIError("not_configured", "not configured");

  // Protection contre les abus / coûts
  const rl = rateLimit(`ai:${p.workspaceId}`, env.aiRatePerMinute, 60_000);
  if (!rl.ok) throw new AIError("rate_limited", "rate", rl.retryAfterSec);
  const sub = await db.subscription.findUnique({ where: { workspaceId: p.workspaceId } });
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const used = await db.aIGeneration.count({ where: { workspaceId: p.workspaceId, createdAt: { gte: dayStart } } });
  const cap = Math.min(env.aiDailyLimitPerWorkspace, limitOf(entitlement(sub).plan, "aiGenerationsPerDay"));
  if (used >= cap) throw new AIError("quota", "quota");

  const temperature = p.temperature ?? 0.7;
  const base = { workspaceId: p.workspaceId, userId: p.userId ?? null, campaignId: p.campaignId ?? null, kind: p.kind, input: p.input as object | undefined, provider: provider.id, temperature };
  let promptTokens = 0, completionTokens = 0, model = provider.model;
  try {
    let parsed: z.output<S> | undefined;
    let lastErr: unknown;
    let prompt = p.prompt;
    for (let attempt = 0; attempt < 2 && parsed === undefined; attempt++) {
      const res = await provider.complete({ system: p.system, prompt, temperature, json: true, maxTokens: env.aiMaxOutputTokens }, AbortSignal.timeout(env.aiTimeoutMs));
      promptTokens += res.promptTokens; completionTokens += res.completionTokens; model = res.model;
      try {
        const r = p.schema.safeParse(extractJson(res.text));
        if (r.success) parsed = r.data; else lastErr = r.error;
      } catch (e) { lastErr = e; }
      if (parsed === undefined) prompt = `${p.prompt}\n\nATTENTION : ta réponse précédente n'était pas un JSON conforme au format demandé. Réponds uniquement par un JSON valide respectant exactement les clés indiquées.`;
    }
    if (parsed === undefined) throw new AIError("invalid_output", errMsg(lastErr));
    const costUsd = estimateCostUsd(promptTokens, completionTokens);
    const gen = await db.aIGeneration.create({ data: { ...base, model, output: parsed as object, status: "ok", promptTokens, completionTokens, costUsd } });
    log.info("ai.generate", { kind: p.kind, provider: provider.id, model, promptTokens, completionTokens, costUsd });
    return { data: parsed, generationId: gen.id, provider: provider.id, model, promptTokens, completionTokens, costUsd };
  } catch (e) {
    const err = e instanceof AIError ? e : new AIError("provider", errMsg(e));
    await db.aIGeneration.create({ data: { ...base, model, status: "error", error: `${err.code}: ${err.message}`.slice(0, 300), promptTokens, completionTokens } }).catch(() => undefined);
    log.warn("ai.error", { kind: p.kind, provider: provider.id, code: err.code });
    throw err;
  }
}
