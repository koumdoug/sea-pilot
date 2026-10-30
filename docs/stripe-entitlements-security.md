# Sécurisation Stripe et droits des forfaits (D1 à D5)

Ce document décrit l'architecture retenue pour le cycle de vie Stripe et les droits des forfaits. Il ne contient aucune valeur de configuration.

## Principe commun

Le serveur est l'autorité. Un événement Stripe annonce qu'*il s'est passé quelque chose* ; l'état appliqué est celui que Stripe renvoie *au moment du traitement*. L'interface ne fait qu'afficher des règles que le serveur applique.

## Cycle de vie Stripe (D1 à D4)

| Besoin | Mécanisme | Où |
|---|---|---|
| Événements dans le désordre (D1) | L'abonnement est relu chez Stripe (`GET /subscriptions/{id}`) pour tout événement `customer.subscription.*`, `invoice.*` et `checkout.session.completed`. L'écriture est un compare-and-swap : elle exige que `stripeSyncedAt` soit plus ancien et que l'identifiant d'abonnement lu au départ soit encore celui de la base. | `applyRemoteSubscription` (`src/lib/billing.ts`) |
| Aucun droit sur la foi d'un événement ancien | Le forfait n'est appliqué que si l'état relu est actif ou en règlement. Un abonnement terminé n'est jamais rétabli par un événement : seul Stripe peut dire qu'il est de nouveau actif. | idem |
| Doubles abonnements (D2) | Réservation atomique d'une tentative (`checkoutReservationId/ReservedUntil/SessionId` sur `Subscription`, une requête SQL conditionnelle, valable entre serveurs). Une session ouverte est expirée chez Stripe avant d'être remplacée ; une session déjà payée interdit une nouvelle tentative. Clés d'idempotence Stripe (`customer:{espace}`, `checkout:{réservation}`). L'abonnement local est relu chez Stripe avant toute nouvelle session. | `reserveCheckout`, `createCheckoutSession` |
| Jamais de substitution d'un abonnement vivant | Un second abonnement actif pour le même client est signalé (`needs_review`, audit `billing.duplicate_subscription`, journal d'erreur) et l'état courant est conservé. **Aucune annulation ni remboursement automatique** : décision humaine. | `applyRemoteSubscription` |
| Déduplication atomique (D3) | Registre `StripeEvent` : la clé primaire est l'identifiant d'événement. États `processing` (bail 120 s) / `processed` / `failed`. Reprise d'un événement `failed` ou au bail expiré. Une écriture impossible dans le registre échoue **avant** tout effet (HTTP 500, Stripe réessaie). Un doublon en cours de traitement répond 409. | `src/lib/stripe-events.ts` |
| Expiration locale (D4) | `entitlement()` : statut `active` sans résiliation programmée = accès jusqu'à `currentPeriodEnd` + 3 jours (`RENEWAL_GRACE_MS`) ; résiliation programmée = accès jusqu'à `currentPeriodEnd` exactement. Au-delà, l'accès se ferme jusqu'à réconciliation. | `src/lib/plans.ts` |
| Réconciliation | `reconcileDueSubscriptions` (période échue ou plus de 24 h sans synchronisation), exécutée par la tâche planifiée existante `/api/cron/followups` (`?reconcile=0` pour l'ignorer). Stripe indisponible : l'abonnement est compté en échec et **laissé tel quel**. | `src/lib/billing.ts`, route cron |

### À configurer côté Stripe et Railway (non fait ici)

- Ajouter l'événement `checkout.session.expired` au point de terminaison `/api/stripe/webhook` (la liste affichée dans Facturation l'indique).
- La tâche planifiée `/api/cron/followups` doit tourner (elle porte aussi la réconciliation) et `STRIPE_SECRET_KEY` doit être défini.

### Migration PostgreSQL `0004_stripe_event_ledger`

Additive : une table `StripeEvent` et quatre colonnes **nullables** sur `Subscription`. Aucune donnée existante n'est lue ni modifiée ; aucun verrou long (ajout de colonnes nullables sans valeur par défaut). Appliquée par `prisma migrate deploy` (pré-déploiement Railway) : **non appliquée en production par cette mission**. SQLite : le schéma de développement et de test passe par `prisma db push` (l'historique de migrations SQLite ne couvre déjà plus les migrations PostgreSQL 0002 et 0003).

## Droits des forfaits (D5)

| Droit | Règle | Application serveur |
|---|---|---|
| Accès API | Réservé à **Pro** (`PlanRights.api`). Les limites de clés valent 0 pour Starter et Growth. | `authenticateApiRequest` (`src/lib/api-access.ts`) : clé, débit, abonnement actif (402), droit du forfait (403), relus à **chaque appel**. Création de clé : refus sous Starter/Growth. Une clé héritée n'est pas supprimée : elle est refusée tant que le forfait n'est pas Pro. |
| Séquences de relance | Limite du forfait (Starter 1, Growth 10, Pro illimité), création atomique. | `createWithinLimit` (`src/lib/quota.ts`) : comptage et création dans une transaction qui verrouille la ligne de l'espace. |
| Exécution des relances | Aucune relance n'est exécutée pour un espace sans abonnement actif ; elles restent en attente et reprennent à la réactivation. | `processDueFollowUps` |
| Intégrations | « Toutes les intégrations » est exact pour Growth : les 5 types existants sont tous disponibles (limite de 5). Starter est limité à 2. Il n'existe aucune restriction *par type*. La limite s'applique dans `saveConnection`, point de passage commun à la connexion par clé **et au retour OAuth** (qui n'était pas contrôlé). | `saveConnection` |

L'accès propriétaire gratuit (exemption) reste inchangé : droits du forfait Pro, API comprise ; les gardes `notExempt` de la facturation sont intactes.

## Limites connues

- Les verrous de quota reposent sur le verrou de ligne PostgreSQL (`UPDATE` de l'espace dans la transaction). Les tests de concurrence tournent sur SQLite, qui sérialise les écritures : ils prouvent la logique (comptage et création indissociables) mais pas le comportement des verrous PostgreSQL sous charge réelle.
- La synchronisation compare des dates locales (`stripeSyncedAt`) : deux serveurs dont l'horloge diverge de plusieurs secondes peuvent, dans un cas très rare, appliquer une lecture légèrement plus ancienne. L'état converge à la synchronisation suivante.
- Les quotas des autres ressources (utilisateurs, campagnes actives, landing pages) ne sont pas encore transactionnels : `createWithinLimit` est prêt à les accueillir.
- Un second abonnement actif détecté n'est pas annulé automatiquement (voir ci-dessus).
