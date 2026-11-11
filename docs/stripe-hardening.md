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
- `STRIPE_SECRET_KEY` définie pour que la réconciliation s'exécute (sinon `billing: {skipped: true, reason}` explicite ; en mode essai sans abonnement lié c'est normal, avec des abonnements liés à Stripe voir « Stripe non configuré » ci-dessous).
- Paramètres `sync=0`, `reconcile=0`, `purge=0` : désactivent VOLONTAIREMENT l'étape correspondante. La réponse JSON et le journal `cron.summary` portent le champ top-level `disabledStages` : la liste des étapes ainsi désactivées, dans l'ordre fixe `sync`, `reconcile`, `purge` (liste vide si aucune). Ne pas le confondre avec `syncSkipped` (intégrations écartées par le forfait ou la limite d'intégrations, sans lien avec les paramètres).
  - `reconcile=0` : `billing = {skipped: true, reason: "désactivée par paramètre"}` et `complete: false`. La réconciliation est le filet de sécurité contre les événements Stripe perdus : son omission n'est jamais un succès. Cette désactivation garde la priorité : le contrôle « Stripe non configuré » n'est pas effectué.
  - `sync=0` et `purge=0` : `complete` est inchangé (simples commodités, sans effet sur les droits des clients) ; l'omission reste visible dans `disabledStages` (et, pour la purge, `ledgerPurged: {skipped: true}`).
- Stripe non configuré (`STRIPE_SECRET_KEY` absente), hors `reconcile=0` :
  - **Mode essai** (aucun abonnement n'a d'identifiant Stripe) : mode pris en charge, `billing: {skipped: true, reason: "Stripe non configuré"}` et `complete` inchangé.
  - **Abonnements liés sans clé Stripe** (au moins un abonnement avec un identifiant Stripe) : configuration probablement accidentelle. `billing: {skipped: true, reason: "Stripe non configuré", linkedSubscriptions: n}`, `complete: false`, et journal d'erreur `cron.stripe_not_configured_with_subscriptions` (`{count}`). Aucune réconciliation n'a lieu tant que la clé est absente : la restaurer.
  - **Contrôle impossible** (erreur de base pendant le comptage) : `linkedSubscriptions: null` (inconnu), `complete: false` et journal d'erreur `cron.stripe_not_configured_check_failed`. Jamais de succès affiché sans le contrôle. Aucune requête n'est faite quand Stripe est configuré ou que `reconcile=0`.
- Budget : 240 s au total (la route est coupée à 300 s), dont 90 s au plus pour la réconciliation ; aucune synchronisation n'est commencée si elle ne peut pas finir dans le budget.
- Réponse : `complete` est faux si un traitement a été différé, en échec ou occupé ; `billing` détaille `checked / updated / failed / busy / deferred / remaining / stoppedBy`.
- Passages concurrents : sans danger (réservation atomique des relances ; bail par abonnement pour Stripe).
- Une indisponibilité de Stripe n'a aucun effet sur les droits : après 3 échecs consécutifs le passage s'arrête, rien n'est marqué synchronisé, reprise automatique au passage suivant.
- Alerte conseillée côté exploitation : `complete: false` plusieurs passages de suite, ou journal `billing.reconcile_incomplete`.
- **Signification de `complete`** : vrai seulement si les relances ne sont ni différées ni en échec, la synchronisation des intégrations n'est ni différée ni en échec de plan, la réconciliation n'a pas été désactivée par `reconcile=0`, Stripe n'est pas absent alors que des abonnements y sont liés, et le compte rendu de réconciliation est lui-même complet (aucun échec, abonnement occupé, report, revue de prix ouverte ou compteur inconnu). `sync=0` et `purge=0` n'enlèvent pas `complete` ; `reconcile=0` l'enlève. `complete: false` ne dit pas pourquoi : lire `disabledStages`, `billing.reason` / `billing.linkedSubscriptions` et les compteurs.
- **Journaux de la tâche et de la réconciliation** :
  - `billing.price_reviews_unavailable` (erreur) : le calcul des revues « prix inconnu » ouvertes a échoué. Les compteurs durables valent `null`, `reviewCountersAvailable` vaut `false`, le passage n'est pas `complete` ; le compte rendu du passage est conservé. Action : vérifier l'accès à la table d'audit ; le passage suivant recalcule.
  - `billing.reconcile_trace_failed` (erreur) : l'écriture de la revue d'un prix inconnu (date de lecture + trace d'audit) a échoué sur un abonnement. Aucun état n'a changé, l'abonnement reste candidat, le passage compte un échec sans alimenter le disjoncteur « Stripe indisponible ». Action : vérifier la base.
  - `cron.stripe_not_configured_with_subscriptions` (erreur, `{count}`) et `cron.stripe_not_configured_check_failed` (erreur) : voir « Stripe non configuré » ci-dessus.
- **Compteurs `null` et consommateurs JSON externes** : `billing.openPriceReviews` et `billing.unlinkedPriceReviews` valent `null` quand ils sont inconnus (jamais 0) et `billing.reviewCountersAvailable` vaut alors `false` ; `billing.linkedSubscriptions` vaut `null` quand le contrôle est impossible. Précautions : tester `reviewCountersAvailable` avant toute règle numérique (en `jq` et en JavaScript, `null > 0` est faux : une alerte « revues ouvertes > 0 » ne se déclenche pas sur un compteur inconnu ; en JavaScript `null + 1` vaut 1 ; en Python `None > 0` lève une erreur) ; un schéma JSON imposant un entier rejette `null` ; une alerte sur `complete: false` se déclenche aussi pour un `reconcile=0` volontaire (lire `disabledStages`). Les systèmes externes de supervision ne peuvent pas être vérifiés depuis le dépôt.

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
| Migrations | `prisma db push` en test (l'historique `prisma/migrations` ne couvre pas les évolutions PostgreSQL 0002 à 0005 et 0007 ; seule la 0006 a un équivalent SQLite) | `prisma migrate deploy --schema prisma/postgres/schema.prisma`, migrations 0001 à 0007 |

Les garanties de concurrence sont donc validées par `npm run test:pg` (voir [validation-postgresql-stripe.md](validation-postgresql-stripe.md)).

## 9. Décisions métier encore ouvertes

- **Clés API existantes** : stratégie de transition (§ 7) et, éventuellement, API dès Growth.
- **Délai de grâce `past_due`** : 7 jours après la FIN de la période en cours. Stripe avance la période au renouvellement même si le prélèvement échoue : le client en retard dispose donc de la période suivante entière plus 7 jours, jusqu'au passage de Stripe en `unpaid`. Règle historique conservée ; à arbitrer (grâce comptée depuis le début de la période impayée, ce qui exigerait de stocker `current_period_start`).
- **Marge de 3 jours** après la fin d'une période payée avant fermeture sans confirmation (`RENEWAL_GRACE_MS`).
- **Grille tarifaire** : Starter 19 $ CA/mois, Growth 49 $ CA/mois, Pro 99 $ CA/mois ; hiérarchie technique Starter < Growth < Pro inchangée. **Aucun prix Stripe n'a été créé ni modifié** et aucun prix n'est écrit dans le code ; les montants se portent par les variables `STRIPE_PRICE_*`.
- **Support prioritaire** : non annoncé (aucun engagement de service).
- Forfaits du catalogue produit toujours non vérifiés (`verified: false`, devise absente) ; FreelanceNexa sans forfait.

## 10. Prix Stripe inconnus, prix historiques et reprise

**Règle.** Le forfait d'un abonnement payant ne vient que du prix Stripe relu, et seulement s'il est associé EXPLICITEMENT à un forfait : `STRIPE_PRICE_<FORFAIT>` (prix actuel) ou `STRIPE_PRICE_<FORFAIT>_LEGACY` (prix historiques, identifiants séparés par des virgules). Ni `metadata.plan`, ni le forfait local, ni une devinette ne comblent un prix absent ou inconnu. Un prix associé à plusieurs forfaits est ambigu : il n'est jamais reconnu.
Les prix historiques ne servent qu'à RECONNAÎTRE un abonnement existant : toute nouvelle souscription ou tout changement de forfait utilise le prix actuel.

**Prix inconnu (statut payant : actif, essai Stripe, impayé en grâce).** Rien n'est appliqué : forfait, statut, période, client, annulation programmée, essai et réservation de paiement restent intacts. Seules écritures, dans UNE transaction : la date de dernière LECTURE (`stripeSyncedAt` ; ce n'est PAS une preuve de résolution) ET la trace d'audit qui ouvre la revue. Si l'écriture de l'audit échoue, la transaction est annulée et l'erreur remonte : l'événement passe en `failed` et Stripe réessaie (le cron compte un échec et relira l'abonnement au passage suivant) ; l'incident n'est jamais masqué. Le réessai est idempotent (une seule trace par abonnement et par prix). L'identifiant d'abonnement n'est jamais rattaché ni remplacé. Les statuts non payants (résilié, impayé…) sont appliqués normalement.

**Périmètre de la préservation des champs.** Les garanties « forfait, statut, période, client, annulation programmée, essai et réservation de paiement restent intacts » valent pour les événements `customer.subscription.*`, `invoice.*` et la réconciliation. Pour `checkout.session.completed`, le traitement du checkout précède la lecture du prix : il rattache le client Stripe s'il manquait et termine la réservation de paiement ; l'abonnement reste non lié, le statut et le forfait sont conservés, et le résultat est `needs_review` (test dédié). Le double paiement reste empêché par la vérification Stripe qui précède toute nouvelle session de paiement.

**Visibilité.**
- Audit `billing.unknown_price` (abonnement, prix, source) : une trace par abonnement et par prix tant que l'épisode est ouvert ; journal d'erreur `billing.unknown_price`, écrit APRÈS la transaction validée : un bail perdu (synchronisation obsolète) ne produit ni trace ni journal ; si l'écriture elle-même échoue, l'incident est journalisé avec `traceWriteFailed: true` puis l'erreur remonte.
- Registre `StripeEvent` : `needs_review`, note `unknown_price: … (abonnement sub_…, prix price_…) …` pour les événements reçus par webhook.
- `billingNeedsReview` : vrai tant que la dernière entrée d'audit « prix » de l'espace est `billing.unknown_price` (sans limite de durée) ; la page Facturation affiche alors la vérification en cours.
- Résumé du cron — quatre notions DISTINCTES, à ne pas confondre :
  - `openPriceReviews` : revues « prix inconnu » ENCORE OUVERTES, abonnements liés ou non (état durable : la dernière entrée d'audit « prix » de l'espace est une détection ; même source que `billingNeedsReview`). Un espace compte une fois, que sa revue soit relue ou non pendant le passage. C'est le seul compteur qui représente des revues ouvertes persistantes. Si leur calcul échoue, `openPriceReviews` et `unlinkedPriceReviews` valent `null` (inconnus, jamais 0), `reviewCountersAvailable` vaut `false` et le passage n'est pas `complete` ; le compte rendu du passage (`checked`, `failed`…) est conservé.
  - `unlinkedPriceReviews` : SOUS-ENSEMBLE de `openPriceReviews` dont l'abonnement n'est lié à aucun identifiant Stripe local (le cron ne lit jamais ces abonnements). Non additif : ne pas l'ajouter à `openPriceReviews`.
  - `unknownPrice` : détections « prix inconnu » de CE passage uniquement (abonnements liés relus pendant ce passage, donc typiquement une fois par 24 h et par abonnement, plus souvent si la période locale est échue). Une revue ouverte non relue n'y figure pas ; ce n'est pas un état durable.
  - `needsReview` : tous les `needs_review` de ce passage (client inattendu, doublon, prix inconnu) ; sans effet sur `complete`.
  - Condition de complétion : le passage n'est `complete` que si `openPriceReviews` est connu et vaut 0 (en plus des conditions habituelles : aucun échec, aucun abonnement occupé, budget respecté, aucun reste). Une revue de prix ouverte interdit donc `complete`, relue ou non. Le cron journalise aussi `billing.config_issues` (problèmes de configuration, sans valeur secrète) à chaque passage.
- Validation de configuration : `npm run check:env`, la page Facturation (`stripeSetup().issues`) et le journal du cron. Il n'existe pas de contrôle bloquant au démarrage du serveur : le comportement d'exécution est « refus sûr » (aucun forfait attribué).

**Résolution.** Une entrée `billing.unknown_price_resolved` est écrite dès qu'une synchronisation lit un prix RECONNU (quel que soit le statut : actif, impayé, en pause…) ou que l'abonnement est terminé (résilié, expiré). Ensuite `billingNeedsReview` redevient faux. Clore la revue n'accorde aucun accès : le forfait ne change que pour un statut payant, et le statut réel (par exemple impayé, accès suspendu) est conservé.

**Procédure de reprise.**
1. Identifier le prix et l'abonnement : audit/registre (`prix price_…`, `abonnement sub_…`), puis le tableau de bord Stripe pour savoir quel forfait ce prix représente.
2. Corriger la configuration : ancien prix → `STRIPE_PRICE_<FORFAIT>_LEGACY` ; nouveau prix → `STRIPE_PRICE_<FORFAIT>`. Redéployer/redémarrer pour que l'environnement soit relu.
3. Vérifier : `npm run check:env` ; la page Facturation ne doit afficher aucun problème de format ou d'ambiguïté.
4. Relancer la réconciliation de l'abonnement : il n'existe PAS de commande ni de route opérateur dédiée. Moyens existants : (a) le cron `/api/cron/followups` relit l'abonnement dès que sa dernière lecture date de plus de 24 h ; (b) tout nouvel événement Stripe de cet abonnement (renouvellement, facture) est relu et appliqué ; (c) en développement, la fonction `reconcileSubscription(workspaceId)` ; (d) le renvoi de l'événement concerné depuis le tableau de bord Stripe (« Resend ») : un événement `needs_review` « prix inconnu » est le SEUL événement déjà traité que le registre reprend (rien n'y avait été appliqué), au plus une fois toutes les 5 minutes (condition atomique sur `processedAt` : un renvoi plus rapide, ou simultané, reste un doublon sans lecture Stripe) ; tout autre événement traité reste un doublon. Après avoir corrigé la configuration, patienter jusqu'à 5 minutes après le dernier traitement de l'événement avant de le renvoyer.
5. Vérifier : audit `billing.unknown_price_resolved`, forfait et statut de l'espace, `billingNeedsReview` faux, `openPriceReviews` (donc `unlinkedPriceReviews`) à 0 dans le résumé du cron.

**Abonnement jamais lié localement** (`stripeSubscriptionId` nul) : il n'est PAS rattaché sur un prix inconnu (rien n'est écrit hors `stripeSyncedAt`). Ni le cron (qui ne sélectionne que les abonnements liés) ni `reconcileSubscription` ne peuvent donc le reprendre : la reprise passe par le renvoi (d) de l'événement Stripe concerné, ou par un nouvel événement de cet abonnement. Le paiement du client est confirmé chez Stripe mais ses droits restent ceux de l'espace jusqu'à la reprise : traiter ces revues rapidement. Le résumé du cron les rend visibles à l'opérateur (`openPriceReviews`, dont `unlinkedPriceReviews`).

**Rotation de prix.** Avant de retirer ou de remplacer un prix dans `STRIPE_PRICE_<FORFAIT>`, copier l'ancien identifiant dans `STRIPE_PRICE_<FORFAIT>_LEGACY` tant qu'un abonnement l'utilise. Sinon ces abonnements ne sont plus mis à jour (période, statut, annulation) et leur accès cesse à la fin de la période locale plus la marge de 3 jours.

**Limites connues.** (1) L'audit de CLÔTURE (`billing.unknown_price_resolved`) reste non bloquant (l'audit d'usage ne fait jamais échouer une action métier) : s'il échoue, la revue paraît ouverte jusqu'à la synchronisation suivante (sens sûr). (2) Les renvois d'événement « prix inconnu » sont limités à un par fenêtre de 5 minutes, jamais supprimés : chaque reprise coûte une lecture Stripe. (3) Le tri des traces d'audit utilise la date puis l'identifiant ; le bail de synchronisation sérialise détections et clôtures d'un même espace. Aucune garantie multi-serveurs n'est démontrée par les tests (horloges, identifiants dans la même milliseconde). (4) Classification des échecs du cron : l'échec d'écriture de la revue (`ReviewTraceError`, erreur de base) n'alimente plus le disjoncteur « Stripe indisponible » ; en revanche toute autre erreur locale (base, autre écriture) est toujours comptée comme un échec consécutif, donc trois d'affilée arrêtent le passage avec `stoppedBy: "stripe_unavailable"` même si Stripe n'est pas en cause : le code ne distingue pas ces autres erreurs d'une panne de Stripe (décision ultérieure).
