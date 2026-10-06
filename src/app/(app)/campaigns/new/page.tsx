import type { Metadata } from "next";
import { requireCtx } from "@/lib/tenant";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/forms";
import { Alert, PageHeader, Section } from "@/components/ui";
import { CAMPAIGN_OBJECTIVES, OBJECTIVE_LABEL } from "@/lib/constants";
import { createCampaignAction } from "../actions";

export const metadata: Metadata = { title: "Nouvelle campagne" };

export default async function NewCampaignPage() {
  const ctx = await requireCtx({ action: "write" });
  return (
    <>
      <PageHeader title="Nouvelle campagne" subtitle="Étape 1 sur 10 — Objectif. Le brouillon est enregistré à chaque étape." />
      <Section title="Objectif de la campagne">
        {!ctx.workspace.onboardingCompletedAt && <Alert tone="warning">Terminez l'onboarding pour pré-remplir offre et audience.</Alert>}
        <ActionForm action={createCampaignAction}>
          <TextField name="name" label="Nom de la campagne" required placeholder="Ex. Recherche Google — rénovation Lyon" />
          <SelectField name="objective" label="Objectif principal" required defaultValue="leads" options={CAMPAIGN_OBJECTIVES.map((o) => [o, OBJECTIVE_LABEL[o]] as const)} />
          <SubmitButton pendingLabel="Création…">Continuer</SubmitButton>
        </ActionForm>
      </Section>
    </>
  );
}
