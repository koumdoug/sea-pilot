import { env } from "../env";
import { AIError } from "./errors";

export type AIRequest = {
  system: string;
  prompt: string;
  temperature: number;
  json: boolean;
  maxTokens: number;
};

export type AIResponse = { text: string; model: string; promptTokens: number; completionTokens: number };

/** Contrat commun à tous les fournisseurs. Les clés restent côté serveur. */
export interface AIProvider {
  readonly id: string;
  readonly model: string;
  complete(req: AIRequest, signal: AbortSignal): Promise<AIResponse>;
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError") throw new AIError("timeout", "timeout");
    throw new AIError("provider", "network");
  }
  if (res.status === 429) throw new AIError("rate_limited", "provider rate limit", 30);
  if (!res.ok) throw new AIError("provider", `HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

type OpenAIChat = { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };

export class OpenAIProvider implements AIProvider {
  readonly id = "openai";
  constructor(private key: string, readonly model: string, private baseUrl: string) {}
  async complete(req: AIRequest, signal: AbortSignal): Promise<AIResponse> {
    const j = (await post(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.key}` }, {
      model: this.model,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }],
      temperature: req.temperature,
      max_completion_tokens: req.maxTokens,
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    }, signal)) as OpenAIChat;
    const text = j.choices?.[0]?.message?.content;
    if (!text) throw new AIError("provider", "empty");
    return { text, model: j.model ?? this.model, promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 };
  }
}

type AnthropicMsg = { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };

export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";
  constructor(private key: string, readonly model: string) {}
  async complete(req: AIRequest, signal: AbortSignal): Promise<AIResponse> {
    const j = (await post("https://api.anthropic.com/v1/messages", { "x-api-key": this.key, "anthropic-version": "2023-06-01" }, {
      model: this.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      system: req.json ? `${req.system}\nRéponds UNIQUEMENT par un objet JSON valide, sans texte autour.` : req.system,
      messages: [{ role: "user", content: req.prompt }],
    }, signal)) as AnthropicMsg;
    const text = j.content?.filter((c) => c.type === "text").map((c) => c.text).join("") ?? "";
    if (!text) throw new AIError("provider", "empty");
    return { text, model: j.model ?? this.model, promptTokens: j.usage?.input_tokens ?? 0, completionTokens: j.usage?.output_tokens ?? 0 };
  }
}

type GeminiRes = { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };

export class GeminiProvider implements AIProvider {
  readonly id = "gemini";
  constructor(private key: string, readonly model: string) {}
  async complete(req: AIRequest, signal: AbortSignal): Promise<AIResponse> {
    const j = (await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`, { "x-goog-api-key": this.key }, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: { temperature: req.temperature, maxOutputTokens: req.maxTokens, ...(req.json ? { responseMimeType: "application/json" } : {}) },
    }, signal)) as GeminiRes;
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text) throw new AIError("provider", "empty");
    return { text, model: this.model, promptTokens: j.usageMetadata?.promptTokenCount ?? 0, completionTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
  }
}

let override: AIProvider | null = null;
/** Réservé aux tests : injecte un fournisseur déterministe. Refusé en production. */
export function setAIProviderForTests(p: AIProvider | null) {
  if (env.isProd) throw new Error("setAIProviderForTests interdit en production");
  override = p;
}

export type ProviderStatus = {
  configured: boolean; provider: string | null; model: string | null;
  available: { id: string; configured: boolean; hint: string }[];
  /** Raison précise (sans aucune valeur secrète) lorsqu'aucun fournisseur n'est utilisable. */
  problem: string | null;
};

const PROVIDER_IDS = ["openai", "anthropic", "gemini"];

function problemOf(configured: boolean, available: ProviderStatus["available"]): string | null {
  if (configured) return null;
  const forced = env.aiProvider;
  if (forced && !PROVIDER_IDS.includes(forced)) return `AI_PROVIDER est défini à « ${forced} » : valeurs acceptées : ${PROVIDER_IDS.join(", ")} (ou variable absente).`;
  if (forced) {
    const a = available.find((x) => x.id === forced);
    return `AI_PROVIDER = ${forced}, mais ses variables sont absentes ou vides côté serveur : ${a?.hint}.`;
  }
  return "Aucune des variables d'un fournisseur n'est définie (ou elles sont vides) dans l'environnement du serveur.";
}

function candidates(): AIProvider[] {
  const list: AIProvider[] = [];
  if (env.openaiKey && env.openaiModel) list.push(new OpenAIProvider(env.openaiKey, env.openaiModel, env.openaiBaseUrl));
  if (env.anthropicKey) list.push(new AnthropicProvider(env.anthropicKey, env.anthropicModel ?? "claude-sonnet-5-5"));
  if (env.geminiKey && env.geminiModel) list.push(new GeminiProvider(env.geminiKey, env.geminiModel));
  return list;
}

export function getProvider(): AIProvider | null {
  if (override) return override;
  const list = candidates();
  if (env.aiProvider) return list.find((p) => p.id === env.aiProvider) ?? null;
  return list[0] ?? null;
}

export function providerStatus(): ProviderStatus {
  const p = getProvider();
  const available = [
    { id: "openai", configured: !!(env.openaiKey && env.openaiModel), hint: "OPENAI_API_KEY + OPENAI_MODEL" },
    { id: "anthropic", configured: !!env.anthropicKey, hint: "ANTHROPIC_API_KEY (ANTHROPIC_MODEL optionnel)" },
    { id: "gemini", configured: !!(env.geminiKey && env.geminiModel), hint: "GEMINI_API_KEY + GEMINI_MODEL" },
  ];
  return { configured: !!p, provider: p?.id ?? null, model: p?.model ?? null, available, problem: problemOf(!!p, available) };
}
