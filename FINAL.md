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
39 modèles (voir `prisma/schema.prisma`) : tous scopés par `workspaceId` avec cascade, index composites, unicités, soft delete. Migration SQLite versionnée (`prisma/migrations`) ; variante PostgreSQL générée (`npm run db:gen-pg`, `prisma/postgres`).

## Sécurité
Isolation tenant (testée), bcrypt, rate limiting, CSRF (server actions + SameSite), validation zod partout, XSS (contenu texte échappé, URLs filtrées), en-têtes de sécurité, secrets chiffrés/hachés, quotas IA, entrées IA non fiables encadrées, audit log, logs masqués. Détails : ARCHITECTURE.md.

## Tests (résultats exacts, exécutés sur le dépôt et sur un clone propre)
- Vitest (unitaires + intégration, 12 fichiers) : **146 / 146 réussis**.
- Playwright E2E (Chrome, 2 fichiers) : **27 / 27 réussis** — parcours complet (inscription → onboarding → landing → campagne → formulaire public → lead → qualification → CRM → analytics → relances → intégrations → facturation → API → RGPD → isolation → abonnement expiré → session) + responsive 375/768/1280 px sur 30+ pages (aucun débordement horizontal, un seul h1, champs étiquetés, navigation clavier, lien d'évitement).
- `tsc --noEmit` : 0 erreur. ESLint : 0 erreur, 0 avertissement.

## Build
`npm ci` → `prisma generate` (postinstall) → `prisma migrate deploy` → `npm run build` : réussi ; `npm start` : réussi, `/api/health` répond `ok` ; vérifié sur clone propre.

## Déploiement et variables d'environnement
Voir [README.md](README.md) (instructions exactes, tâche cron, PostgreSQL, Stripe, OAuth) et [.env.example](.env.example) (chaque variable documentée).

## Intégrations — état réel
| Intégration | État |
|---|---|
| Base SQLite / PostgreSQL | SQLite testé de bout en bout ; PostgreSQL : schéma et migration générés, **non exécutés contre une instance PostgreSQL dans cet environnement** |
| IA (OpenAI / Anthropic / Gemini) | Code complet et testé avec fournisseur de test ; **appels réels non vérifiés** (aucune clé disponible). Sans clé : « Configuration requise » |
| E-mail (Resend) | Code complet, testé avec réponses simulées ; envoi réel non vérifié (aucune clé) |
| Stripe | Code complet (checkout, portail, changement de plan, webhook signé) testé avec réponses simulées ; **non vérifié contre Stripe** (aucune clé) |
| Google Analytics / Meta / Google Ads / TikTok | OAuth + synchronisation implémentés, requêtes et mappage testés avec réponses simulées ; **non vérifiés contre les API réelles** (identifiants d'application requis) |
| Pixels (Meta, GA, TikTok, LinkedIn) | Non disponibles ; UTM/visites/leads mesurés nativement |

## Limites (imposées par des services externes)
Les comptes et clés suivants doivent être fournis par le propriétaire du produit : fournisseur d'IA, Resend, Stripe (clés + prix + webhook), applications OAuth Google/Meta/TikTok (+ token développeur Google Ads), domaine/hébergeur PostgreSQL, informations légales (`LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL`). Les textes légaux sont une base à faire valider juridiquement. Le rate limiting en mémoire convient à une instance unique.

## Comptes de démonstration
`npm run seed` → `demo@seapilot.test` / `DemoPilot2026!` (espace « Demo Workspace », marqué démonstration, données fictives). Jamais créé automatiquement en production.

## Prochaines améliorations
Pixels de suivi, connexion Google/Microsoft, invitations par e-mail, rate limiting Redis, compression/optimisation d'images uploadées.
