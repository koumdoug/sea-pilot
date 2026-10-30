# Fiabilisation Stripe avant préproduction (V1 à V11)

Complète [stripe-entitlements-security.md](stripe-entitlements-security.md) (architecture D1 à D5). Ne contient aucune valeur de configuration ni secret.

## 1. Vue d'ensemble

| Réf. | Défaut constaté | Mécanisme retenu | Où |
|---|---|---|---|
| V1 | La réconciliation ignorait les abonnements localement `canceled` / `expired` | Sélection élargie (terminés relus 1 fois par jour pendant 90 jours) ; décision toujours tirée de l'état relu chez Stripe | `reconcileWhere`, `reconcileDueSubscriptions` |
| V2 | `stripeSyncedAt` pris après la lecture : une lecture lente et ancienne pouvait écraser une lecture récente | Bail d'exclusion par abonnement + jeton de clôture (voir § 2) | `acquireSyncLease`, `applyRemoteSubscription` |
| V3 | `unpaid` conservait l'accès | Statut local `unpaid` : accès suspendu, abonnement gérable (voir § 3) | `STATUS_MAP`, `entitlement()` |
| V4 | Double paiement possible si une session payée n'était plus consultée | Réservation exclusive AVANT les vérifications ; lecture des abonnements et sessions du client chez Stripe (voir § 4) | `createCheckoutSession` |
| V5 | Marge de 1 minute sur le minimum d'expiration imposé par Stripe | Session de 40 minutes, réservation locale +5 minutes | `checkoutExpiry` |
| V6 | Réconciliation en série sans budget de temps | Budget, disjoncteur, reprise, résultat honnête (voir § 5) | route cron, `reconcileDueSubscriptions` |
| V7 | Synchronisation des intégrations sans contrôle de forfait | Droit de synchroniser distinct de la connexion et des données (voir § 6) | `integrationSyncAllowance`, `listSyncableIntegrations` |
| V8 | Écriture conditionnelle incomplète (instantané local ancien écrasant des modifications) | État local relu avant l'écriture ; écriture conditionnelle à `updatedAt` ET au bail (traité avec V2) | `applyRemoteSubscription` |
| V9 | Registre sans purge ; revue manuelle invisible ; statuts non pris en charge | Purge (processed 90 j, failed 180 j, jamais `processing`) ; alerte au propriétaire (30 j) ; événements `paused` / `resumed` | `purgeStripeEvents`, `billingNeedsReview` |
| V10 | Clé d'idempotence client constante pendant 24 h | Clé = espace + empreinte de l'e-mail | `customerIdempotencyKey` |
| V11 | Message trompeur quand la limite d'intégrations est atteinte après autorisation du fournisseur | `IntegrationLimitError` → `error=limit` ; contrôle inchangé | callback OAuth |

## 2. V2 — pourquoi un bail, et pas un horodatage

Le besoin : une synchronisation ne doit jamais écrire un état plus ancien que celui déjà écrit.

| Approche | Garantie réelle | Verdict |
|---|---|---|
| Horodatage pris après la lecture (état initial) | Aucune : l'ordre de FIN des lectures n'est pas l'ordre des états | Défectueux |
| Horodatage pris avant la lecture | Dépend de l'horloge locale ; une requête partie plus tôt peut être traitée plus tard par Stripe | Insuffisant (horloge = seule garantie) |
| Numéro de génération pris avant la lecture | Ordre de DÉBUT garanti par la base, mais pas l'ordre de traitement chez Stripe ; une lecture écartée peut perdre un état plus récent | Meilleur, résiduel non nul |
| Verrou de ligne tenu pendant l'appel Stripe | Garantie stricte, mais une transaction et une connexion restent ouvertes jusqu'à 25 s (épuisement du pool, écritures bloquées sur la ligne) | Écarté |
| **Bail en base (UPDATE conditionnel) + jeton de clôture** | Deux lectures du même abonnement ne se chevauchent jamais ; une lecture commence après la validation de la précédente ; un détenteur dépossédé ne peut plus écrire ; aucune connexion tenue pendant l'appel | **Retenu** |

