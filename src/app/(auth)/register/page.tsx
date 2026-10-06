import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { ActionForm, CheckField, SubmitButton, TextField } from "@/components/forms";
import { registerAction } from "../actions";

export const metadata: Metadata = { title: "Créer un compte", description: "Créez votre compte SEA Pilot et démarrez votre essai gratuit." };

export default async function RegisterPage() {
  if (await getSessionUser()) redirect("/dashboard");
  return (
    <>
      <h1 className="text-2xl font-bold">Commencer gratuitement</h1>
      <p className="mt-1 text-sm text-muted">{env.trialDays} jours d'essai, sans carte bancaire.</p>
      <ActionForm action={registerAction} className="mt-5">
        <TextField name="name" label="Votre nom" required autoComplete="name" />
        <TextField name="workspaceName" label="Nom de votre entreprise" required autoComplete="organization" />
        <TextField name="email" label="Adresse e-mail professionnelle" type="email" required autoComplete="email" />
        <TextField name="password" label="Mot de passe" type="password" required autoComplete="new-password" help="10 caractères minimum, avec au moins une lettre et un chiffre." />
        <CheckField name="terms" required label={<>J'accepte les <Link href="/terms" target="_blank" className="underline">conditions d'utilisation</Link> et la <Link href="/privacy" target="_blank" className="underline">politique de confidentialité</Link>.</>} />
        <SubmitButton pendingLabel="Création du compte…" className="w-full">Créer mon compte</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-sm">Déjà inscrit ? <Link href="/login" className="text-brand-700 underline">Se connecter</Link></p>
    </>
  );
}
