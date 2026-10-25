# SEA Pilot — module Portefeuille (multi-produits)

SEA Pilot est le moteur interne de croissance du portefeuille de SaaS (DriverPilot, FreelanceNexa, OperaPilot, et d'autres plus tard).
Ce module est **additif** : aucune table ni colonne existante n'est modifiée ou supprimée, aucune donnée historique n'est réécrite.

## Ce qui est implémenté et testé

| Capacité | Où | Tests |
|---|---|---|
| Catalogue de produits (fiche, tarifs vérifiés/à confirmer, statut commercial, suspension) | `Product`, `src/app/(app)/products/[id]`, `src/lib/portfolio/catalog.ts` | `portfolio-service`, `portfolio-rules`, E2E |
| Prospects sortants, provenance, date de collecte, base de contact | `Prospect`, `src/app/(app)/prospects` | idem |
| Déduplication globale (courriel, téléphone, société+nom) et intérêt multi-produits | `dedupeKeyOf`, `addProspect` | idem (dont création concurrente) |
| Réattribution explicite avec motif au journal | `reassignProspect` | idem |
| Import CSV contrôlé (vérification à blanc, rejets par ligne, 500 lignes max.) | `parseProspectCsv`, `importProspects` | idem |
| Éligibilité au contact (produit, canal, désinscription, base légale, fréquence, modèle approuvé, campagne concurrente) | `contactEligibility` | idem |
| Consignation des contacts et réponses par un humain (aucun envoi) | `logContact`, `logReply` | idem |
| Désinscription/opposition, tous produits, idempotente, liste de suppression | `optOutProspect` | idem |
| Modèles de messages avec approbation, campagnes de prospection avec approbation | `MessageTemplate`, `OutreachCampaign` | idem |
| Canaux de prospection, **désactivés par défaut** | `OutreachChannel` | idem |
| Conversions manuelles, anti double comptabilisation | `ProductEvent`, `eventDedupeKey` | idem |
| Vue portefeuille et indicateurs par produit | `/portfolio`, `portfolioStats` | idem, E2E |
| Attribution des leads entrants et campagnes publicitaires au produit (via l'offre) | `Lead.productId`, `Campaign.productId`, `Offer.productId` | `portfolio-service` |
| Droits : `manage_products` et `approve_outreach` (admin, propriétaire) | `src/lib/permissions.ts` | `portfolio-service` |

## Ce qui n'est PAS implémenté (état honnête)

- **Aucun envoi.** SEA Pilot ne contacte personne au nom des produits : le contact est envoyé par un humain, puis consigné.
- **Aucun webhook** des trois SaaS : la table `ProductEvent` accepte `source = "webhook"` et possède sa clé anti-doublon, mais rien n'est connecté. Les trois produits n'ont pas été modifiés.
- **Pas de dépenses marketing par produit** au-delà des campagnes publicitaires rattachées à un produit via leur offre.
- **Pas de sélection de produit sur les audiences ni les landing pages** dans l'interface (le champ `productId` existe).
- **Pas de scraping**, pas de recherche automatique de prospects, pas d'achat de listes.
- **Les arguments commerciaux et réponses aux objections** sont vides : ils doivent être rédigés puis approuvés par vous.
- Les fiches initiales proviennent d'un audit du 2026-10-09. `verified` signifie « présent dans le code audité », pas « fonctionne en production ».

## Conformité (à valider par un juriste — ce n'est pas un avis juridique)

Règles applicables à prendre en compte pour la prospection depuis le Canada/Québec : Loi canadienne anti-pourriel (LCAP/CASL), LPRPDE (PIPEDA), Loi 25 (Québec).

Ce que le module applique techniquement :
- Contact refusé sans **provenance**, **date de collecte** et **base de contact documentée**.
- Le consentement implicite par adresse publiée n'est accepté que pour un contact **professionnel (B2B)**.
- **Désinscription** : un prospect désinscrit est bloqué pour tous les produits ; son adresse entre dans la liste de suppression ; un import ultérieur de la même adresse arrive « ne pas contacter ».
- **Fréquence** : intervalle minimal et nombre maximal de contacts par canal.
- **Journal d'audit** de chaque création, contact, refus, réattribution et approbation.
- Un modèle de message modifié repasse en brouillon.

Points qui nécessitent une validation juridique :
1. Les conditions exactes du consentement implicite pour des adresses publiées (message pertinent pour la fonction de la personne, mention contraire).
2. L'identification de l'expéditeur, les coordonnées et le mécanisme de désinscription **dans chaque message** (à vérifier dans vos modèles).
3. L'utilisation de messages directs sur les réseaux sociaux (traités comme des messages commerciaux électroniques).
4. Les obligations Loi 25 : information des personnes sur la collecte, durée de conservation, droit d'accès et de retrait, politique de confidentialité.
5. La durée de conservation des prospects (aucune purge automatique n'existe aujourd'hui).

## Migration et retour arrière

- Fichier : `prisma/postgres/migrations/0002_multi_product_portfolio/migration.sql` (SQLite : `prisma db push` en développement).
- Contenu : 5 colonnes `productId` **nullables** (Audience, Offer, Campaign, LandingPage, Lead) + 8 nouvelles tables. Aucun `DROP`, `ALTER COLUMN`, `RENAME` ni `UPDATE`.
- Application : `prisma migrate deploy` s'exécute déjà en pré-déploiement sur Railway. **Elle n'a pas été appliquée en production** et ne doit l'être qu'après autorisation explicite.
- Retour arrière du code : revenir au commit précédent ; les colonnes et tables ajoutées restent inertes (ancien code les ignore).
- Retour arrière de la base (si nécessaire) : supprimer les 8 tables et les 5 colonnes ajoutées — uniquement après sauvegarde et décision explicite.
- Le script `scripts/gen-pg-schema.mjs` ne régénère plus jamais `0001_init` (déjà appliquée en production).

## Corrections de sécurité (revue du 2026-10-24)

- **Contact et modèle approuvé :** consigner un contact exige désormais un modèle **approuvé**, du même produit et du même canal. « Aucun modèle » est refusé (avant : le contrôle était sauté).
- **Statut :** un contact ne fait passer un prospect à « contacté » que depuis « identifié » ; démo, essai, client et « a répondu » ne reculent plus.
- **Droit d'accès :** l'export de l'espace (`/api/export`) inclut produits, prospects, intérêts, contacts consignés, modèles, canaux, campagnes de prospection et conversions.
- **Droit à l'effacement :** « Effacer ce prospect » (administrateur ou propriétaire) supprime les données personnelles et l'historique de contacts, anonymise la fiche et ne conserve l'adresse que dans la liste de suppression. Les conversions déjà comptées sont gardées sans note libre.
- **Duplication de campagne :** la copie conserve son produit.
- **Reste à faire :** recherche de prospects insensible à la casse sur PostgreSQL ; durée de conservation et purge automatique ; validation juridique.
