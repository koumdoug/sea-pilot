import Link from "next/link";
import { getSessionUser } from "@/lib/auth";

export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 text-lg font-extrabold tracking-tight"><span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-white" aria-hidden="true">S</span>SEA Pilot</Link>
          <nav className="hidden items-center gap-5 text-sm font-medium text-slate-700 md:flex" aria-label="Navigation du site">
            <Link href="/#fonctionnement" className="hover:text-brand-700">Fonctionnement</Link><Link href="/#fonctionnalites" className="hover:text-brand-700">Fonctionnalités</Link>
            <Link href="/demo" className="hover:text-brand-700">Démo</Link><Link href="/#tarifs" className="hover:text-brand-700">Tarifs</Link><Link href="/#faq" className="hover:text-brand-700">FAQ</Link>
          </nav>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {user ? <Link href="/dashboard" className="inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-4 text-white hover:bg-brand-700">Mon espace</Link> : <>
              <Link href="/login" className="inline-flex min-h-10 items-center rounded-lg px-3 hover:bg-slate-100">Connexion</Link>
              <Link href="/register" className="inline-flex min-h-10 items-center rounded-lg bg-brand-600 px-4 text-white hover:bg-brand-700">Commencer gratuitement</Link></>}
          </div>
        </div>
      </header>
      <main id="contenu" className="flex-1">{children}</main>
      <footer className="border-t border-slate-200 bg-slate-50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-slate-600">
          <p>© {new Date().getFullYear()} SEA Pilot</p>
          <nav className="flex gap-4" aria-label="Liens légaux"><Link href="/privacy" className="underline">Confidentialité</Link><Link href="/terms" className="underline">Conditions d'utilisation</Link><Link href="/demo" className="underline">Démo</Link></nav>
        </div>
      </footer>
    </div>
  );
}
