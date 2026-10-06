import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/lib/env";
import { PLANS } from "@/lib/plans";
import { PLAN_IDS } from "@/lib/constants";

export const metadata: Metadata = {
  title: { absolute: "SEA Pilot — Transformez votre acquisition en système automatisé" },
  description: "De la recherche de marché au suivi des prospects : SEA Pilot structure votre acquisition client, qualifie vos leads avec l'IA, automatise vos relances et mesure chaque euro dépensé.",
  alternates: { canonical: "/" },
  openGraph: { title: "SEA Pilot — Transformez votre acquisition en système automatisé", description: "Recherche, stratégie, campagnes, landing pages, leads, qualification IA, relances et analytics dans un seul outil.", type: "website", url: "/" },
};

const STEPS = [
  ["Recherche", "Comprenez votre marché et vos prospects."], ["Stratégie", "Une fiche chiffrée à partir de vos objectifs."], ["Offre", "Des variantes de proposition de valeur."], ["Campagne", "Un assistant en 10 étapes."],
  ["Landing page", "Publiez une page qui capture des leads."], ["Lead", "UTM, campagne et consentement conservés."], ["Qualification IA", "Score, raisons, informations manquantes."], ["Relance", "Séquences J0 à J14, avec consentement."],
  ["Conversion", "Un CRM simple du lead au client."], ["Analyse", "CPL, CAC, ROAS, ROI — sans chiffre inventé."], ["Optimisation", "Recommandations priorisées avec preuves."],
];

const FEATURES = [
  ["Recherche de marché", "Une synthèse structurée où vos données vérifiées sont séparées des hypothèses générées par l'IA."],
  ["Offer Builder", "Plusieurs variantes d'offre : titre, bénéfices, objections, garanties suggérées, bundles et upsells."],
  ["Campaign Builder", "Objectif, audience, message, plateforme, budget, landing page, créatifs, tracking, lancement."],
  ["Landing pages", "Éditeur de sections, SEO, formulaire, aperçu, publication, duplication. Responsive."],
  ["Leads & CRM", "Pipeline, historique, notes, tâches, campagne d'origine et paramètres UTM sur chaque prospect."],
  ["AI Studio", "Annonces Meta, Google, TikTok et LinkedIn avec variantes A/B, enregistrées et modifiables."],
  ["Automatisations", "Relances e-mail, tâches, rappels et changements de statut — arrêt automatique à la conversion."],
  ["Analytics", "Filtres par période, campagne, plateforme, source et audience. Graphiques lisibles."],
];

const FAQ = [
  ["Mes données sont-elles isolées des autres clients ?", "Oui. Chaque entreprise dispose d'un espace de travail séparé ; chaque requête serveur est filtrée par espace et par rôle."],
  ["Les e-mails de relance partent-ils tout seuls ?", "Jamais sans votre accord explicite : il faut connecter votre fournisseur d'e-mail, activer l'envoi sur la séquence, et le prospect doit avoir consenti. Sinon, une tâche manuelle est créée."],
  ["SEA Pilot invente-t-il des chiffres ?", "Non. Un indicateur qui ne peut pas être calculé s'affiche « — » avec l'explication. Les contenus générés par l'IA sont identifiés comme tels."],
  ["Faut-il connecter Google Ads ou Meta Ads ?", "Pas obligatoirement : vous pouvez saisir ou importer vos dépenses (CSV). Les connexions directes sont disponibles lorsque l'administrateur configure les accès aux plateformes."],
  ["Comment fonctionne l'essai ?", `${env.trialDays} jours d'essai gratuit, sans carte bancaire. À la fin, choisissez un plan pour continuer.`],
  ["Puis-je supprimer ou exporter mes données ?", "Oui : export JSON, suppression d'un prospect, de votre compte ou de tout l'espace depuis les réglages."],
];

