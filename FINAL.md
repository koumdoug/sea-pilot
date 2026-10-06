# SEA Pilot — Rapport final

## Produit
SaaS multi-tenant d'acquisition et d'automatisation marketing piloté par l'IA, du marché au client : recherche, stratégie, offre, campagne, landing page, lead, qualification, relance, conversion, analyse, recommandations. Principe : aucune fausse fonctionnalité (état « Configuration requise » pour tout service externe absent, indicateurs `—` quand non calculables, contenu IA étiqueté).

## Fonctionnalités (toutes opérationnelles, vérifiées par tests)
- **Auth** : inscription, connexion, déconnexion, session persistante 30 j, mot de passe oublié/réinitialisation (jeton à usage unique), changement de mot de passe, profil, routes et API protégées, session expirée → reconnexion. Modèle `OAuthAccount` prêt pour Google/Microsoft.
- **Multi-tenant** : Workspace, rôles owner/admin/member/viewer, ajout/retrait de membres, isolation serveur systématique.
- **Onboarding** (entreprise, offre, client idéal, objectifs) → **fiche stratégie** chiffrée (économie du tunnel, alertes de cohérence, canaux, premières actions) + récit IA optionnel.
- **Dashboard** « Est-ce que mon acquisition fonctionne ? » : dépenses, impressions, clics, CTR, CPC, leads, CPL, conversion, qualifiés, clients, CAC, CA attribué, ROAS, ROI (si fiable), santé 🟢🟠🔴 calculée, graphiques, entonnoir, recommandations, notifications, checklist.
- **Research** (données utilisateur séparées des hypothèses IA), **Offers** + **Offer Builder** IA (variantes, création de landing depuis une variante), audiences.
- **Campagnes** : statuts Draft/Ready/Active/Paused/Completed/Archived avec transitions et contrôles, duplication, **Campaign Builder** en 10 étapes persistées (proposition IA : angles, messages, CTA, objections, hypothèses de test), saisie des dépenses, mots-clés, URL UTM.
- **Landing pages** : éditeur de sections, formulaire configurable, SEO (title, description, Open Graph, canonical, JSON-LD), aperçu, publication, duplication, archivage, sitemap/robots, mesure de visites sans cookie.
- **Leads** : capture publique (validation, honeypot, rate limit), API v1 par clé, UTM/campagne/consentement conservés, liste filtrable et paginée, fiche détaillée.
- **Qualification** : moteur de règles configurables (7 critères, poids, seuils) → score, niveau, raisons, informations manquantes, prochaine action ; **faits fournis ≠ inférences** ; affinage IA optionnel contrôlé (citations vérifiées).
- **CRM** : pipeline Lead → Qualifié → Contacté → Proposition → Gagné/Perdu, notes/échanges, tâches, clients et revenu.
- **Automations** : séquences J0/J1/J3/J7/J14 (e-mail, tâche, rappel, changement de statut), arrêt automatique (client, perdu, disqualifié, désinscrit), exécution par cron ou bouton ; **e-mail jamais envoyé sans fournisseur connecté + autorisation de séquence + consentement**.
- **AI Studio** : annonces Meta/Google/TikTok/LinkedIn, variantes A/B enregistrées, copier/modifier/dupliquer/gagnante, historique des générations. **AI Copilot** : répond uniquement à partir des données réelles.
- **Analytics** : filtres période/campagne/plateforme/source/audience, KPI, graphiques, détail par campagne, import CSV des dépenses.
- **Integrations** : architecture Provider (connect/disconnect/status/refresh/sync/erreur) — Google Analytics, Meta Ads, Google Ads, TikTok Ads (OAuth), E-mail Resend (clé API vérifiée) ; association campagnes plateforme ↔ SEA Pilot.
- **Facturation** : Starter/Growth/Pro (limites, tarifs non figés), essai, upgrade/downgrade (blocage si usage > limites), résiliation/reprise, portail, webhook Stripe signé et idempotent, accès selon l'état de l'abonnement.
- **RGPD** : politique de confidentialité, CGU, consentement horodaté, export JSON, effacement de prospect, suppression de compte/espace, désinscription (lien signé + un clic), liste de suppression.
- Pages publiques : accueil marketing, **démo** (données fictives étiquetées calculées par les vrais moteurs), légales ; Settings (profil, entreprise, équipe, qualification, API, confidentialité, audit).

## Architecture
Voir [ARCHITECTURE.md](ARCHITECTURE.md). Next.js 16, React 19, TypeScript strict, Tailwind 4, Prisma 6, zod 4.

