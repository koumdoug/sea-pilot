import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/tenant";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { completeOnboardingAction } from "./actions";

export const metadata: Metadata = { title: "Bienvenue", robots: { index: false } };

export default async function OnboardingPage() {
  const ctx = await requireCtx({ allowIncompleteOnboarding: true, allowInactive: true });
  if (ctx.workspace.onboardingCompletedAt) redirect("/dashboard");
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold">Bienvenue sur SEA Pilot, {ctx.user.name.split(" ")[0]} 👋</h1>
      <p className="mb-6 mt-1 text-sm text-muted">Quatre étapes pour comprendre votre activité. À la fin, SEA Pilot génère votre première fiche stratégie d'acquisition.</p>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <main id="contenu"><OnboardingWizard action={completeOnboardingAction} defaults={{ name: ctx.workspace.name }} /></main>
      </div>
    </div>
  );
}
