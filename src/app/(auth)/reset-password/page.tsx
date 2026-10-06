import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton, TextField } from "@/components/forms";
import { Alert } from "@/components/ui";
import { resetPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Nouveau mot de passe", robots: { index: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  if (!token) return <Alert tone="error">Lien invalide. <Link href="/forgot-password" className="underline">Demander un nouveau lien</Link>.</Alert>;
  return (
    <>
      <h1 className="text-2xl font-bold">Choisir un nouveau mot de passe</h1>
      <ActionForm action={resetPasswordAction} className="mt-5">
        <input type="hidden" name="token" value={token} />
        <TextField name="password" label="Nouveau mot de passe" type="password" required autoComplete="new-password" help="10 caractères minimum, avec au moins une lettre et un chiffre." />
        <SubmitButton className="w-full">Enregistrer le mot de passe</SubmitButton>
      </ActionForm>
    </>
  );
}
