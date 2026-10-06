# SEA Pilot — Architecture

## Stack
Next.js 16 (App Router, server components + server actions) · React 19 · TypeScript strict · Tailwind CSS 4 · Prisma 6 (SQLite dev/test, PostgreSQL prod) · zod 4 · jose (sessions JWT) · bcryptjs · Vitest · Playwright. Aucune bibliothèque de graphiques ou de composants : SVG et composants maison.

## Modules (`src/lib`, logique pure et testable ; `src/app` : écrans et actions)
| Domaine | Fichiers |
|---|---|
| Auth / session | `auth.ts` (JWT httpOnly 30 j, bcrypt 12, politique de mot de passe), `(auth)/actions.ts` (login, register, reset) |
| Multi-tenant | `tenant.ts` (`requireCtx`), `permissions.ts` (owner/admin/member/viewer), `action.ts` (`run` : contexte + permission + erreurs) |
| Abonnement | `plans.ts` (limites, `entitlement`), `billing.ts` (Stripe via fetch, webhook signé, usage) |
| Stratégie / marché / offre | `strategy.ts` (calcul déterministe), `ai/prompts.ts` |
| Campagnes | `campaigns.ts` (cycle de vie, duplication, UTM) |
| Landing / formulaires / leads | `landing.ts` (sections texte, anti-XSS), `public-leads.ts`, `leads.ts` (création, statuts, client, RGPD) |
| Qualification | `scoring.ts` (règles configurables, faits vs inférences), `leads.ts` (fusion IA contrôlée) |
| Relances | `followups.ts`, `email.ts` (consentement, suppression, désinscription) |
| Analytics | `kpi.ts`, `analytics.ts`, `recommendations.ts`, `insights.ts`, `copilot.ts` |
| IA | `ai/service.ts` (point d'entrée unique), `ai/providers.ts` (OpenAI/Anthropic/Gemini), `ai/errors.ts` |
| Intégrations | `integrations/{types,providers,service}.ts` |
| Transverse | `crypto.ts` (AES-GCM, HMAC), `rate-limit.ts`, `audit.ts`, `logger.ts`, `env.ts`, `csv.ts`, `data-export.ts` |

## Modèle de données (`prisma/schema.prisma`)
Racine multi-tenant `Workspace` ; tout modèle métier porte `workspaceId` (FK, `onDelete: Cascade`) et des index `(workspaceId, …)`. Modèles : User, OAuthAccount, PasswordResetToken, Workspace, Membership, Subscription, Strategy, MarketResearch, Audience, Offer, Campaign, AdAccount, AdCampaign, Ad, Keyword, Metric, LandingPage, Form, Lead, Customer, Contact, Conversation, LeadActivity, QualificationConfig, AIQualification, FollowUpSequence, FollowUp, Task, AnalyticsEvent, Integration, ApiKey, AIGeneration, Notification, AuditLog, Consent, EmailSuppression, EmailLog. Soft delete : `deletedAt` (User, Workspace, Lead, Customer). Unicités : `(workspaceId, slug)`, `(workspaceId, dedupeKey)`, `(workspaceId, provider)`, etc.

## Flux principal
1. Onboarding → Workspace + Offer + Audience + Strategy (calcul déterministe + récit IA optionnel).
2. Campaign Builder (10 étapes persistées côté serveur) → statuts Draft→Ready→Active (contrôles : landing publiée, limites du plan).
3. Landing page publique `/p/{workspace}/{slug}` : visite mesurée sans cookie (`/api/track`), formulaire → `/api/public/leads` (validation, honeypot, rate limit) → `createLead` (UTM, campagne, consentement, activité, qualification auto, séquences auto).
4. CRM : statuts, notes, tâches, conversion (`won` → Customer + revenu).
5. Analytics : agrégation Metric (saisie/CSV/intégrations) + Lead ; KPI `null` si non calculable ; recommandations par règles avec preuve.

## Sécurité
- **Isolation** : le contexte vient du cookie de session signé → `Membership` en base ; l'identifiant d'espace envoyé par le navigateur n'est jamais cru. Toute requête métier filtre `workspaceId` ; `updateMany/deleteMany` avec `workspaceId` ; 404 (jamais 403) sur ressource d'un autre espace. Testé (`tests/tenant-isolation.test.ts`, E2E).
- **Auth** : bcrypt 12, comparaison à temps constant même si compte inconnu, limitation de débit login/inscription/reset/mot de passe, reset par jeton haché à usage unique (1 h), cookie httpOnly/SameSite=Lax/secure.
- **CSRF** : server actions Next (contrôle d'origine) + SameSite=Lax ; routes POST publiques sans cookie d'auth ; API v1 par clé Bearer.
- **XSS** : contenu des landing pages = texte structuré validé (zod), échappé par React, URLs limitées à http(s) ; JSON-LD échappé ; en-têtes de sécurité (nosniff, X-Frame-Options, HSTS, Referrer-Policy, Permissions-Policy).
- **Secrets** : variables d'environnement ; identifiants d'intégration chiffrés AES-256-GCM ; clés API stockées hachées (SHA-256) et affichées une seule fois ; logs structurés avec masquage des champs sensibles ; aucun secret versionné (`.gitignore`).
- **IA** : clés côté serveur ; quotas par plan/jour et par minute ; entrées non fiables encadrées (`<donnees>`) et traitées comme données ; sortie validée par schéma ; ajustements IA = inférences, citations vérifiées mot pour mot.
- **E-mail** : refus si pas de fournisseur, pas de consentement, désinscrit ou supprimé ; lien et en-têtes List-Unsubscribe (un clic) ; journal `EmailLog`.
- **RGPD** : consentement horodaté et texte conservés (`Consent`), IP pseudonymisée (hash salé), export JSON, effacement d'un prospect, suppression de compte/espace en cascade, politique de confidentialité et CGU.
- **Audit** : `AuditLog` des actions sensibles (connexions, statuts, intégrations, clés API, exports, suppressions).

## Observabilité
Logs JSON (`logger.ts`), `AIGeneration` (usage et coût estimé), `AuditLog`, `EmailLog`, `GET /api/health`.

## Déploiement
Voir README. Tâche planifiée `/api/cron/followups` ; migrations `prisma migrate deploy` ; rate limiting mémoire (instance unique, Redis pour le multi-instance).
