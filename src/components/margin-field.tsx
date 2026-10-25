"use client";

import { useEffect, useRef } from "react";
import { CheckField, TextField } from "./forms";
import { isAmbiguousMarginPct, marginInputError } from "@/lib/margin";
import { parseDecimalInput } from "@/lib/number-input";

// Champ « Marge approximative (%) » + case de confirmation d'une marge inférieure à 1 %, avec contrôle d'unité côté navigateur.
// Le serveur reste l'autorité (saveOfferAction / completeOnboardingAction refont le même contrôle). Ici, seule la règle d'AMBIGUÏTÉ est appliquée :
// les bornes 0–100 sont déjà imposées par min/max du champ (validation native) et par le serveur.

const MESSAGE = "[data-margin-error]";

function parts(root: ParentNode) {
  return {
    input: root.querySelector<HTMLInputElement>('input[name="marginPct"]'),
    confirm: root.querySelector<HTMLInputElement>('input[name="marginPctConfirm"]'),
    box: root.querySelector<HTMLElement>(MESSAGE),
  };
}

/** Efface la validité personnalisée et le message d'unité (appelé dès que la valeur ou la case change). */
export function clearMarginCheck(root: ParentNode) {
  const { input, box } = parts(root);
  input?.setCustomValidity("");
  if (box) { box.textContent = ""; box.hidden = true; }
}

/**
 * Contrôle d'unité : renvoie le message (et l'applique par setCustomValidity + message visible près du champ) si la valeur saisie est une marge
 * ambiguë (0 < marge < 1) sans confirmation ; sinon efface tout et renvoie null.
 */
export function applyMarginCheck(root: ParentNode): string | null {
  const { input, confirm, box } = parts(root);
  if (!input) return null;
  // Même grammaire que le serveur (fonction partagée) ; une valeur illisible (badInput du navigateur, format refusé) n'est pas une marge ambiguë : le navigateur ou le serveur la refuse.
  const parsed = parseDecimalInput(input.value);
  const value = parsed.ok ? parsed.value : undefined;
  const error = marginInputError(value, !!confirm?.checked);
  if (error && isAmbiguousMarginPct(value)) {
    input.setCustomValidity(error);
    if (box) { box.textContent = error; box.hidden = false; }
    return error;
  }
  clearMarginCheck(root);
  return null;
}

export function MarginField({ defaultValue }: { defaultValue?: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    const form = root?.closest("form");
    if (!root || !form) return;
    // Soumission : le même contrôle bloque l'envoi AVANT l'action serveur (capture : devant le traitement de l'action par React).
    const onSubmit = (e: Event) => {
      if (!applyMarginCheck(root)) return;
      e.preventDefault();
      e.stopPropagation();
      parts(root).input?.reportValidity();
    };
    form.addEventListener("submit", onSubmit, true);
    return () => form.removeEventListener("submit", onSubmit, true);
  }, []);
  const clear = () => { if (ref.current) clearMarginCheck(ref.current); };
  return (
    <div ref={ref} onInput={clear} onChange={clear}>
      <TextField name="marginPct" label="Marge approximative (%)" type="number" min={0} max={100} step="any" defaultValue={defaultValue} help="La marge s'exprime en pourcentage entier : 28 pour 28 %." />
      <CheckField name="marginPctConfirm" label="Je confirme une marge inférieure à 1 %" help="À cocher seulement si la valeur saisie est bien un pourcentage (0,28 = 0,28 %, pas 28 %)." />
      <p data-margin-error role="alert" hidden className="ml-0 mt-1 text-xs font-medium text-red-700" />
    </div>
  );
}