export default function HomePage() {
  const faqLd = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd).replace(/</g, "\\u003c") }} />
      <section className="bg-gradient-to-b from-brand-50 to-white px-4 py-16 text-center sm:py-24">
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 inline-block rounded-full bg-white px-3 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100">Acquisition client pilotée par l'IA</p>
          <h1 className="text-4xl font-extrabold tracking-tight text-ink sm:text-6xl">Transformez votre acquisition en système automatisé.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-700">De la recherche de marché au suivi des prospects : un seul outil pour créer vos campagnes et vos landing pages, capter et qualifier vos leads, relancer, et savoir ce qui rapporte vraiment.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/register" className="inline-flex min-h-12 items-center rounded-lg bg-brand-600 px-6 text-base font-semibold text-white hover:bg-brand-700">Commencer gratuitement</Link>
            <Link href="/demo" className="inline-flex min-h-12 items-center rounded-lg border border-slate-300 bg-white px-6 text-base font-semibold hover:bg-slate-50">Voir la démo</Link>
          </div>
          <p className="mt-3 text-sm text-slate-500">{env.trialDays} jours d'essai · sans carte bancaire</p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-8 px-4 py-14 md:grid-cols-2" aria-labelledby="probleme">
        <div><h2 id="probleme" className="text-2xl font-bold sm:text-3xl">Le problème</h2>
          <ul className="mt-4 space-y-3 text-slate-700">
            <li>• Des outils dispersés : tableurs, pages, formulaires, CRM, relances, rapports.</li><li>• Des dépenses publicitaires dont on ne sait pas ce qu'elles rapportent.</li>
            <li>• Des leads contactés trop tard, ou jamais.</li><li>• Des décisions prises à l'intuition, faute de données fiables.</li></ul></div>
        <div id="solution"><h2 className="text-2xl font-bold sm:text-3xl">La solution</h2>
          <p className="mt-4 text-slate-700">SEA Pilot relie chaque étape, du premier clic au client signé. Chaque lead garde sa campagne, sa source et ses paramètres UTM ; chaque euro dépensé est rapproché des leads et du chiffre d'affaires ; chaque recommandation s'appuie sur une preuve chiffrée.</p></div>
      </section>

      <section id="fonctionnement" className="bg-slate-50 px-4 py-14 scroll-mt-16" aria-labelledby="fonc-h">
        <div className="mx-auto max-w-6xl"><h2 id="fonc-h" className="text-center text-2xl font-bold sm:text-3xl">Comment ça marche</h2>
          <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{STEPS.map(([t, d], i) => <li key={t} className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-xs font-bold text-brand-600">ÉTAPE {i + 1}</p><p className="font-semibold">{t}</p><p className="text-sm text-slate-600">{d}</p></li>)}</ol></div>
      </section>

      <section id="fonctionnalites" className="mx-auto max-w-6xl px-4 py-14 scroll-mt-16" aria-labelledby="feat-h">
        <h2 id="feat-h" className="text-center text-2xl font-bold sm:text-3xl">Fonctionnalités</h2>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{FEATURES.map(([t, d]) => <li key={t} className="rounded-xl border border-slate-200 p-5"><p className="font-semibold">{t}</p><p className="mt-1 text-sm text-slate-600">{d}</p></li>)}</ul>
      </section>

      <section className="bg-brand-600 px-4 py-14 text-white" aria-labelledby="ia-h">
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-2">
          <div><h2 id="ia-h" className="text-2xl font-bold sm:text-3xl">Une IA utile, honnête et encadrée</h2>
            <p className="mt-3 opacity-95">La qualification distingue ce que le prospect a déclaré de ce que l'IA infère. Le Copilot répond à partir de vos données réelles et signale ce qui manque. Les clés des fournisseurs d'IA restent côté serveur ; chaque appel est journalisé avec son coût estimé.</p></div>
          <ul className="space-y-2 text-sm">
            <li className="rounded-lg bg-white/10 p-3">✓ Score, raisons, informations manquantes et prochaine action</li><li className="rounded-lg bg-white/10 p-3">✓ Faits fournis séparés des inférences</li>
            <li className="rounded-lg bg-white/10 p-3">✓ Plusieurs fournisseurs : OpenAI, Anthropic, Gemini</li><li className="rounded-lg bg-white/10 p-3">✓ Quotas et limites contre les abus et les coûts</li></ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14" aria-labelledby="an-h">
        <h2 id="an-h" className="text-center text-2xl font-bold sm:text-3xl">Des analytics qui répondent à une seule question</h2>
        <p className="mx-auto mt-3 max-w-2xl text-center text-slate-700">« Est-ce que mon acquisition fonctionne ? » Dépenses, CTR, CPC, leads, CPL, conversion, clients, CAC, chiffre d'affaires, ROAS et ROI, avec une santé 🟢 🟠 🔴 calculée sur vos objectifs.</p>
        <div className="mt-6 text-center"><Link href="/demo" className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-5 font-semibold hover:bg-slate-50">Explorer la démo (données fictives)</Link></div>
      </section>

      <section id="tarifs" className="bg-slate-50 px-4 py-14 scroll-mt-16" aria-labelledby="pr-h">
        <div className="mx-auto max-w-6xl"><h2 id="pr-h" className="text-center text-2xl font-bold sm:text-3xl">Tarifs</h2>
          <p className="mx-auto mt-2 max-w-xl text-center text-sm text-slate-600">{env.trialDays} jours d'essai gratuit sur tous les plans. Les tarifs sont affichés lors de la souscription.</p>
          <ul className="mt-8 grid gap-4 lg:grid-cols-3">{PLAN_IDS.map((id) => { const p = PLANS[id]; return (
            <li key={id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6"><h3 className="text-xl font-bold">{p.name}</h3><p className="mt-1 text-sm text-slate-600">{p.tagline}</p>
              <p className="mt-3 font-semibold">{env.planPriceLabel(id) ?? "Essai gratuit puis tarif à la souscription"}</p>
              <ul className="mt-4 flex-1 list-disc space-y-1 pl-5 text-sm">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
              <Link href="/register" className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-brand-600 px-4 font-semibold text-white hover:bg-brand-700">Commencer gratuitement</Link></li>); })}</ul></div>
      </section>

      <section id="faq" className="mx-auto max-w-3xl px-4 py-14 scroll-mt-16" aria-labelledby="faq-h">
        <h2 id="faq-h" className="text-center text-2xl font-bold sm:text-3xl">Questions fréquentes</h2>
        <div className="mt-6 divide-y divide-slate-200 rounded-xl border border-slate-200">{FAQ.map(([q, a]) => <details key={q} className="p-4"><summary className="cursor-pointer font-semibold">{q}</summary><p className="mt-2 text-slate-700">{a}</p></details>)}</div>
      </section>

      <section className="bg-ink px-4 py-14 text-center text-white">
        <h2 className="text-2xl font-bold sm:text-3xl">Prêt à savoir ce que vos campagnes rapportent ?</h2>
        <Link href="/register" className="mt-6 inline-flex min-h-12 items-center rounded-lg bg-white px-6 text-base font-semibold text-ink hover:bg-slate-100">Commencer gratuitement</Link>
      </section>
    </>
  );
}
