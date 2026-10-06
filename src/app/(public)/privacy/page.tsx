import type { Metadata } from "next";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Politique de confidentialité", description: "Comment SEA Pilot collecte, utilise et protège vos données personnelles et celles de vos prospects.", alternates: { canonical: "/privacy" } };

export default function PrivacyPage() {
  const who = env.legalEntity;
  const mail = env.legalContactEmail;
  return (
    <article className="mx-auto max-w-3xl px-4 py-10 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-bold [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 text-slate-800">
      <h1 className="text-3xl font-extrabold">Politique de confidentialité</h1>
      <p className="text-sm text-slate-500">Dernière mise à jour : 6 octobre 2026</p>

      <h2>1. Qui est responsable de vos données ?</h2>
      <p>Pour les données de votre compte et de votre utilisation du service, le responsable de traitement est {who}{mail ? <> — contact : <a className="underline" href={`mailto:${mail}`}>{mail}</a></> : ""}.</p>
      <p>Pour les données de vos <strong>prospects et clients</strong> que vous saisissez ou collectez avec SEA Pilot (leads, formulaires, conversations), c'est <strong>vous</strong>, l'entreprise qui utilise SEA Pilot, qui êtes responsable de traitement ; {who} agit comme sous-traitant et ne traite ces données que pour fournir le service, selon vos instructions.</p>

      <h2>2. Données traitées</h2>
      <ul>
        <li><strong>Compte :</strong> nom, adresse e-mail, mot de passe (stocké sous forme hachée), langue, dates de connexion.</li>
        <li><strong>Espace de travail :</strong> informations d'entreprise, offres, audiences, campagnes, landing pages, objectifs, paramètres.</li>
        <li><strong>Leads :</strong> nom, e-mail, téléphone, entreprise, message, réponses au formulaire, source et paramètres UTM, preuve de consentement (texte, date), adresse IP pseudonymisée (empreinte non réversible), échanges, notes, qualification.</li>
        <li><strong>Mesure d'audience des landing pages :</strong> pages vues et clics, identifiant de session propre à l'onglet, URL de provenance et paramètres UTM. Aucune adresse IP n'est stockée avec ces événements et aucun cookie n'est déposé.</li>
        <li><strong>Journaux techniques et d'audit :</strong> actions importantes (connexion, modifications, exports), sans données sensibles.</li>
      </ul>

      <h2>3. Finalités et bases légales</h2>
      <ul>
        <li>Fournir le service (exécution du contrat) : création de compte, gestion des campagnes, des leads, de l'analytique et de la facturation.</li>
        <li>Sécurité et prévention des abus (intérêt légitime) : limitation de débit, journal d'audit.</li>
        <li>Communication sur le service (intérêt légitime / contrat) : réinitialisation de mot de passe, notifications.</li>
        <li>Pour les prospects : les e-mails de relance ne sont envoyés qu'avec leur consentement explicite, avec lien de désinscription dans chaque message.</li>
      </ul>

      <h2>4. Destinataires et sous-traitants</h2>
      <p>Vos données ne sont pas vendues. Selon les fonctions que vous activez, elles peuvent être transmises à : l'hébergeur de l'application et de la base de données ; le fournisseur d'IA choisi pour le serveur (OpenAI, Anthropic ou Google) lorsque vous utilisez une fonction IA — seul le contenu nécessaire à la demande est envoyé ; le fournisseur d'e-mail que vous connectez ; Stripe pour le paiement des abonnements ; les plateformes publicitaires que vous connectez (Meta, Google, TikTok). Ces fonctions sont désactivées tant qu'elles ne sont pas configurées.</p>

      <h2>5. Durée de conservation</h2>
      <p>Les données de l'espace sont conservées tant que le compte est actif. Vous pouvez à tout moment supprimer un prospect, tout l'espace de travail ou votre compte : les données sont alors effacées. Les journaux d'audit liés à un espace supprimé sont dissociés de celui-ci. Les données de facturation peuvent être conservées pendant la durée légale.</p>

      <h2>6. Vos droits</h2>
      <p>Vous disposez des droits d'accès, de rectification, d'effacement, de limitation, d'opposition et de portabilité. Depuis <em>Réglages → Confidentialité</em>, vous pouvez exporter vos données (JSON) et supprimer votre compte ou votre espace. Les personnes dont vous collectez les données (vos prospects) doivent s'adresser à vous ; la fiche du prospect permet de le désinscrire et d'effacer ses données. Vous pouvez aussi nous écrire{mail ? <> à <a className="underline" href={`mailto:${mail}`}>{mail}</a></> : ""} et, le cas échéant, saisir votre autorité de protection des données.</p>

      <h2>7. Cookies</h2>
      <p>SEA Pilot utilise un seul cookie d'authentification (session, « httpOnly »), strictement nécessaire au fonctionnement, ainsi qu'un cookie de préférence d'espace de travail. Aucun cookie publicitaire ou de suivi n'est utilisé par SEA Pilot. Les landing pages que vous publiez ne déposent pas de cookie ; si vous y ajoutez vous-même des outils tiers, il vous appartient d'obtenir le consentement requis.</p>

      <h2>8. Sécurité</h2>
      <p>Chiffrement des échanges (HTTPS), mots de passe hachés, identifiants d'intégration chiffrés, isolation stricte des données par espace de travail, contrôle d'accès par rôle, limitation de débit, journal d'audit.</p>

      <h2>9. Vos obligations en tant qu'utilisateur</h2>
      <p>Vous vous engagez à informer vos prospects de l'usage de leurs données, à recueillir leur consentement avant toute prospection électronique lorsque la loi l'exige et à respecter leurs demandes de désinscription et d'effacement.</p>

      <h2>10. Modifications</h2>
      <p>Cette politique peut évoluer ; la date de mise à jour figure en haut de page.</p>
    </article>
  );
}
