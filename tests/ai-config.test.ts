import { afterEach, describe, expect, it } from "vitest";
import { getProvider, providerStatus } from "@/lib/ai/providers";

const KEYS = ["AI_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const set = (o: Record<string, string>) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, o); };

describe("détection de la configuration IA (sans jamais exposer de valeur)", () => {
  it("aucune variable : non configuré, raison explicite", () => {
    set({});
    const s = providerStatus();
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/Aucune des variables/);
  });
  it("Anthropic : clé + AI_PROVIDER → configuré, modèle choisi", () => {
    set({ ANTHROPIC_API_KEY: "k-test-valeur", ANTHROPIC_MODEL: "claude-sonnet-4-6", AI_PROVIDER: "anthropic" });
    const s = providerStatus();
    expect([s.configured, s.provider, s.model, s.problem]).toEqual([true, "anthropic", "claude-sonnet-4-6", null]);
  });
  it("guillemets, espaces et casse saisis par erreur dans la console d'hébergement sont tolérés", () => {
    set({ ANTHROPIC_API_KEY: ' "k-test-valeur" ', ANTHROPIC_MODEL: "'claude-sonnet-4-6'", AI_PROVIDER: ' "Anthropic" ' });
    const s = providerStatus();
    expect([s.configured, s.provider, s.model]).toEqual([true, "anthropic", "claude-sonnet-4-6"]);
  });
  it("clé vide : non configuré, la raison nomme la variable manquante et le fournisseur forcé", () => {
    set({ ANTHROPIC_API_KEY: "   ", AI_PROVIDER: "anthropic" });
    const s = providerStatus();
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/AI_PROVIDER = anthropic.*ANTHROPIC_API_KEY/);
    expect(getProvider()).toBeNull();
  });
  it("AI_PROVIDER invalide : la raison cite la valeur (non secrète) et les valeurs acceptées", () => {
    set({ ANTHROPIC_API_KEY: "k-test-valeur", AI_PROVIDER: "claude" });
    const s = providerStatus();
    expect(s.configured).toBe(false);
    expect(s.problem).toMatch(/« claude ».*openai, anthropic, gemini/);
  });
  it("la raison ne contient jamais la valeur de la clé", () => {
    set({ ANTHROPIC_API_KEY: "SECRET-NE-DOIT-PAS-FUITER", AI_PROVIDER: "x" });
    expect(JSON.stringify(providerStatus())).not.toContain("SECRET-NE-DOIT-PAS-FUITER");
  });
  it("OpenAI sans modèle : non configuré (modèle obligatoire)", () => {
    set({ OPENAI_API_KEY: "k-test" });
    expect(providerStatus().configured).toBe(false);
  });
});
