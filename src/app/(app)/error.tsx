"use client";

import Link from "next/link";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-lg rounded-xl border border-red-200 bg-red-50 p-6">
      <h1 className="text-lg font-bold text-red-900">Cet écran n'a pas pu se charger</h1>
      <p className="mt-1 text-sm text-red-900">Une erreur est survenue. Vos données ne sont pas affectées.{error.digest ? ` (code ${error.digest})` : ""}</p>
      <div className="mt-4 flex gap-2"><button onClick={reset} className="min-h-11 rounded-lg bg-red-700 px-4 text-sm font-semibold text-white">Réessayer</button><Link href="/dashboard" className="inline-flex min-h-11 items-center rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-900">Dashboard</Link></div>
    </div>
  );
}
