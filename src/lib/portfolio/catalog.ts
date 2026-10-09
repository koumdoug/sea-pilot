// Fiches initiales des trois SaaS du portefeuille, issues de l'audit du 2026-10-09 (code local, README, Railway, pages publiques).
// Règle : rien n'est inventé. Ce qui n'est pas vérifié est listé dans `unconfirmed` et reste « à confirmer ».
// `verified: true` = présent dans le code audité ; cela ne prouve PAS un fonctionnement en production.

export type ProductFeature = { text: string; verified: boolean; note?: string };
export type ProductPlan = { name: string; amount: number | null; currency: string | null; interval: "month" | "year" | null; verified: boolean };
export type ProductPricing = { plans: ProductPlan[]; note?: string };
export type ProductArgument = { text: string; approved: boolean };
export type ProductObjection = { objection: string; answer: string; approved: boolean };

export type ProductDraft = {
  slug: string; name: string; tagline: string; description: string; valueProposition: string; targetCustomers: string;
  problemsSolved: string[]; features: ProductFeature[]; pricing: ProductPricing;
  publicUrl: string | null; signupUrl: string | null; demoUrl: string | null;
  salesArguments: ProductArgument[]; objections: ProductObjection[]; channels: string[]; qualification: string[];
  unconfirmed: string[]; status: "preparation" | "validation" | "commercialisation" | "suspended";
};

