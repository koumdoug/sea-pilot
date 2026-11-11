# Déploiement sur Railway — ce que le code attend

> **À VÉRIFIER dans le tableau de bord Railway.** Aucun fichier de configuration Railway n'est versionné dans ce dépôt (ni `railway.json`, ni `nixpacks.toml`, ni `Procfile`, ni `Dockerfile`). Tout ce qui suit décrit ce que **le code attend** ; la configuration réellement appliquée sur Railway n'a pas été lue pour écrire ce document et peut différer.

## 1. Commande de pré-déploiement attendue

```bash
npx prisma migrate deploy --schema prisma/postgres/schema.prisma
```

Équivalent versionné : `npm run db:deploy:pg`.

- **À VÉRIFIER dans le tableau de bord Railway** : que cette commande (ou son équivalent) est bien configurée comme commande de pré-déploiement, qu'elle cible le schéma PostgreSQL, et qu'un échec empêche la mise en service du nouveau déploiement.
- **Ne pas utiliser `npm run db:deploy`** en production : il lance `prisma migrate deploy` sans `--schema`, donc contre le schéma SQLite par défaut, dont l'historique de migrations est incomplet pour PostgreSQL (voir `docs/followup-reliability.md`).
- Migrations attendues : `0001` à `0007` du dossier `prisma/postgres/migrations` (toutes additives : aucune suppression, aucune transformation de données ; voir `docs/validation-postgresql-stripe.md`).
- `DATABASE_URL` doit commencer par `postgresql://` (le client Prisma PostgreSQL est généré à la construction d'après cette variable : `scripts/prisma-generate.mjs`).

## 2. Construction, démarrage, santé

| Étape | Commande attendue | Remarque |
|---|---|---|
| Construction | `npm run build` | génère le client Prisma adapté à `DATABASE_URL`, puis `next build` |
| Démarrage | `npm start` | port lu dans `PORT` par Next |
| Santé | `GET /api/health` | répond 200 `{"status":"ok","db":"up"}` si la base est joignable, 503 sinon |
| Tâche planifiée | `POST` (ou `GET`) `/api/cron/followups` avec `Authorization: Bearer <CRON_SECRET>` | toutes les 5 à 15 minutes ; **le planificateur est externe au dépôt** (À VÉRIFIER : où il est configuré) |

## 3. Variables d'environnement attendues par le code (noms seulement)

Rôles d'après `src/lib/env.ts`, `.env.example` et `scripts/check-env.ts`. **Aucune valeur n'est consignée ici.** `npm run check:env` signale les absences sans afficher de valeur.

**Obligatoires**

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | base PostgreSQL de production |
| `SESSION_SECRET` | secret de session, 32 caractères au moins |
| `APP_URL` | adresse publique (liens d'e-mail, retours de paiement) ; obligatoire en production |
| `CRON_SECRET` | authentifie la tâche planifiée ; absent : la route répond 503 |

**Paiement (Stripe)**

| Variable | Rôle |
|---|---|
| `STRIPE_SECRET_KEY` | appels à l'API Stripe |
| `STRIPE_WEBHOOK_SECRET` | signature du webhook ; absent : le webhook répond 503 |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` | identifiants des prix actifs des trois forfaits |
| `STRIPE_PRICE_STARTER_LEGACY`, `STRIPE_PRICE_GROWTH_LEGACY`, `STRIPE_PRICE_PRO_LEGACY` | optionnelles : anciens prix encore portés par des abonnements existants |

`npm run check:stripe -- --read-only-confirmed` compare ces identifiants à Stripe (lecture seule).

**Liste de suppression et envois**

| Variable | Rôle |
|---|---|
| `SUPPRESSION_HMAC_KEY` | optionnelle ; clé dédiée de la liste de suppression (32 caractères au moins, distincte de `SESSION_SECRET` et `ENCRYPTION_KEY`) |
| `SUPPRESSION_HMAC_KEY_PREVIOUS` | optionnelle ; anciennes clés, pour la rotation |
| `OUTBOUND_SENDING_DISABLED` | optionnelle ; interrupteur global des envois (toute valeur non vide sauf `0`, `false`, `no`, `non`, `off` les suspend) |
| `RESEND_API_KEY`, `EMAIL_FROM` | e-mails système de la plateforme |
| `ENCRYPTION_KEY` | optionnelle ; à défaut, `SESSION_SECRET` est utilisé |

**Autres (optionnelles)**

`LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL`, `FREE_ACCESS_USER_IDS`, `TRIAL_DAYS`, `LOG_LEVEL`, `PLAN_STARTER_PRICE_LABEL`, `PLAN_GROWTH_PRICE_LABEL`, `PLAN_PRO_PRICE_LABEL`.

IA : `AI_PROVIDER`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_TIMEOUT_MS`, `AI_MAX_OUTPUT_TOKENS`, `AI_DAILY_LIMIT_PER_WORKSPACE`, `AI_RATE_LIMIT_PER_MIN`, `AI_PRICE_IN_PER_MTOK`, `AI_PRICE_OUT_PER_MTOK`.

Plateformes publicitaires : `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `META_APP_ID`, `META_APP_SECRET`, `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`.

`NODE_ENV` est positionnée par Next ; ne pas la définir à la main.

## 4. Vérifications après un déploiement

```bash
npm run check:env                                                         # absences de variables, sans afficher de valeur
npm run check:stripe -- --read-only-confirmed                             # prix configurés contre Stripe, lecture seule
npm run smoke:prod -- --base-url=<adresse publique> --read-only-confirmed # santé, pages privées, API, webhook, tâche planifiée
```

## 5. Ce que ce document ne prouve pas

- Il ne prouve pas que la commande de pré-déploiement est configurée sur Railway : c'est le point **À VÉRIFIER** ci-dessus.
- Il ne décrit pas la branche suivie par Railway, ni les sauvegardes de la base : à consigner après lecture du tableau de bord.
