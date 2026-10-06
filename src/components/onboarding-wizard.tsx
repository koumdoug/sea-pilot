"use client";

import { useRef, useState } from "react";
import { ActionForm, CheckField, SelectField, SubmitButton, TextAreaField, TextField } from "./forms";
import { buttonClass, cx } from "./ui";
import type { ActionState } from "@/lib/action";
import { COMPANY_SIZES, CURRENCIES, LANGUAGES } from "@/lib/constants";

const STEPS = ["Entreprise", "Offre", "Client idéal", "Objectifs"] as const;

export function OnboardingWizard({ action, defaults }: { action: (p: ActionState, fd: FormData) => Promise<ActionState>; defaults: { name: string } }) {
  const [step, setStep] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  function next() {
    const els = box.current?.querySelectorAll<HTMLElement>(`[data-step="${step}"] input, [data-step="${step}"] select, [data-step="${step}"] textarea`);
    for (const el of Array.from(els ?? [])) {
      const f = el as HTMLInputElement;
      if (!f.checkValidity()) { f.reportValidity(); return; }
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
    box.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  const pane = (i: number) => cx("space-y-4", step !== i && "hidden");

  return (
    <ActionForm action={action} hideSuccess>
      <ol className="mb-2 flex flex-wrap gap-2" aria-label="Étapes">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={cx("rounded-full px-3 py-1 text-xs font-semibold", i === step ? "bg-brand-600 text-white" : i < step ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-500")}>{i + 1}. {s}</li>
        ))}
      </ol>
      <div ref={box} className="scroll-mt-4">
        <div data-step="0" className={pane(0)}>
          <h2 className="text-lg font-semibold">Votre entreprise</h2>
          <TextField name="name" label="Nom de l'entreprise" required defaultValue={defaults.name} />
          <TextField name="website" label="Site web" placeholder="https://exemple.com" help="Optionnel." />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="industry" label="Secteur d'activité" required placeholder="Ex. rénovation, formation, restauration…" />
            <TextField name="country" label="Pays" required defaultValue="France" />
            <SelectField name="language" label="Langue des contenus" required defaultValue="fr" options={LANGUAGES} />
            <SelectField name="currency" label="Devise" required defaultValue="EUR" options={CURRENCIES} />
          </div>
          <SelectField name="companySize" label="Taille de l'entreprise (personnes)" required options={COMPANY_SIZES} />
          <TextAreaField name="description" label="Description de l'activité" required rows={3} placeholder="Que faites-vous, pour qui, et qu'est-ce qui vous rend utile ?" />
        </div>

        <div data-step="1" className={pane(1)}>
          <h2 className="text-lg font-semibold">Votre offre principale</h2>
          <TextField name="offerName" label="Produit ou service" required />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="price" label="Prix (devise ci-dessus)" type="number" min={0} step="0.01" help="Prix moyen d'une vente." />
            <TextField name="marginPct" label="Marge approximative (%)" type="number" min={0} max={100} step="0.1" />
          </div>
          <TextField name="geoZone" label="Zone géographique desservie" placeholder="Ex. Lyon et sa région, France entière…" />
          <TextAreaField name="advantages" label="Avantages (un par ligne)" rows={3} />
          <TextAreaField name="differentiation" label="Différenciation" rows={2} help="Ce qui vous distingue de vos concurrents." />
        </div>

        <div data-step="2" className={pane(2)}>
          <h2 className="text-lg font-semibold">Votre client idéal</h2>
          <TextField name="customerType" label="Type de client" required placeholder="Ex. propriétaires de maisons de 35-55 ans, PME industrielles…" />
          <SelectField name="audienceType" label="Marché" required defaultValue="b2c" options={[["b2c", "B2C — particuliers"], ["b2b", "B2B — entreprises"]]} />
          <TextField name="location" label="Localisation" />
          <TextAreaField name="needs" label="Besoins" rows={2} />
          <TextAreaField name="problems" label="Problèmes rencontrés" rows={2} />
          <TextAreaField name="objections" label="Objections fréquentes (une par ligne)" rows={2} />
        </div>

        <div data-step="3" className={pane(3)}>
          <h2 className="text-lg font-semibold">Vos objectifs</h2>
          <p className="text-sm text-muted">Ces chiffres servent à calculer votre fiche stratégie et la santé de votre acquisition. Laissez vide ce que vous ne savez pas encore : rien n'est inventé.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="goalLeadsPerMonth" label="Leads par mois" type="number" min={0} step="1" />
            <TextField name="goalSalesPerMonth" label="Ventes par mois" type="number" min={0} step="1" />
            <TextField name="adBudgetMonthly" label="Budget publicitaire mensuel" type="number" min={0} step="1" />
            <TextField name="maxCac" label="Coût d'acquisition client maximal" type="number" min={0} step="1" />
          </div>
          <TextField name="revenueGoal" label="Objectif de chiffre d'affaires mensuel" type="number" min={0} step="1" />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2">
        <button type="button" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0} className={buttonClass("secondary")}>← Retour</button>
        {step < STEPS.length - 1
          ? <button type="button" onClick={next} className={buttonClass("primary")}>Continuer →</button>
          : <SubmitButton pendingLabel="Génération de votre stratégie…">Générer ma stratégie</SubmitButton>}
      </div>
    </ActionForm>
  );
}

export { CheckField };
