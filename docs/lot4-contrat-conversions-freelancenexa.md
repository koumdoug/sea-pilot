# Contrat d'intégration : FreelanceNexa → SEA Pilot (conversions réelles)

À réaliser **dans le dépôt FreelanceNexa** (hors de ce lot ; ce dépôt a des changements non commités sur le webhook Stripe : intégrer après leur commit).
SEA Pilot expose déjà `POST /api/v1/product-events` (`src/app/api/v1/product-events/route.ts`) : idempotente, limitée à 60 requêtes/minute par clé. **Aucun produit ne l'appelle aujourd'hui.**

## Authentification
`Authorization: Bearer sp_…` — clé créée dans SEA Pilot (Paramètres → Clés API) et stockée chez FreelanceNexa dans une variable d'environnement (jamais dans le code ni les journaux).

## Événements à transmettre (produit : `freelancenexa`)
| Moment réel | `type` | Données minimales | `external_ref` (idempotence) |
|---|---|---|---|
| Création de compte réussie | `signup` | `email` | identifiant de l'organisation |
| Début de l'essai (créé à l'inscription) | `trial_started` | `email` | identifiant de l'organisation |
| Paiement d'abonnement confirmé par Stripe (webhook vérifié) | `payment_confirmed` | `amount` > 0, `currency` = devise Stripe (ex. `CAD`), `email` si connu | identifiant de facture ou d'événement Stripe |
| Abonnement résilié | `cancellation` | `email` | identifiant d'abonnement |
`occurred_at` (ISO 8601) = date réelle de l'événement. Aucun événement n'est émis pour un simple lead.

## Règles
- Appel après succès de l'action métier, **sans jamais la bloquer** (délai court, échec journalisé, pas de nouvelle tentative bloquante).
- Aucune donnée personnelle au-delà du courriel ; aucun mot de passe, jeton ou donnée financière.
- Un paiement exige montant et devise (sinon SEA Pilot répond 422).
## Limites connues côté SEA Pilot
- L'événement est rattaché à un **prospect** retrouvé par courriel, pas à un **lead entrant** (`ProductEvent` n'a pas de `leadId`). Un lead de landing page qui s'inscrit ensuite n'est donc pas relié automatiquement à son inscription : le rapport compare des comptages, pas une cohorte. Relier lead → inscription exige une colonne (migration), non réalisée dans ce lot.
## Validation (quand l'intégration existera)
Événement test avec clé de test → 201 ; même `external_ref` rejoué → 200 `created:false` ; paiement sans devise → 422 ; clé révoquée → 401 ; l'événement apparaît dans le rapport du produit avec l'origine « reçu du produit ».
