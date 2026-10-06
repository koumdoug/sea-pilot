import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-6 flex items-center gap-2 text-xl font-extrabold tracking-tight">
        <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white" aria-hidden="true">S</span>SEA Pilot
      </Link>
      <main id="contenu" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</main>
      <p className="mt-6 text-xs text-slate-500">
        <Link href="/privacy" className="underline">Confidentialité</Link> · <Link href="/terms" className="underline">Conditions d'utilisation</Link>
      </p>
    </div>
  );
}
