# Lot 3 — produit pilote : DriverPilot

Constats observés le 2026-10-27 (pages publiques consultées en lecture seule) et dans le code (`src/lib/portfolio/catalog.ts`) :

| | DriverPilot | FreelanceNexa | OperaPilot |
|---|---|---|---|
| Site public | en ligne ; titre, valeur, appels à l'action vers `/register` et `/pricing` | en ligne ; page de connexion seulement, aucun argumentaire | aucune URL (non déployé) |
| Tarifs | affichés (9,99 $/mois, 89 $/an), devise non nommée | aucun | aucun |
| Essai | 30 jours sans carte annoncé | 30 jours (code) | aucun |
| Inscription | `/register` | `/register` | aucune |
| Fonctionnalités vérifiées dans le code | 7 sur 9 | 4 sur 5 | flux testé avec une IA simulée |
| Statut dans SEA Pilot | validation | préparation | préparation |

Choix : **DriverPilot**, seul produit avec un parcours public complet de bout en bout (promesse → inscription) et un tarif visible.
Réserves constatées (non corrigeables depuis SEA Pilot) : aucune page légale liée dans le pied de page du site public ; devise des tarifs non confirmée ;
aucun appel du produit vers `/api/v1/product-events` (inscriptions et paiements restent à saisir à la main).
Ces faits proviennent d'une consultation ponctuelle et peuvent changer : à re-vérifier avant toute campagne.
