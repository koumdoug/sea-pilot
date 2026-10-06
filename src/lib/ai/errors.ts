export type AIErrorCode = "not_configured" | "rate_limited" | "quota" | "timeout" | "provider" | "invalid_output";

export class AIError extends Error {
  constructor(public code: AIErrorCode, message: string, public retryAfterSec?: number) {
    super(message);
  }
}

export function aiUserMessage(e: AIError): string {
  switch (e.code) {
    case "not_configured": return "Configuration requise : aucun fournisseur d'IA n'est configuré sur ce serveur (voir OPENAI_API_KEY, ANTHROPIC_API_KEY ou GEMINI_API_KEY dans le README).";
    case "rate_limited": return `Trop de demandes IA en peu de temps. Réessayez dans ${e.retryAfterSec ?? 60} s.`;
    case "quota": return "Quota quotidien d'utilisation de l'IA atteint pour cet espace de travail. Il se renouvelle demain ou avec un plan supérieur.";
    case "timeout": return "Le fournisseur d'IA n'a pas répondu à temps. Réessayez.";
    case "invalid_output": return "La réponse de l'IA était inexploitable. Réessayez.";
    default: return "Le fournisseur d'IA a renvoyé une erreur. Réessayez dans un instant.";
  }
}