export const DEFAULT_PRODUCTS: ProductDraft[] = [
  {
    slug: "driverpilot",
    name: "DriverPilot",
    tagline: "Logiciel de gestion pour chauffeurs indépendants et petites flottes.",
    description: "Suivi des revenus, dépenses, rentabilité, véhicules, documents et rapports pour chauffeurs Uber, Lyft et autres plateformes.",
    valueProposition: "Connaître son bénéfice réel après commissions et frais, et ne manquer aucune échéance de document.",
    targetCustomers: "Chauffeurs indépendants (Uber, Lyft, taxi), chauffeurs multi-plateformes, gestionnaires de quelques véhicules.",
    problemsSolved: ["Revenus et dépenses dispersés", "Bénéfice réel inconnu après commissions et frais", "Documents (permis, assurance) à renouveler"],
    features: [
      { text: "Revenus avec calcul du net (brut − commission + pourboires + bonus)", verified: true },
      { text: "Dépenses par catégorie", verified: true },
      { text: "Calculateur de rentabilité par chauffeur (par course, heure, km)", verified: true },
      { text: "Gestion des chauffeurs et des véhicules", verified: true },
      { text: "Documents avec alertes d'échéance (30/15/7 jours)", verified: true },
      { text: "Calendrier et notifications", verified: true },
      { text: "Rapports exportables CSV et PDF", verified: true },
      { text: "Import automatique des courses Uber/Lyft", verified: false, note: "NON disponible : saisie manuelle" },
      { text: "Envoi de courriels (mot de passe oublié)", verified: false, note: "Aucun fournisseur de courriel branché d'après le README" },
    ],
    pricing: {
      plans: [
        { name: "Solo", amount: 9.99, currency: null, interval: "month", verified: false },
        { name: "Solo", amount: 89, currency: null, interval: "year", verified: false },
        { name: "Flotte", amount: 29.99, currency: null, interval: "month", verified: false },
        { name: "Flotte", amount: 269, currency: null, interval: "year", verified: false },
      ],
      note: "Montants lus dans le code de la page /pricing ; devise et prix Stripe réels à confirmer. Essai gratuit de 30 jours d'après le code.",
    },
    publicUrl: "https://www.driverpilotapp.com", signupUrl: "https://www.driverpilotapp.com/register", demoUrl: null,
    salesArguments: [], objections: [],
    channels: ["social", "email", "linkedin", "phone"],
    qualification: ["Chauffeur actif ou gestionnaire d'au moins un véhicule", "Utilise une ou plusieurs plateformes de transport", "Besoin exprimé de suivi des revenus, dépenses ou documents"],
    unconfirmed: ["Devise des tarifs", "Correspondance avec les prix Stripe réels", "Mode Stripe (test ou réel) et paiement de bout en bout", "Pages légales (confidentialité, conditions)", "Envoi de courriel", "Arguments et réponses aux objections approuvés"],
    status: "validation",
  },
  {
    slug: "freelancenexa",
    name: "FreelanceNexa",
    tagline: "Le cockpit administratif des travailleurs indépendants.",
    description: "Revenus, dépenses, clients, factures et profit réel du mois pour freelances et travailleurs autonomes.",
    valueProposition: "Voir son profit réel du mois et ce qu'il faut mettre de côté pour les taxes, au même endroit que ses clients et factures.",
    targetCustomers: "Freelances, consultants indépendants, prestataires de services, travailleurs autonomes.",
    problemsSolved: ["Revenus, dépenses et factures éparpillés", "Profit réel du mois inconnu", "Estimation de la mise de côté pour les taxes"],
    features: [
      { text: "Clients, revenus, dépenses et factures (montant, statut, échéance)", verified: true },
      { text: "Tableau de bord : profit réel du mois et variation", verified: true },
      { text: "Estimation de mise de côté pour les taxes (taux fixe de 25 %)", verified: true },
      { text: "Essai gratuit de 30 jours puis accès par abonnement", verified: true },
      { text: "Envoi de courriels, mot de passe oublié, connexion bancaire", verified: false, note: "NON disponible d'après le README" },
    ],
    pricing: { plans: [], note: "Un seul Payment Link Stripe ; le prix n'est pas confirmé (le README indique qu'il n'est pas défini côté Stripe)." },
    publicUrl: "https://web-production-49e53.up.railway.app", signupUrl: "https://web-production-49e53.up.railway.app/register", demoUrl: null,
    salesArguments: [], objections: [],
    channels: ["social", "linkedin", "email"],
    qualification: ["Travailleur autonome avec plusieurs clients", "Facture ses clients lui-même", "Cherche à suivre profit et taxes"],
    unconfirmed: ["Prix et formule d'abonnement", "Domaine freelancenexa.com (DNS non relié à l'application)", "Page de présentation publique", "Pages légales", "Arguments et réponses aux objections approuvés"],
    status: "preparation",
  },
  {
    slug: "operapilot",
    name: "OperaPilot",
    tagline: "Assistant d'opérations : transforme notes et informations en tâches, suivis et brouillons à valider.",
    description: "Une note (texte ou vocale) est structurée en intervention, tâches, facture brouillon et message brouillon ; l'humain valide.",
    valueProposition: "Réduire l'administratif des équipes de terrain en structurant les notes, avec validation humaine avant tout document.",
    targetCustomers: "Petites entreprises de services et équipes opérationnelles ; entrepreneurs qui gèrent notes, demandes, tâches et suivis.",
    problemsSolved: ["Notes de terrain non structurées", "Tâches et suivis oubliés", "Factures et messages à préparer à la main"],
    features: [
      { text: "Flux note → extraction → validation → tâches, facture brouillon, message brouillon", verified: true, note: "Testé avec une IA SIMULÉE (mock), pas de l'IA réelle" },
      { text: "Isolation entre entreprises", verified: true },
      { text: "Connecteurs IA réels (OpenAI, Claude, transcription)", verified: false, note: "Code écrit, non testé" },
      { text: "Envoi réel courriel/SMS, PDF de facture, invitations, mot de passe oublié", verified: false, note: "Non implémenté" },
    ],
    pricing: { plans: [], note: "Aucun tarif ni abonnement." },
    publicUrl: null, signupUrl: null, demoUrl: null,
    salesArguments: [], objections: [],
    channels: ["linkedin", "email", "phone"],
    qualification: ["Entreprise de services avec techniciens ou équipes terrain", "Tâches administratives répétitives après intervention", "Disposée à participer à un projet pilote"],
    unconfirmed: ["Déploiement en production (aucun)", "IA réelle jamais testée", "Facturation et abonnement (absents)", "Tarifs", "Arguments et réponses aux objections approuvés"],
    status: "preparation",
  },
];
