import Link from "next/link";

export default function NotFound() {
  return (
    <main id="contenu" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-5xl font-extrabold text-brand-600">404</p>
      <h1 className="mt-2 text-xl font-bold">Page introuvable</h1>
      <p className="mt-1 text-sm text-slate-600">Cette page n'existe pas, n'est plus publiée ou vous n'y avez pas accès.</p>
      <Link href="/" className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-brand-600 px-5 font-semibold text-white hover:bg-brand-700">Retour à l'accueil</Link>
    </main>
  );
}
