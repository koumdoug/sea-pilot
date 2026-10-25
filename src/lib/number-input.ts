// Grammaire numérique partagée par le serveur (optNum, src/lib/action.ts) ET le navigateur (margin-field.tsx) : une seule définition.
// Après suppression des espaces périphériques : /^-?(\d+(\.\d+)?|\.\d+)$/ ; la conversion en nombre n'a lieu qu'APRÈS cette validation.
// Les règles propres à chaque champ (signe, bornes, caractère obligatoire) ne sont PAS ici : « -.5 » est reconnu comme nombre (-0.5).

export const INVALID_NUMBER_MESSAGE = "Nombre invalide";
export const SCIENTIFIC_NOTATION_MESSAGE = "Écrivez le nombre en décimal, sans notation scientifique.";

const DECIMAL = /^-?(\d+(\.\d+)?|\.\d+)$/;
/** Notation exponentielle (1e2, 1e-1, 1.5E3, .5e1) : refusée, avec un message explicite. */
const SCIENTIFIC = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;

export type DecimalParse = { ok: true; value: number | undefined } | { ok: false; message: string };

/**
 * Lit une saisie numérique optionnelle. Chaîne vide ou d'espaces = valeur ABSENTE (jamais zéro) ; -0 est normalisé en 0 ;
 * « .5 » → 0.5 ; « 5. », « 0x10 », « NaN », « Infinity » sont refusés ; l'exponentielle est refusée avec un message dédié.
 */
export function parseDecimalInput(v: string | number | undefined): DecimalParse {
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v === "number") return Number.isFinite(v) ? { ok: true, value: v === 0 ? 0 : v } : { ok: false, message: INVALID_NUMBER_MESSAGE };
  const s = v.trim();
  if (s === "") return { ok: true, value: undefined };
  if (!DECIMAL.test(s)) return { ok: false, message: SCIENTIFIC.test(s) ? SCIENTIFIC_NOTATION_MESSAGE : INVALID_NUMBER_MESSAGE };
  const n = Number(s);
  return { ok: true, value: n === 0 ? 0 : n };
}