## Base de données
37 modèles (voir `prisma/schema.prisma`) : tous les modèles métier sont scopés par `workspaceId` avec cascade (User, OAuthAccount, PasswordResetToken et Workspace sont les racines d'identité), index composites, unicités, soft delete. Migration SQLite versionnée (`prisma/migrations`) ; variante PostgreSQL générée (`npm run db:gen-pg`, `prisma/postgres`).

## Sécurité
Isolation tenant (testée), bcrypt, rate limiting, CSRF (server actions + SameSite), validation zod partout, XSS (contenu texte échappé, URLs filtrées), en-têtes de sécurité, secrets chiffrés/hachés, quotas IA, entrées IA non fiables encadrées, audit log, logs masqués. Détails : ARCHITECTURE.md.

## Tests (résultats exacts, exécutés sur le dépôt et sur un clone propre)
- Vitest (unitaires + intégration) : **157 / 157 réussis** (13 fichiers ; 146 avant le passage production + 11 tests de non-régression ajoutés).
- Playwright E2E (Chrome, 2 fichiers) : **27 / 27 réussis** — parcours complet (inscription → onboarding → landing → campagne → formulaire public → lead → qualification → CRM → analytics → relances → intégrations → facturation → API → RGPD → isolation → abonnement expiré → session) + responsive 375/768/1280 px sur 30+ pages (aucun débordement horizontal, un seul h1, champs étiquetés, navigation clavier, lien d'évitement).
- `tsc --noEmit` : 0 erreur. ESLint : 0 erreur, 0 avertissement.

## Build
`npm ci` → `prisma generate` (postinstall) → `prisma migrate deploy` → `npm run build` : réussi ; `npm start` : réussi, `/api/health` répond `ok` ; vérifié sur clone propre.

## Déploiement et variables d'environnement
Voir [README.md](README.md) (instructions exactes, tâche cron, PostgreSQL, Stripe, OAuth) et [.env.example](.env.example) (chaque variable documentée).

## Intégrations — état réel (passage production)
Séparation stricte : **code et tests automatisés** (réponses simulées) ≠ **appels réels** (jamais effectués : aucune clé/instance disponible).

| Service | Code et tests automatisés | Validation réelle |
|---|---|---|
| PostgreSQL | VALIDÉS : `db:gen-pg` régénère un schéma/migration identiques (aucun diff Git) ; la migration `prisma/postgres/migrations/0001_init` a été appliquée sur un moteur PostgreSQL 18 embarqué (PGlite, hors dépôt) : 37 tables, 72 clés étrangères, cascade et unicité vérifiées ; client PostgreSQL généré automatiquement si `DATABASE_URL` commence par `postgres` ; recherche insensible à la casse adaptée (`containsCi`) | **PostgreSQL — Configuration requise / validation réelle impossible sans instance PostgreSQL.** Prisma Client n'a pas été exécuté contre un serveur PostgreSQL |
| IA (OpenAI / Anthropic / Gemini) | VALIDÉS : clé absente → « Configuration requise » (E2E), erreurs typées, quotas par plan/jour et par minute, jetons journalisés, coût jamais inventé (null sans tarif), sortie validée, contenu étiqueté IA, injection de prompt encadrée | **Appels réels aux fournisseurs : NON VALIDÉS — clé requise** |
| Resend / e-mail | VALIDÉS : aucun envoi sans fournisseur, sans autorisation de séquence, sans consentement, ni pour un désinscrit/supprimé ; liste de suppression ; List-Unsubscribe ; séquences J0–J14 ; idempotence (3 exécutions = 1 e-mail) | **Resend — Configuration requise / envoi réel non validé** |
| Stripe | VALIDÉS : checkout, portail, changement de plan, downgrade bloqué, annulation/reprise, expiration, webhook signé et idempotent, erreurs sans effet local, pas d'effet inter-espaces | **Stripe — Configuration requise / validation Stripe réelle non effectuée** (aucun paiement réel) |
| Google Analytics, Meta Ads, Google Ads, TikTok Ads | VALIDÉS : architecture Provider, connect/disconnect/status/refresh/sync, états expiré/erreur, mappage, synchronisation idempotente, chiffrement des identifiants, isolation par espace, aucune donnée factice | **Configuration requise / OAuth réel non validé** (aucun compte publicitaire connecté) |
| Pixels (Meta, GA, TikTok, LinkedIn) | Non disponibles ; UTM/visites/leads mesurés nativement | — |

Vérifications internes de ce passage : attribution UTM → visite → lead → campagne → qualification → CRM → revenu → KPI (calculés, `—` quand non calculables) ; isolation entre deux espaces (interface, API, identifiant direct, clé API, analytics, campagnes, leads, CRM, abonnement, désinscription, webhook Stripe) ; jeton de réinitialisation à usage unique ; aucun secret dans Git, `.env` ignoré, toutes les variables lues par le code documentées dans `.env.example`. Aucune faille réelle n'a été découverte lors de ce passage ; aucun correctif de code n'a été nécessaire (seule une erreur de documentation — nombre de modèles — a été corrigée).

## Limites (imposées par des services externes)
Les comptes et clés suivants doivent être fournis par le propriétaire du produit : fournisseur d'IA, Resend, Stripe (clés + prix + webhook), applications OAuth Google/Meta/TikTok (+ token développeur Google Ads), domaine/hébergeur PostgreSQL, informations légales (`LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL`). Les textes légaux sont une base à faire valider juridiquement. Le rate limiting en mémoire convient à une instance unique.

## Comptes de démonstration
`npm run seed` → `demo@seapilot.test` / `DemoPilot2026!` (espace « Demo Workspace », marqué démonstration, données fictives). Jamais créé automatiquement en production.

## Prochaines améliorations
Pixels de suivi, connexion Google/Microsoft, invitations par e-mail, rate limiting Redis, compression/optimisation d'images uploadées.
