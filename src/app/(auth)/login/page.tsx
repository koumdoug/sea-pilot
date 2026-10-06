import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ActionForm, SubmitButton, TextField } from "@/components/forms";
import { Alert } from "@/components/ui";
import { loginAction } from "../actions";

export const metadata: Metadata = { title: "Connexion", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string; reset?: string }> }) {
  const sp = await searchParams;
  if (await getSessionUser()) redirect("/dashboard");
  return (
    <>
      <h1 className="text-2xl font-bold">Connexion</h1>
      <p className="mt-1 text-sm text-muted">Accédez à votre espace SEA Pilot.</p>
      <div className="mt-4 space-y-3">
        {sp.expired && <Alert tone="warning">Votre session a expiré. Reconnectez-vous pour continuer.</Alert>}
        {sp.reset && <Alert tone="success">Mot de passe modifié. Vous pouvez vous connecter.</Alert>}
      </div>
      <ActionForm action={loginAction} className="mt-5">
        <input type="hidden" name="next" value={sp.next ?? ""} />
        <TextField name="email" label="Adresse e-mail" type="email" required autoComplete="email" />
        <TextField name="password" label="Mot de passe" type="password" required autoComplete="current-password" />
        <SubmitButton pendingLabel="Connexion…" className="w-full">Se connecter</SubmitButton>
      </ActionForm>
      <div className="mt-5 flex flex-wrap justify-between gap-2 text-sm">
        <Link href="/forgot-password" className="text-brand-700 underline">Mot de passe oublié ?</Link>
        <Link href="/register" className="text-brand-700 underline">Créer un compte</Link>
      </div>
    </>
  );
}