Détails : bail de 90 s (supérieur à deux lectures de 25 s) ; attente de 10 s au plus (webhook) puis `SyncBusyError` (l'événement est repris par Stripe) ; l'horloge décide seulement quand un bail abandonné peut être repris, la sûreté vient de l'écriture conditionnelle sur l'identifiant de bail. Entre la vérification du bail et l'écriture (fenêtre étroite), la clause `WHERE` porte le jeton : couvert par un test dédié. L'écriture porte aussi `updatedAt` (V8).

Limite assumée : un bail dépassé par un processus gelé fait perdre SA lecture (jamais un état plus récent) ; la lecture suivante reprend.

## 3. V3 — table des statuts Stripe

| Statut Stripe | Statut local | Accès | Gestion (portail, résiliation) | Remarque |
|---|---|---|---|---|
| `active` | `active` | oui | oui | `cancel_at_period_end` : accès jusqu'à la fin exacte de la période payée |
| `trialing` | `active` | oui | oui | essai Stripe, carte enregistrée par Checkout |
| `past_due` | `past_due` | oui (grâce de 7 jours après la fin de période) | oui | règle existante conservée (voir « Décisions ouvertes ») |
| `unpaid` | `unpaid` | **non**, immédiatement | oui (régulariser) | tous les essais ont échoué |
| `paused` | `unpaid` | **non** | oui | en pause faute de moyen de paiement ; reprise à la confirmation |
| `canceled` | `canceled` | non | non | annulation immédiate : plus d'accès |
| `incomplete` | `incomplete` | non (l'essai local valide est conservé) | non | aucun droit avant confirmation |
| `incomplete_expired` | `expired` | non | non | |

Transitions : tout statut est relu chez Stripe (jamais déduit d'un événement) ; `unpaid → active` à la confirmation du paiement ; un abonnement actif vérifié depuis moins de 3 jours après sa fin de période garde l'accès (délai de confirmation du renouvellement), au-delà seule la réconciliation le rétablit.

## 4. V4 / V5 — flux de souscription

1. Contrôles rapides : forfait connu, configuration Stripe complète, abonnement local non vivant, limites de rétrogradation.
2. **Réservation exclusive** (une requête SQL conditionnelle, valable entre serveurs). Une réservation active avec session : la session est lue (payée → refus, ouverte → expirée, expirée → reprise) puis reprise conditionnellement.
3. Sous la réservation : état local relu (contrôle « vivant » refait) ; si le client existe : liste de SES abonnements chez Stripe (+ l'abonnement lié localement). Actif, essai, en retard, impayé, en pause ou en attente → refus, état local réparé. Plusieurs → revue manuelle (audit, journal d'erreur, alerte au propriétaire), **aucune annulation ni remboursement automatique**. Stripe indisponible → refus.
4. Expiration de toute session encore ouverte du client ; une session payée interdit la suite.
5. Création de la session (clé d'idempotence = réservation), `expires_at` = 40 min ; stockage conditionnel à la réservation ; réservation reprise entre-temps → session expirée, jamais remise.
6. Libération de la réservation sur toute erreur ; `checkout.session.completed` / `expired` la libèrent aussi.

Durées : minimum Stripe 30 min → session 40 min (marge de 10 min : dérive d'horloge tolérée jusqu'à ±10 min) ; réservation = expiration distante + 5 min (jamais éteinte avant la session) ; bail d'avant-création 240 s (plusieurs appels Stripe de 25 s).

Réglage Stripe à vérifier en mode test : « Limit customers to one subscription » (réglage du compte) comme garde-fou supplémentaire côté Stripe.

## 5. V6 — tâche planifiée `/api/cron/followups`

Configuration attendue de l'ordonnanceur (non modifiée par cette mission) :

- Appel `POST` (ou `GET`) toutes les 5 à 15 minutes avec `Authorization: Bearer $CRON_SECRET` (variable obligatoire : sinon 503).
- `STRIPE_SECRET_KEY` définie pour que la réconciliation s'exécute (sinon `billing: {skipped: true, reason}` explicite).
- Paramètres : `sync=0`, `reconcile=0`, `purge=0`.
- Budget : 240 s au total (la route est coupée à 300 s), dont 90 s au plus pour la réconciliation ; aucune synchronisation n'est commencée si elle ne peut pas finir dans le budget.
- Réponse : `complete` est faux si un traitement a été différé, en échec ou occupé ; `billing` détaille `checked / updated / failed / busy / deferred / remaining / stoppedBy`.
- Passages concurrents : sans danger (réservation atomique des relances ; bail par abonnement pour Stripe).
- Une indisponibilité de Stripe n'a aucun effet sur les droits : après 3 échecs consécutifs le passage s'arrête, rien n'est marqué synchronisé, reprise automatique au passage suivant.
- Alerte conseillée côté exploitation : `complete: false` plusieurs passages de suite, ou journal `billing.reconcile_incomplete`.

## 6. V7 — synchronisation des intégrations

| Notion | Règle |
|---|---|
| Connexion OAuth conservée | Jamais supprimée par une rétrogradation ou un abonnement inactif |
| Synchronisation autorisée | Abonnement actif ET rang (par création) dans la limite d'intégrations du forfait ; propriétaire exempté : tout |
| Fonctionnalité autorisée | Création de connexion limitée par le forfait (D5, inchangé) |
| Données historiques | Conservées et consultables (analytics) ; jamais supprimées |
| Reprise | À la réactivation ou au retour du forfait, la synchronisation repart (aucun rattrapage manuel) |

La règle est appliquée dans `syncIntegration` (donc aux appels manuels) et par la tâche planifiée.

## 7. Clés API existantes — mesure et transition (non implémentées automatiquement)

La règle D5 (API réservée à Pro) rend inactives, sans les supprimer, les clés des espaces Starter et Growth. **Aucune donnée de production n'a été lue** : l'impact réel est inconnu.

**Mesure (lecture seule, à lancer après autorisation explicite, base visée par `DATABASE_URL`)** :

```bash
npx tsx --env-file=<fichier d'environnement de la base visée> scripts/report-api-keys.ts --read-only-confirmed
```

Sortie : par forfait, nombre de clés, clés actives, clés actives utilisées sur 30 jours, clients (espaces) concernés, dernière utilisation connue ; clients « concernés » = forfaits sans API (hors propriétaire exempté), clés actives. Aucun identifiant, préfixe, empreinte ni adresse n'est lu ni affiché.

**Stratégie de transition proposée (30 à 60 jours), à décider après la mesure :**

1. Aucun client concerné (ou aucune utilisation récente) : appliquer la règle telle quelle, avec un simple avis.
2. Clients utilisant réellement l'API : annonce par e-mail (≥ 30 jours avant), puis période de grâce de 30 à 60 jours pendant laquelle leurs clés actives continuent de fonctionner (drapeau de grâce par espace avec date de fin, lu par `authenticateApiRequest`, à développer), rappel à J-14 et J-3, extinction à la date annoncée (les clés restent révocables et refonctionnent au passage à Pro).
3. Alternative commerciale à évaluer : API incluse dès Growth (limite de clés à fixer par le propriétaire), ce qui supprime la rupture pour le milieu de gamme.

## 8. Différences SQLite / PostgreSQL

| Sujet | SQLite (tests par défaut) | PostgreSQL |
|---|---|---|
| Concurrence | Une seule connexion : toutes les requêtes sont sérialisées | Connexions parallèles, verrous de ligne réels |
| `UPDATE … WHERE` concurrent | Sérialisé | Le second attend le verrou puis réévalue la condition (READ COMMITTED) |
| Tri des NULL (`ORDER BY … ASC`) | NULL en premier | NULL en dernier (traité explicitement) |
| Détection de doublon | `P2002` | `P2002` (identique) |
| Migrations | `prisma db push` en test (l'historique `prisma/migrations` ne couvre pas 0002 à 0005) | `prisma migrate deploy`, migrations 0001 à 0005 |

Les garanties de concurrence sont donc validées par `npm run test:pg` (voir [validation-postgresql-stripe.md](validation-postgresql-stripe.md)).

## 9. Décisions métier encore ouvertes

- **Clés API existantes** : stratégie de transition (§ 7) et, éventuellement, API dès Growth.
- **Délai de grâce `past_due`** : 7 jours après la FIN de la période en cours. Stripe avance la période au renouvellement même si le prélèvement échoue : le client en retard dispose donc de la période suivante entière plus 7 jours, jusqu'au passage de Stripe en `unpaid`. Règle historique conservée ; à arbitrer (grâce comptée depuis le début de la période impayée, ce qui exigerait de stocker `current_period_start`).
- **Marge de 3 jours** après la fin d'une période payée avant fermeture sans confirmation (`RENEWAL_GRACE_MS`).
- **Grille tarifaire** : Starter 19 $ CA/mois, Growth 49 $ CA/mois, Pro 99 $ CA/mois ; hiérarchie technique Starter < Growth < Pro inchangée. **Aucun prix Stripe n'a été créé ni modifié** et aucun prix n'est écrit dans le code ; les montants se portent par les variables `STRIPE_PRICE_*`.
- **Support prioritaire** : non annoncé (aucun engagement de service).
- Forfaits du catalogue produit toujours non vérifiés (`verified: false`, devise absente) ; FreelanceNexa sans forfait.
