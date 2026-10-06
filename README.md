# SEA Pilot

SaaS d'acquisition et d'automatisation marketing piloté par l'IA :
**Recherche → Stratégie → Offre → Campagne → Landing page → Lead → Qualification IA → Relance → Conversion → Analyse → Optimisation.**

Principe directeur : *aucune fausse fonctionnalité*. Une intégration non configurée affiche « Configuration requise » ; un indicateur non calculable affiche « — » ; un contenu généré par l'IA est étiqueté comme tel ; aucun e-mail n'est envoyé sans configuration **et** consentement.

## Prérequis

- Node.js ≥ 22 (testé avec 24) et npm ≥ 10
- SQLite (inclus) pour le développement ; PostgreSQL ≥ 14 pour la production
- Google Chrome installé pour les tests E2E (Playwright utilise `channel: "chrome"`, aucun téléchargement)

## Installation

```bash
npm ci                      # installe et exécute `postinstall` → prisma generate
cp .env.example .env        # puis renseigner SESSION_SECRET (voir ci-dessous)
npx prisma migrate deploy   # applique les migrations (SQLite : prisma/dev.db)
npm run seed                # optionnel : espace « Demo Workspace » (données fictives)
npm run dev                 # http://localhost:3000
```

Générer un secret : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Vérifier la configuration : `npm run check:env`.

Compte de démonstration (après `npm run seed`, **données fictives**, espace marqué « démonstration ») : `demo@seapilot.test` / `DemoPilot2026!`.

## Variables d'environnement

Toutes documentées dans [`.env.example`](.env.example). Obligatoires : `DATABASE_URL`, `SESSION_SECRET` (≥ 32 car.), `APP_URL` (production). Tout le reste active des fonctions optionnelles :

| Fonction | Variables | Sans elles |
|---|---|---|
| IA | `OPENAI_API_KEY`+`OPENAI_MODEL`, ou `ANTHROPIC_API_KEY`, ou `GEMINI_API_KEY`+`GEMINI_MODEL` (`AI_PROVIDER` pour forcer) | « Configuration requise » ; qualification par règles, stratégie chiffrée et recommandations restent fonctionnelles |
| E-mail système | `RESEND_API_KEY`, `EMAIL_FROM` | Reset de mot de passe : écrit en console (dev) / non envoyé (prod, erreur journalisée) |
| Relances e-mail | clé Resend du **client** (Integrations → E-mail) | Étapes e-mail → tâches manuelles |
| Paiement | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER/GROWTH/PRO` | Essai uniquement, pas de souscription |
| Plateformes | `GOOGLE_CLIENT_ID/SECRET` (+`GOOGLE_ADS_DEVELOPER_TOKEN`), `META_APP_ID/SECRET`, `TIKTOK_APP_ID/SECRET` | Carte « Configuration requise » ; saisie/import CSV des dépenses |
| Relances auto | `CRON_SECRET` | Bouton manuel « Exécuter les relances échues » |

## Base de données et Prisma

- Source de vérité : `prisma/schema.prisma` (SQLite). Pas d'enum Prisma (compatibilité SQLite/PostgreSQL) : valeurs validées par zod (`src/lib/constants.ts`).
- Migrations SQLite : `prisma/migrations` (`npm run db:migrate` en dev, `npm run db:deploy` en CI/prod SQLite).
- **PostgreSQL** : `npm run db:gen-pg` génère `prisma/postgres/schema.prisma` + migration initiale. Avec `DATABASE_URL=postgresql://…`, `postinstall`/`build` génèrent automatiquement le client PostgreSQL (`scripts/prisma-generate.mjs`). Appliquer : `npx prisma migrate deploy --schema prisma/postgres/schema.prisma`.
- Le client Prisma est généré à l'installation (`postinstall`) et au build : un clone propre se construit sans étape manuelle.

## Lancement, tests, build

