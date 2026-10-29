# FreelanceNexa — ce qui est établi, et ce qui ne l'est pas (Lot 4, 2026-10-27)

## Sources consultées
- Dépôt officiel local **`E:\Document CODE\FreelancePilot`** (package `freelancenexa` 0.1.0, ancien nom FreelancePilot) : `README.md`, `.env.example` (noms de variables seulement),
  structure `src/`, `src/lib/trial.ts`, `src/app/(dashboard)/abonnement/page.tsx`, `src/components/ui.tsx`. Aucun fichier `.env` ouvert ; aucune commande exécutée dans ce dépôt.
  Il contient des changements non commités (webhook Stripe, `stripe-events`) qui ne sont pas de ce lot : **non touchés**.
- Pages publiques en lecture : `https://freelancenexa.com` et `https://web-production-49e53.up.railway.app` (accueil et `/register`), consultées une fois.
- Non utilisée : la page `freelancenexa-com.codunk.site` (artefact distinct, aucune preuve de fonctionnement du produit).

## Statut par fonctionnalité
| Élément | Statut | Preuve |
|---|---|---|
| Inscription / connexion (JWT, multi-organisation) | présente dans le code ; formulaire d'inscription observé en ligne (nom de l'activité, nom, courriel, mot de passe) ; **non exécutée par moi** | README, `register/page.tsx`, page `/register` |
| Clients, revenus, dépenses, factures (montant, statut, échéance) | présentes dans le code, non exécutées | README, routes `src/app/api/*`, tests du dépôt (non lancés) |
| Tableau de bord : profit du mois, variation, mise de côté pour taxes à 25 % | présent dans le code, non exécuté | `api/dashboard/route.ts` (`TAUX_MISE_DE_COTE_DEFAUT = 0.25`), libellé « à affiner selon ton régime fiscal » |
| Montants affichés en **CAD** | vérifié dans le code | `formatCurrency` : `fr-CA`, `CAD` |
| Essai gratuit de 30 jours, puis accès par abonnement | présent dans le code (`trial.ts`), non exécuté ; la page d'inscription publique **ne le mentionne pas** | README, `trial.ts` |
| Abonnement Stripe (Payment Link + webhook) | code présent ; **prix non défini côté Stripe d'après le README** ; lien de paiement non configuré par défaut | README « Mise en ligne », `.env.example` |
| Tarif « 19,99 CAD/mois » | **non confirmé** : aucun montant dans le code ni le README | — |
| E-mails, mot de passe oublié, connexion bancaire, OAuth | **absents** (README) | README |
| Pages légales (confidentialité, conditions) | **absentes** sur le produit (aucun lien sur l'accueil ni l'inscription observés) | pages publiques |
| Domaine `freelancenexa.com` relié à l'application | le README dit non relié ; une consultation a montré la page de connexion de l'application : **état à confirmer** | README, consultation |
| Version anglaise du produit | aucune observée | — |

La landing page n'affiche donc **aucun tarif**, ne promet aucun résultat, n'invente aucune preuve.
