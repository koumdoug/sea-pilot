import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm, SubmitButton, TextField } from "@/components/forms";
import { forgotPasswordAction } from "../actions";

export const metadata: Metadata = { title: "Mot de passe oublié", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">Mot de passe oublié</h1>
      <p className="mt-1 text-sm text-muted">Saisissez votre adresse e-mail : nous vous envoyons un lien de réinitialisation.</p>
      <ActionForm action={forgotPasswordAction} className="mt-5">
        <TextField name="email" label="Adresse e-mail" type="email" required autoComplete="email" />
        <SubmitButton pendingLabel="Envoi…" className="w-full">Envoyer le lien</SubmitButton>
      </ActionForm>
      <p className="mt-5 text-sm"><Link href="/login" className="text-brand-700 underline">Retour à la connexion</Link></p>
    </>
  );
}
