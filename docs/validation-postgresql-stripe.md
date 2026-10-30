# Validation PostgreSQL et Stripe (mode test) — protocole et résultats

Aucune clé, aucun mot de passe, aucune URL de production dans ce document. Les valeurs ci-dessous concernent une base **jetable locale**.

## 1. Règles de sécurité (non négociables)

- Jamais la production, jamais un conteneur ou une sauvegarde contenant des données réelles. Créer un conteneur NOUVEAU, nommé et étiqueté pour l'occasion.
- La suite PostgreSQL SUPPRIME des données (`resetDb`) : sa garde ([tests/global-setup-pg.ts](../tests/global-setup-pg.ts)) refuse tout hôte non local, toute base dont le nom ne commence pas par `sea_pilot_throwaway_`, et exige `PG_THROWAWAY_CONFIRM=yes`.
- Aucun paiement réel : Stripe en mode TEST uniquement (`sk_test_…`) ; une clé `sk_live` est refusée par le fichier de contrat.

## 2. PostgreSQL jetable — procédure

```bash
# 1. Conteneur nouveau, boucle locale uniquement, sans mot de passe réel (image déjà présente ; version de la production : PostgreSQL 18)
docker run -d --name sea-pilot-hardening-pg-throwaway --label purpose=sea-pilot-stripe-hardening-throwaway \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=sea_pilot_throwaway_hardening -p 127.0.0.1:55439:5432 postgres:18

# 2. Vérifier l'identité AVANT toute migration : nom, étiquette, base vide
docker inspect --format '{{.Name}} {{index .Config.Labels "purpose"}} {{.Config.Image}}' sea-pilot-hardening-pg-throwaway
docker exec sea-pilot-hardening-pg-throwaway psql -U postgres -d sea_pilot_throwaway_hardening -tAc "select current_database(), count(*) from information_schema.tables where table_schema='public'"

# 3. Migrations (uniquement sur cette base) puis client Prisma PostgreSQL
export DATABASE_URL="postgresql://postgres@127.0.0.1:55439/sea_pilot_throwaway_hardening" PG_THROWAWAY_CONFIRM=yes
npx prisma migrate deploy --schema prisma/postgres/schema.prisma
node scripts/prisma-generate.mjs

# 4. Suite complète sur PostgreSQL (verrous, transactions et concurrence réels)
npm run test:pg

# 5. Remettre le client SQLite et détruire LA base jetable après avoir revérifié son identité
unset DATABASE_URL PG_THROWAWAY_CONFIRM; node scripts/prisma-generate.mjs
docker rm -f -v sea-pilot-hardening-pg-throwaway
```

Compatibilité avec des données existantes (sans toucher à rien de réel) : créer une seconde base jetable, y appliquer à la main `0001` à `0003` (`psql < migration.sql`), insérer des lignes synthétiques (espace + abonnement), appliquer `0004` et `0005`, vérifier que les lignes sont intactes et que les nouvelles colonnes sont nulles.

### Résultats obtenus pendant cette mission (réalisés)

