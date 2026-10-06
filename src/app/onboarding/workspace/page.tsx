import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getCtx } from "@/lib/tenant";
import { ActionForm, SubmitButton, TextField } from "@/components/forms";
import { createFirstWorkspaceAction } from "../actions";

export const metadata: Metadata = { title: "Créer un espace de travail", robots: { index: false } };

export default async function NewWorkspacePage() {
  await requireUser();
  if (await getCtx()) redirect("/dashboard");
  return (
    <div className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-bold">Créer votre espace de travail</h1>
      <p className="mb-5 mt-1 text-sm text-muted">Votre compte n'est rattaché à aucune entreprise pour le moment.</p>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <ActionForm action={createFirstWorkspaceAction}>
          <TextField name="name" label="Nom de l'entreprise" required />
          <SubmitButton className="w-full">Créer l'espace</SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}
