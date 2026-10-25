import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { requireCtx, type Ctx } from "./tenant";
import { PermissionError, type Action } from "./permissions";
import { log, errMsg } from "./logger";
import { AIError, aiUserMessage } from "./ai/errors";
import { parseDecimalInput } from "./number-input";

export type ActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  id?: string;
  data?: unknown;
  /** Valeurs soumises, renvoyées après un REJET par les seules actions qui le demandent (voir submittedValues) : les champs de formulaire les réaffichent. */
  values?: Record<string, string>;
};

export class UserError extends Error {}

/** Convertit un FormData en objet simple (chaînes vides conservées, clés multiples → tableau). */
export function formObject(fd: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v !== "string") continue;
    if (k.startsWith("$ACTION")) continue;
    const prev = out[k];
    out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/** Valeurs textuelles soumises, pour les réafficher après un rejet : ni fichiers, ni champs internes (`$ACTION…`), ni champ sensible (mot de passe, jeton). */
export function submittedValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string" && !k.startsWith("$") && !/password|token|secret/i.test(k)) out[k] = v;
  return out;
}
/** Ajoute les valeurs soumises à un état d'échec ; un succès est renvoyé tel quel. */
export const withSubmittedValues = (r: ActionState, fd: FormData): ActionState => (r.ok ? r : { ...r, values: submittedValues(fd) });

export class ValidationError extends Error {
  constructor(public fieldErrors: Record<string, string>) {
    super("Certains champs sont invalides.");
  }
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const fieldErrors: Record<string, string> = {};
  for (const i of r.error.issues) {
    const k = String(i.path[0] ?? "_");
    if (!fieldErrors[k]) fieldErrors[k] = i.message;
  }
  throw new ValidationError(fieldErrors);
}

type RunOpts = { action?: Action; allowInactive?: boolean; allowIncompleteOnboarding?: boolean };

/**
 * Enveloppe commune des server actions : contexte multi-tenant + permission + gestion d'erreurs uniforme.
 * Les redirections Next sont propagées (unstable_rethrow).
 */
export async function run(opts: RunOpts, fn: (ctx: Ctx) => Promise<ActionState | void>): Promise<ActionState> {
  try {
    const ctx = await requireCtx(opts);
    const r = await fn(ctx);
    return r ?? { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ValidationError) return { error: e.message, fieldErrors: e.fieldErrors };
    if (e instanceof PermissionError) return { error: "Vous n'avez pas la permission d'effectuer cette action." };
    if (e instanceof UserError) return { error: e.message };
    if (e instanceof AIError) return { error: aiUserMessage(e) };
    log.error("action.failed", { error: errMsg(e) });
    return { error: "Une erreur est survenue. Réessayez ou contactez le support si le problème persiste." };
  }
}

export const optStr = (max = 500) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));
/** Nombre optionnel : grammaire décimale partagée avec le navigateur (src/lib/number-input.ts) ; vide ou espaces = absent (jamais zéro) ; les négatifs restent refusés par chaque champ. */
export const optNum = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    const r = parseDecimalInput(v);
    if (!r.ok) { ctx.addIssue({ code: "custom", message: r.message }); return z.NEVER; }
    return r.value;
  })
  .refine((v) => v === undefined || v >= 0, "Nombre invalide");