| Contrôle | Résultat |
|---|---|
| Moteur | PostgreSQL 18.6, conteneur nouveau étiqueté, base initialement vide (0 table) |
| `prisma migrate deploy` (0001 à 0005) | 5 migrations appliquées sans erreur ; colonnes ajoutées nullables ; tables `StripeEvent` et `ContentItem` créées |
| Compatibilité des données | Ligne d'abonnement synthétique (forfait, statut, identifiants Stripe, période) intacte après `0004` et `0005` ; nouvelles colonnes nulles ; registre vide |
| Suite complète `npm run test:pg` (dernier code) | 62 fichiers, **1 055 tests réussis**, 4 ignorés (contrat Stripe test, clé absente), sortie 0 |
| Activité réellement exécutée sur PostgreSQL (première exécution) | ≈ 21 800 transactions validées, ≈ 15 200 lignes insérées |
| Charge (`tests/pg-stress.test.ts`) | 60 prises en charge simultanées d'un événement → 1 ; 60 créations sous un plafond de 20 clés → 20 ; 40 créations de séquences → plafond du forfait ; 30 demandes Checkout → 1 session et 1 client ; 25 synchronisations → jamais 2 lectures simultanées ; deux espaces ne se bloquent pas |
| Mutations sur PostgreSQL | quota sans verrou → détecté (2 tests) ; réservation non exclusive → détectée ; bail non exclusif → détecté (après correction de l'instrument de mesure) |
| Destruction | Conteneur et volume anonyme détruits après vérification de l'étiquette ; aucun autre conteneur n'a été touché |

**Non validé sur PostgreSQL** : la tenue en charge réelle (pool de connexions sous trafic de production), la migration sur un volume de données réel, la latence des verrous avec des milliers d'espaces. À mesurer en préproduction.

## 3. Stripe en mode test — procédure (NON exécutée dans cette mission : aucun identifiant de test fourni)

Prérequis fournis par l'opérateur (jamais écrits dans le dépôt) : un compte Stripe en mode test isolé, une clé secrète de test, un prix récurrent de test.

### 3.1 Contrat de l'adaptateur réel

```bash
STRIPE_TEST_SECRET_KEY=sk_test_… STRIPE_TEST_PRICE_ID=price_… npx vitest run tests/stripe-test-mode.contract.test.ts
```

Vérifie, contre l'API de test : création de client et idempotence (même e-mail → même client, autre e-mail → autre client) ; lecture d'un abonnement ou d'une session inconnus (`null`) ; création de session avec `expires_at` à 40 minutes, idempotence de la session, liste des sessions ouvertes, expiration ; refus d'un `expires_at` trop proche avec un message mentionnant `expires_at` (le code s'appuie sur cette détection pour expliquer une dérive d'horloge). Les objets de test créés sont supprimés en fin de fichier. Aucune session n'est payée.

### 3.2 Webhooks et scénarios (Stripe CLI en mode test, serveur local)

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook   # affiche un secret de webhook de TEST à placer dans STRIPE_WEBHOOK_SECRET local
```

Événements à déclarer sur le point de terminaison : `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `invoice.paid`, `invoice.payment_failed`.

| Scénario | Comment | Résultat attendu |
|---|---|---|
| Événement rejoué | `stripe events resend <evt>` deux fois | 2ᵉ livraison : 200 « duplicate », un seul effet |
| Événement retardé / dans le désordre | renvoyer un ancien `customer.subscription.updated` après une annulation | l'état reste celui de Stripe (annulé) |
| Deux sessions Checkout | deux demandes rapprochées depuis deux onglets | une seule session ; l'autre est refusée avec un message |
| Session payée, webhook indisponible | payer en carte de test avec le webhook coupé, puis redemander | refus « déjà actif chez Stripe » ; l'état local est réparé |
| Paiement échoué puis `unpaid` | horloges de test (Test Clocks) + carte de test dont le prélèvement échoue | `past_due` (accès, grâce) puis `unpaid` (accès suspendu) ; régularisation → accès rétabli |
| Session expirée | laisser expirer ou `stripe checkout sessions expire` | nouvelle souscription possible, réservation libérée |
| Réconciliation | couper le webhook, modifier l'abonnement côté Stripe, appeler la tâche planifiée | l'état local rejoint Stripe ; `complete: true` |
| Panne de Stripe | clé invalide ou réseau coupé pendant la tâche planifiée | aucun droit modifié ; `complete: false` ; reprise au passage suivant |

Cartes de test publiques de Stripe : `4242 4242 4242 4242` (succès), `4000 0000 0000 0341` (attachement réussi, prélèvement refusé). Vérifier aussi le réglage de compte « limiter les clients à un seul abonnement ».

## 4. Critères avant de parler de préproduction

1. `npm run test:pg` vert sur une base jetable de la même version que la production (fait : 18.6).
2. Contrat Stripe en mode test vert (non fait).
3. Les neuf scénarios du § 3.2 déroulés sur un environnement de préproduction avec Stripe en mode test (non fait).
4. Mesure des clés API existantes lue et décision de transition prise ([stripe-hardening.md](stripe-hardening.md) § 7) (non fait).
5. Tâche planifiée configurée avec `CRON_SECRET` et une alerte sur `complete: false` (non vérifié : configuration Railway non consultée).
6. Sauvegarde de la base, puis application des migrations `0003`, `0004` et `0005` ensemble (aucune n'est appliquée en production).
