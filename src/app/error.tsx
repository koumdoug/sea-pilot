"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="contenu" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-xl font-bold">Une erreur est survenue</h1>
      <p className="mt-1 text-sm text-slate-600">Le problème a été enregistré. Réessayez ; s'il persiste, contactez le support{error.digest ? ` en indiquant le code ${error.digest}` : ""}.</p>
      <button onClick={reset} className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700">Réessayer</button>
    </main>
  );
}