```bash
npm run dev              # développement
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm test                 # Vitest : unitaires + intégration (base SQLite jetable prisma/test.db)
npm run build            # prisma generate + next build
npm start                # serveur de production
npm run test:e2e         # Playwright (nécessite `npm run build` ; base prisma/e2e.db jetable, port 3101)
```

## Déploiement

1. Provisionner PostgreSQL ; définir `DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `APP_URL`, `CRON_SECRET`, `LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL`.
2. `npm ci && npm run build` ; appliquer les migrations PostgreSQL (ci-dessus) ; `npm start` (port `PORT`).
3. Planifier toutes les 5–15 min : `curl -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/cron/followups` (relances échues + synchronisation des plateformes publicitaires).
4. Santé : `GET /api/health`.
5. Limitation de débit : en mémoire (instance unique). Pour plusieurs instances, remplacer `src/lib/rate-limit.ts` par un store partagé (Redis) — même interface.

## Configuration IA

Un seul point d'entrée : `src/lib/ai/service.ts` (`generate`). Providers dans `src/lib/ai/providers.ts` (OpenAI et compatibles via `OPENAI_BASE_URL`, Anthropic, Gemini). Quotas par plan et par jour (`AI_DAILY_LIMIT_PER_WORKSPACE`), limite par minute, timeout, validation zod de chaque sortie, journal `AIGeneration` (fournisseur, modèle, jetons, coût estimé si `AI_PRICE_IN/OUT_PER_MTOK` sont définis — jamais inventé). Clés uniquement côté serveur.

## Configuration Stripe

1. Créer 3 produits/prix récurrents ; renseigner `STRIPE_PRICE_STARTER|GROWTH|PRO`.
2. Webhook → `${APP_URL}/api/stripe/webhook`, événements : `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed` ; renseigner `STRIPE_WEBHOOK_SECRET`.
3. Optionnel : `PLAN_*_PRICE_LABEL` pour afficher les tarifs. Les montants ne sont jamais codés en dur.

## OAuth et intégrations

Redirection à déclarer chez chaque fournisseur : `${APP_URL}/api/integrations/<google_analytics|google_ads|meta_ads|tiktok_ads>/callback`.
- **Google** (Analytics 4, Ads) : client OAuth ; Ads exige aussi `GOOGLE_ADS_DEVELOPER_TOKEN` (+ ID client dans l'écran Integrations).
- **Meta Ads** : app Facebook avec la permission `ads_read` ; **TikTok Ads** : app Marketing API.
- **E-mail** : clé API Resend du client (vérifiée à la connexion, stockée chiffrée AES-256-GCM).
- Chaque intégration expose connect / disconnect / status / refresh / sync / état d'erreur (`src/lib/integrations`). Pixels (Meta, GA, TikTok, LinkedIn) : non disponibles ; UTM, visites et leads sont mesurés nativement.
- Authentification sociale (Google/Microsoft) : le modèle `OAuthAccount` est prêt ; non activée.

## API d'ingestion de leads

`POST /api/v1/leads` avec `Authorization: Bearer sp_…` (clé créée dans Réglages → API). Détails dans l'écran Réglages.

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| `SESSION_SECRET manquant` | Définir ≥ 32 caractères dans `.env` |
| `EPERM … query_engine` pendant `npm run build` (Windows) | Un serveur Node tourne encore : l'arrêter, relancer |
| Boutons « Générer » désactivés / « Configuration requise » | Aucun fournisseur d'IA configuré |
| Le reset de mot de passe n'envoie rien en prod | Définir `RESEND_API_KEY` et `EMAIL_FROM` |
| Relances jamais exécutées | Planifier l'appel cron ou utiliser le bouton manuel |
| `prisma db push --force-reset` refusé | Garde-fou Prisma pour agents IA : supprimer le fichier `.db` à la place |

Voir aussi [ARCHITECTURE.md](ARCHITECTURE.md) et [FINAL.md](FINAL.md).
