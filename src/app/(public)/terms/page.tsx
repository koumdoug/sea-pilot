import type { Metadata } from "next";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Conditions d'utilisation", description: "Conditions générales d'utilisation du service SEA Pilot.", alternates: { canonical: "/terms" } };

export default function TermsPage() {
  const who = env.legalEntity;
  const mail = env.legalContactEmail;
  return (
    <article className="mx-auto max-w-3xl px-4 py-10 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-bold [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 text-slate-800">
      <h1 className="text-3xl font-extrabold">Conditions d'utilisation</h1>
      <p className="text-sm text-slate-500">Dernière mise à jour : 6 octobre 2026</p>

      <h2>1. Objet</h2>
      <p>SEA Pilot est un service en ligne d'acquisition et d'automatisation marketing édité par {who}. Les présentes conditions encadrent l'utilisation du service par toute entreprise ou professionnel qui crée un compte.</p>

      <h2>2. Compte et espace de travail</h2>
      <p>Vous êtes responsable de l'exactitude des informations fournies, de la confidentialité de vos identifiants et des actions réalisées depuis votre compte et par les membres que vous invitez. L'espace de travail est isolé : seuls ses membres y accèdent.</p>

      <h2>3. Essai, abonnement et paiement</h2>
      <p>Un essai gratuit est proposé à l'inscription, sans carte bancaire. À son terme, l'accès aux fonctions est suspendu tant qu'un plan payant n'est pas souscrit ; vos données restent conservées et vos pages publiques continuent d'enregistrer les leads reçus. Les abonnements sont facturés par l'intermédiaire de Stripe, se renouvellent automatiquement et peuvent être résiliés à tout moment depuis la page Facturation ; la résiliation prend effet à la fin de la période payée. Les prix sont ceux affichés lors de la souscription.</p>

      <h2>4. Utilisation acceptable</h2>
      <ul>
        <li>Respecter les lois applicables, notamment en matière de protection des données et de prospection électronique.</li>
        <li>N'envoyer des e-mails commerciaux qu'à des personnes y ayant consenti, quand la loi l'exige, et honorer toute demande de désinscription.</li>
        <li>Ne pas utiliser le service pour du spam, des contenus illicites, trompeurs ou portant atteinte aux droits de tiers.</li>
        <li>Ne pas tenter de contourner les limites techniques, d'accéder aux données d'autres espaces ou de perturber le service.</li>
      </ul>

      <h2>5. Contenus générés par l'IA</h2>
      <p>Les fonctions d'IA produisent des propositions (textes, analyses, hypothèses) qui peuvent contenir des erreurs. Elles sont identifiées comme générées par l'IA et ne constituent ni des faits vérifiés, ni des conseils juridiques, financiers ou d'investissement. Vous restez responsable de la relecture et de l'usage que vous en faites, y compris de la conformité de vos publicités aux règles des plateformes.</p>

      <h2>6. Vos données</h2>
      <p>Vous restez propriétaire de vos données et de celles de vos prospects. Nous les traitons pour fournir le service, conformément à la <a className="underline" href="/privacy">politique de confidentialité</a>. Vous pouvez exporter et supprimer vos données à tout moment.</p>

      <h2>7. Intégrations tierces</h2>
      <p>Les connexions à des services tiers (plateformes publicitaires, e-mail, paiement) dépendent de leur disponibilité et de leurs conditions propres. Une intégration non configurée est signalée comme telle dans l'application.</p>

      <h2>8. Disponibilité et responsabilité</h2>
      <p>Nous mettons en œuvre des moyens raisonnables pour assurer un service continu et sécurisé, sans garantie d'absence d'interruption. Dans la limite permise par la loi, notre responsabilité est limitée aux dommages directs et ne peut excéder les sommes payées au titre des douze derniers mois. Nous ne garantissons aucun résultat commercial.</p>

      <h2>9. Suspension et résiliation</h2>
      <p>Vous pouvez supprimer votre compte à tout moment. Nous pouvons suspendre un compte en cas de manquement grave aux présentes conditions, après information lorsque c'est possible.</p>

      <h2>10. Modifications et droit applicable</h2>
      <p>Les conditions peuvent évoluer ; les changements significatifs vous seront signalés. Le droit applicable et la juridiction compétente sont ceux du pays du siège de {who}.</p>

      {mail && <p>Contact : <a className="underline" href={`mailto:${mail}`}>{mail}</a></p>}
    </article>
  );
}
