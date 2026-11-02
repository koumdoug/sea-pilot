# Moteur de relances : fiabilité, bail, envoi d'e-mail et reprise

Aucun secret, aucune URL de base dans ce document. Code : `src/lib/followup-runtime.ts` (bail, transactions, autorisation), `src/lib/followups.ts` (inscription, révocation, exécution),
`src/lib/followup-send.ts` (envoi d'e-mail), `src/lib/followup-review.ts` (résolution humaine), `src/lib/email.ts`, `src/lib/leads.ts` (désinscription, effacement).

## 1. Principes

- Une relance « running » appartient à UN exécuteur : `leaseToken` (jeton unique) et `leaseUntil` (bail de 5 minutes). Toute écriture finale est conditionnée par le jeton.
- Une ancienne ligne « running » SANS jeton (antérieure à ce mécanisme) n'est jamais reprise automatiquement (§6).
- **Autorisation métier plafonnée à 3** : l'incrément de `attemptCount` et le contrôle `attemptCount < 3` sont UNE instruction atomique (dans la transaction d'autorisation). Au plafond, la relance
  passe explicitement en `failed / exhausted` (jamais en attente). Une transaction annulée n'incrémente rien.
- **Échecs techniques** (`technicalFailureCount`) : transaction annulée avant tout effet, abandon constaté à la reprise. Report progressif : 1 min, 2, 4… plafonné à 24 h ; au 12e échec : `needs_review`.
  Les deux compteurs sont indépendants : un échec technique ne consomme jamais une autorisation métier.
- Aucun appel réseau dans une transaction. Transactions : `timeout 10 000 ms`, `maxWait 5 000 ms` ; deux reprises au plus (attente aléatoire 100–400 ms) sur P2034, P2028, P1008 — seulement quand la transaction a été annulée
  avant tout effet. **Constat (Prisma 6.19.3, PostgreSQL 18)** : un verrou mortel PostgreSQL (SQLSTATE 40P01) n'est pas exposé sous le code P2034 mais comme `PrismaClientUnknownRequestError` sans code ;
  `transactionErrorCode` le normalise en P2034.
- Ordre de verrouillage : **Séquence → Relance → Prospect → données dérivées**. Tout état « pending » naît sous le verrou de la séquence (inscription, remise en file, replanification).

## 2. États

`FollowUp.status` : pending, running, done, blocked, failed, cancelled, needs_review (skipped inutilisé). `failureKind` : technical, business, exhausted, technical_persistent, email_uncertain, revoked, sequence_inactive.

`EmailLog.status` (résultat du FOURNISSEUR uniquement) :

| État | Sens |
|---|---|
| `attempting`, `callStartedAt` nul | intention enregistrée ; aucun appel commencé (par construction : l'appel n'a lieu qu'après la marque) |
| `attempting`, `callStartedAt` posé | l'appel a POTENTIELLEMENT commencé ; ne prouve pas la transmission ; jamais de renvoi automatique |
| `sent` | accepté par le fournisseur (2xx, même sans corps lisible) |
| `failed` | refus explicite (4xx, hors 409) |
| `uncertain` | 5xx, 409, délai dépassé, erreur réseau : peut-être accepté |
| `aborted` | aucun appel commencé |

La décision humaine vit dans d'autres colonnes (`humanVerdict`, `humanVerdictAt`, `humanVerdictById`, `humanNote`) : jamais mélangée avec le résultat du fournisseur. Une contradiction
(`confirmed_not_sent` + `sent`, ou `confirmed_sent` + `failed|aborted`) est un état dérivé : elle n'ouvre jamais un renvoi et doit être acquittée avec preuve.

## 3. Envoi d'un e-mail (T2 → P1 → P3 → P4 → P2′ → P5 → T3)

1. Réconciliation des tentatives existantes (reprise) : `attempting` sans marque → `aborted` (compare-and-set) ; une tentative `sent` finalise SANS renvoyer ; `uncertain` ou marque posée → `needs_review`.
2. **T2** (transaction) : séquence (mise à jour conditionnelle `active = true`, verrou) → relance (jeton, `attemptCount + 1`, bail) → prospect (éligibilité et verrou sans modifier `updatedAt`) → liste de suppression → ligne de tentative `el:<relance>:<n>`.
3. **P1** fraîcheur (≤ 10 s ; horloge de la base sous PostgreSQL) → **P3** une instruction : bail, séquence active avec envoi autorisé, prospect éligible et adresse inchangée → **P4** garde locale (> 2 s, horloges murale ET monotone)
   → **P2′** marque `callStartedAt` (compare-and-set, dernier contrôle du prospect) → **P5** appel fournisseur (hors transaction, clé d'idempotence `fu:<relance>:<n>`).
4. Résultat écrit dans SA tentative (indépendant du bail) ; **T3** finalise la relance sous jeton. Un jeton périmé (révocation, reprise) : rien n'est écrit sur la relance, jamais de réactivation.
5. Révocation après la marque d'appel : l'envoi autorisé part ; événement d'audit `email.sent_after_revocation` (sans donnée personnelle).

Limites inévitables : entre P2′ et l'envoi réel des octets (quelques millisecondes en fonctionnement normal) une tentative est classée « potentiellement commencée » ; un envoi dont l'appel a commencé ne peut pas être rappelé ;
une suspension du processus après P4 n'est pas détectable ; la clé d'idempotence du fournisseur n'est une protection qu'à l'intérieur de sa fenêtre (24 h) et n'est pas une garantie.

## 4. Révocation, séquences, inscription

- Désinscription et effacement : UNE transaction ; **première instruction** = annulation de toutes les relances du prospect (y compris `running` : jeton effacé, `failureKind = revoked`).
- Désactivation d'une séquence : annule `pending` et `blocked` dans la même transaction ; suppression : désactivation, annulation, suppression (relances restantes : `sequenceId = NULL`). `running` n'est jamais annulée aveuglément :
  son exécuteur contrôle la séquence sous verrou. `needs_review` est conservée.
- Inscription : une transaction (séquence verrouillée, prospect verrouillé, relances créées). `pending`, `running` et `needs_review` bloquent une réinscription à la même séquence.

## 5. Résolution humaine (administrateurs, permission `approve_outreach`)

Actions : finaliser (e-mail accepté, sans renvoi), marquer envoyé / non envoyé (note ≥ 15 caractères + confirmation ; jamais présenté comme une acceptation du fournisseur), annuler, replanifier (aucun effet externe possible),
renvoyer (confirmation obligatoire ; mot « RENVOYER » après 24 h ; clé d'idempotence réutilisée seulement ≤ 23 h avec un contenu identique), acquitter une contradiction (note ≥ 20 caractères + « COMPRIS »).
Chaque décision est une transaction dont la première instruction est conditionnelle sur l'état vu : une résolution concurrente n'est jamais écrasée.

## 6. Anciennes lignes « running » sans bail : diagnostic (lecture seule, à lancer par l'exploitant)

```sql
SELECT id, "workspaceId", "leadId", action, "dueAt", "executedAt" FROM "FollowUp"
WHERE status = 'running' AND "leaseToken" IS NULL ORDER BY "dueAt";
```

Elles apparaissent dans « À examiner » (automatisations) avec leurs actions : annuler, replanifier (tâche, rappel, changement de statut), marquer envoyé / non envoyé (e-mail). Aucune conversion automatique, aucune donnée modifiée par la migration.

## 7. Migration

Additive (aucune colonne ni table supprimée). PostgreSQL : `0006_followup_lease_email_attempts`. SQLite : `20261101120000_followup_lease_email_attempts` (la chaîne SQLite de ce dépôt n'est pas tenue à jour pour les migrations antérieures : les bases de développement et de test utilisent `prisma db push`).
Ordre : migration d'abord, code ensuite ; l'ancien code reste compatible (colonnes nullables ou valeur par défaut ; il ne sélectionne que `pending`). Retour arrière : revenir au code précédent suffit ; les lignes `needs_review` restent invisibles pour l'ancien code.

## 8. Tests

`npm test` (SQLite), `npm run test:pg` (PostgreSQL jetable : verrous, attentes et verrous mortels réels, voir `validation-postgresql-stripe.md`). Fichiers : `tests/followup-lease.test.ts`, `tests/followup-email-send.test.ts`,
`tests/followup-review.test.ts`, `tests/pg-followup-lease.test.ts`. Complétés ensuite par : `tests/followup-corrections.test.ts` (changement d'adresse et consentement, acquittement des contradictions, `status_change` sans écrasement, renvoi manuel), `tests/followup-final.test.ts` (règle de statut automatique, décision humaine après un conflit de statut, consentement), `tests/lead-erasure.test.ts` (effacement : données, périmètre, atomicité), `tests/suppression-keys.test.ts` (liste de suppression : clé absente ou refusée, clé dédiée, rotation, migration progressive), `tests/suppression-audit.test.ts` (configuration de la clé côté Leads et Portfolio, rotation, comptage de migration, journaux sans donnée personnelle), ainsi que, **réservés à PostgreSQL et ignorés sous SQLite** (connexions multiples réelles), `tests/pg-late-result.test.ts` (résultat fournisseur tardif contre effacement) et `tests/pg-suppression-backfill.test.ts` (backfill de la liste de suppression contre la concurrence). Les arrêts du processus sont simulés par des points d'interruption (`setSendHooksForTests`, `SimulatedCrash`) et par l'annulation de transactions.

## 9. Consentement et changement d'adresse

**Règle technique (aucun avis juridique)** : une nouvelle adresse n'hérite jamais de l'autorisation marketing de l'ancienne. Point unique : `updateLeadDetails` (`src/lib/leads.ts`), utilisé par l'action de la fiche prospect. Aucune route de l'API ne modifie l'adresse d'un prospect existant
(`/api/v1/leads` ne fait que créer) ; `createLead` et `eraseLead` sont les seuls autres écrivains de `Lead.email`.

Lors d'un changement d'adresse **normalisée** (minuscules, espaces retirés), dans UNE transaction (ordre FollowUp → Lead → données dérivées) :
- les relances **e-mail** « pending » et « blocked » sont annulées (`failureKind = email_changed`) ; les étapes non e-mail continuent ; une relance « running » n'est pas touchée : elle s'abandonne d'elle-même (le contrôle juste avant l'appel compare l'adresse et le consentement) ;
- `consentMarketing` passe à faux ; une ligne `Consent` « granted: false » est écrite pour l'ANCIENNE adresse (source `email_changed`) et une activité « consent » est ajoutée ; audit `lead.email_changed` sans aucune adresse ;
- les coordonnées sont écrites de façon conditionnelle à la version lue : deux modifications concurrentes sont relues, jamais écrasées ;
- aucun message n'est envoyé. La désinscription (`unsubscribedAt`) et la liste de suppression restent prioritaires et inchangées ; un consentement ne peut pas être enregistré pour un prospect désinscrit.

Un nouvel envoi exige un consentement enregistré pour la nouvelle adresse : case « consentement attesté » du formulaire (ligne `Consent` « granted: true », source `manual_email_change`), ou création du prospect avec consentement.
**Défense en profondeur** : `prepareFollowUpEmail` et la transaction d'autorisation exigent que la DERNIÈRE ligne `Consent` marketing de l'adresse EXACTE du prospect soit accordée ; une écriture directe de l'adresse en base ne contourne donc pas la règle (l'envoi est bloqué avec une tâche manuelle).
Un prospect dont le consentement n'a jamais été journalisé dans `Consent` (importé hors `createLead`) est donc bloqué : choix prudent.

**Nature des consentements enregistrés (à ne pas confondre)**
- Une ligne `Consent` porte : **adresse** concernée (`email`), **accordé ou refusé** (`granted`), **source** (`source`), **texte** montré ou attesté (`text`), **date** (`createdAt`), empreinte IP éventuelle. Le prospect porte aussi `consentMarketing`, `consentAt`, `consentText`.
- Consentement **obtenu auprès du prospect** : formulaire public (source `form`, texte du formulaire, empreinte IP). Consentement **attesté par un utilisateur du SaaS** : saisie manuelle (source `manual`, texte « Consentement déclaré par l'utilisateur… ») et modification de fiche (source `manual_email_change`, texte « Consentement attesté par l'utilisateur… »).
- **Limite constatée** : un lead créé par l'API (`/api/v1/leads`, consentement « attesté par l'appelant ») est journalisé avec la source `manual`, faute de formulaire : la source seule ne distingue pas une saisie manuelle d'une attestation d'appelant API (seul `consentText` les distingue). Aucune preuve indépendante n'est vérifiée par SEA Pilot pour une attestation.
- Les relances annulées lors d'un changement d'adresse ne sont **jamais** réactivées automatiquement, même après un consentement explicite pour la nouvelle adresse (réinscription manuelle).

**Décisions juridiques non prises ici** : valeur d'un consentement attesté par un utilisateur du SaaS (`manual_email_change`) ; durée de conservation des lignes de consentement ; nécessité d'un consentement renouvelé par le prospect lui-même ; sort des relances annulées (réinscription manuelle).

## 10. Changement de statut automatique (`status_change`)

**Règle : une relance automatisée ne doit jamais écraser une progression commerciale déjà enregistrée** (`autoStatusChangeBlockedBy`, `src/lib/constants.ts`). Rang du pipeline : new (0) < contacted (1) < qualified (2) < proposal (3).
- Clôture (« lost », « disqualified ») d'un prospect déjà « qualified » ou « proposal » : **non appliquée** (la clôture « sans réponse » n'est plus vraie).
- Retour en arrière dans le pipeline (statut cible de rang inférieur au statut réel) : **non appliqué**.
- « new » et « contacted » ne sont pas des progressions (« contacted » est notre propre prise de contact) ; « won » n'est jamais bloqué ; un prospect déjà terminal annule simplement la relance (arrêt normal des relances).
- Dans les deux cas (`failureKind = status_progressed`) la relance passe en **needs_review** avec une raison explicite, le prospect n'est pas modifié (aucune colonne), une notification et un audit `followup.status_not_applied` (statuts seulement) sont écrits.
- **Conflit d'état** (`status_conflict`) : statut modifié entre la lecture et l'écriture (écriture conditionnelle au statut observé) ou depuis le début d'une réservation abandonnée (reprise après arrêt) : même traitement.
- **Décision humaine** (administrateur, `approve_outreach`) : « Appliquer le statut quand même » (note de 15 caractères au moins + confirmation ; l'auteur est enregistré dans l'historique ; étapes restantes arrêtées si le statut est terminal), « Annuler » (le prospect reste inchangé), « Replanifier » (permis pour un simple conflit d'état, refusé pour une progression : la relance re-bloquerait aussitôt).
- Le chemin **manuel** (décision explicite d'un utilisateur) n'est pas concerné par cette règle ; il réapplique sa décision sur l'état réel (3 essais) avec un historique exact. Autres écrivains du statut inspectés : qualification automatique (`new` → `qualified` seulement), premier contact sortant (`new` → `contacted`), tous via `changeLeadStatus` (écriture conditionnelle).

**Justification et changement de comportement à confirmer par le métier** : auparavant « lost » s'appliquait à tout prospect non terminal. Désormais un prospect « chaud » qualifié automatiquement à sa création n'est plus clôturé automatiquement au jour 14 : la relance est présentée pour décision. Ce choix prudent évite la perte silencieuse d'une opportunité ; il peut être ajusté en modifiant `autoStatusChangeBlockedBy`.

## 11. Interface

L'acquittement d'une contradiction est proposé dans la liste des contradictions (y compris pour une relance déjà « blocked » ou « done »), avec l'action serveur et la permission `approve_outreach` existantes. Le message d'un renvoi décrit la transition réellement effectuée ; un audit `followup.resend_result` (identifiants et états, jamais d'adresse)
complète l'audit d'intention `followup.resolved`. Le renvoi ne garantit jamais l'absence de doublon : il est refusé tant que la tentative précédente, dont l'appel a commencé, date de moins d'une minute (résultat tardif encore possible ; `RESEND_MIN_WAIT_MS`), mais le fournisseur a pu accepter une requête déjà abandonnée côté client. Classification HTTP 409 inchangée : incertain.

## 12. Limite connue : chaîne de migrations SQLite

`prisma/migrations` ne contient que la migration initiale (2026-10-06) et la migration additive `20261101120000_followup_lease_email_attempts` ; les évolutions intermédiaires (StripeEvent, ContentItem, colonnes d'abonnement, etc.) n'y figurent pas. Les bases SQLite de développement et de test sont créées par `prisma db push`,
qui suit `prisma/schema.prisma`. Un `prisma migrate deploy` SQLite produirait donc une base INCOMPLÈTE : ne pas l'utiliser. La production et la préproduction utilisent PostgreSQL (`prisma/postgres/migrations`, chaîne complète vérifiée de 0001 à 0006). Aucune refonte de la chaîne SQLite n'est faite ici.


## 13. Effacement d'un prospect (`eraseLead`)

Une seule transaction (tout ou rien) ; chaque requête est limitée à l'espace de travail du prospect. Aucune migration : le schéma existant suffit.

| Donnée | Traitement | Finalité de la conservation / justification |
|---|---|---|
| Fiche `Lead` | nom, e-mail, téléphone, société, message, `customFields`, motif de perte, IP, référent, URL, texte de consentement effacés ; fiche anonyme conservée | statuts, dates, montant, attribution : statistiques et compteurs |
| `Customer` lié | identité anonymisée, montant conservé, contacts du client supprimés ; **non touché si un autre prospect actif le partage** | comptabilité agrégée |
| `Conversation`, `Contact` du prospect, `AIQualification`, `LeadActivity`, `Task` | supprimés | contenu personnel, sans finalité après effacement |
| `Notification` | supprimées (lien `/leads/<id>`) | titre/corps contiennent nom, société ou e-mail ; sans clé étrangère, retrouvées par le lien |
| `EmailLog` | **anonymisé** : adresse, objet, erreur, notes retirés ; statut fournisseur, identifiants techniques, horodatages conservés | preuve d'un envoi éventuel ; un résultat tardif reste enregistrable ; l'audit `email.in_flight_at_revocation` référence une ligne qui existe encore |
| `FollowUp` | relances actives annulées ; texte du résultat remplacé | un message d'erreur du fournisseur peut contenir l'adresse |
| `AnalyticsEvent` | rattachement au prospect et à la session retirés ; agrégats conservés | comptages par page, type, campagne |
| `EmailSuppression` | ligne en clair remplacée par `erased:<SHA-256(espace\|adresse)>` ; `isEmailSuppressed` cherche les deux formes | empêcher toute nouvelle sollicitation sans stocker l'adresse |
| `Consent` | **conservé, pseudonymisé** (adresse → empreinte, IP retirée) ; `KEEP_CONSENT_PROOF_AT_ERASURE` = `false` les supprimerait | preuve de consentement : **décision juridique non tranchée** |
| `AuditLog` | conservé tel quel ; `lead.erased` ne contient aucune donnée personnelle | intégrité de la traçabilité |

Limites assumées, sans règle juridique inventée :

- Sans clé dédiée, l'empreinte de suppression est une **pseudonymisation sans secret** : une adresse devinée peut être confirmée. Avec `SUPPRESSION_HMAC_KEY`, voir § 15.
- Un résultat fournisseur tardif ne peut plus réintroduire de donnée personnelle dans le journal : voir § 14.
- Les désinscriptions simples restent en clair TANT QU'AUCUNE clé dédiée n'est configurée ; avec une clé, les nouvelles entrées sont au format HMAC et les anciennes se migrent progressivement (§ 15).
- Les `Prospect` du module portefeuille (prospection sortante) sont un autre jeu de données : non touchés ; leur recherche de suppression utilise la même fonction.
- Sont à valider juridiquement : conservation de la preuve de consentement, durée, valeur de la pseudonymisation, conservation du montant client, texte de la page de confidentialité (« les données sont alors effacées »).

Changement de comportement (relu par rapport à l'ancien code) : le journal d'e-mails n'est plus supprimé mais anonymisé ; les consentements ne sont plus supprimés mais pseudonymisés ; la liste de suppression ne contient plus l'adresse en clair pour un effacement.


## 14. Résultat fournisseur tardif et effacement

**Identification** : une tentative d'envoi = une ligne `EmailLog` d'identifiant déterministe `el:<followUpId>:<n>`, créée par la transaction d'autorisation (T2) et réécrite UNE seule fois, tant que son statut est `attempting` (écriture conditionnelle, idempotente). `eraseLead` anonymise les lignes du prospect (adresse, objet, erreur, notes) sans changer leur statut ; un résultat tardif retrouve donc sa ligne par son identifiant.

**Défaut constaté (reproduit par `tests/email-late-result.test.ts` avant correction)** : le résultat tardif réécrivait `error` avec `errMsg(e)` — le texte d'une exception ou d'un `EmailError` du fournisseur — puis ce texte était aussi recopié dans le résultat de la relance. Un texte qui cite l'adresse ou le nom du prospect réapparaissait dans un journal pourtant anonymisé. Constat d'audit : `ResendProvider` ne produit que des messages fixes (`Resend HTTP <statut>`, `Resend injoignable…`) ; le risque concernait donc un autre fournisseur, une exception inattendue ou un futur fournisseur, pas le comportement observé de Resend (non validé en réel). Les autres envois (`sendFollowUpEmail`, ancien chemin) avaient le même défaut ; l'e-mail système n'écrit pas dans `EmailLog`.

**Correction** :
1. `storableProviderError` (`src/lib/email.ts`) : seuls les messages fixes de notre code sont conservés ; tout autre texte devient un libellé neutre (« Refus du fournisseur (HTTP 422) », « Résultat indéterminé (HTTP 502) », « … erreur technique du fournisseur »). Le filtre est à la SOURCE : le texte stocké ne peut pas contenir de donnée personnelle, quel que soit l'ordre d'exécution d'un effacement concurrent.
2. `recordProviderOutcome` (`src/lib/followup-send.ts`) : deux écritures conditionnelles atomiques — prospect non effacé (`lead.deletedAt IS NULL` dans la même instruction) : résultat complet ; sinon : champs techniques seulement (statut, identifiant fournisseur, statut HTTP, date) et libellé neutre. Utilisée par l'écriture indépendante du bail ET par la finalisation T3.
3. Acquittement d'une contradiction (`ack_contradiction`) : même schéma ; la note libre n'est pas conservée pour un prospect effacé.

**Non modifié** : la gestion des résultats incertains (jamais renvoyés automatiquement), le suivi des tentatives, l'idempotence (un second résultat ne réécrit rien).

## 15. Liste de suppression : clé dédiée, formats, rotation

**Formats de `EmailSuppression.email` (tous reconnus en lecture)** : (1) adresse normalisée en clair ; (2) `erased:<SHA-256(espace|adresse)>` (effacements sans clé) ; (3) `h1:<kid>:<HMAC-SHA256(clé, "suppression|espace|adresse")>`, `kid` = identifiant public de 12 hex de la clé. Normalisation unique : `trim` + minuscules (`normalizeEmail`), appliquée à l'écriture, à la lecture et à l'import. Isolation : toutes les requêtes portent sur l'espace et le HMAC lie l'adresse à l'espace.

**Configuration (non appliquée à Railway par ce lot)** :
- `SUPPRESSION_HMAC_KEY` : clé courante, 32 caractères au moins, distincte de `SESSION_SECRET` et `ENCRYPTION_KEY` (une clé réutilisée ou trop courte est REFUSÉE avec un motif journalisé, jamais sa valeur).
- `SUPPRESSION_HMAC_KEY_PREVIOUS` : anciennes clés (virgules), en lecture seule.
- Clé absente ou refusée : repli SÛR et explicite — jamais un blocage en moins : désinscription et opposition en clair (comme avant), effacement par l'empreinte du format 2 ; avertissement `suppression.key_missing` journalisé ; `npm run check:env` signale l'absence.

**Rotation** : les HMAC ne sont pas réversibles ; les anciennes entrées ne peuvent pas être réécrites sans l'adresse. Une rotation exige donc de conserver l'ancienne clé dans `SUPPRESSION_HMAC_KEY_PREVIOUS` aussi longtemps que ses entrées existent. Si une clé est retirée sans être conservée, l'espace qui contient des entrées `h1:` de cette clé passe en **échec fermé** (`unknown_key`) : plus aucun envoi marketing n'y part et le motif est affiché (« Liste de suppression protégée par une clé inconnue… »). Aucune adresse n'est réautorisée en silence. Sortie de cette situation : restaurer la clé (courante ou `PREVIOUS`) ; renoncer volontairement à ces entrées (suppression SQL manuelle) est une décision métier qui réautorise ces adresses — non automatisée.

**Entrées en clair — origines** : désinscription d'un prospect (`unsubscribeLead`), effacement d'un prospect (`eraseLead`), opposition et effacement d'un prospect sortant (`optOutProspect`, `eraseProspect`, module portefeuille). Aucun import. Toutes passent désormais par `suppressionWriteKey`. Toutes les recherches (`email.ts`, relances, portefeuille) passent par `suppressionStatus`.

**Migration progressive et réversible** (`backfillSuppressionKeys`, jamais lancée automatiquement, base ciblée explicitement) : simulation par défaut → ajout additif des HMAC à côté des lignes en clair → suppression des lignes en clair seulement après vérification de l'entrée HMAC. Retour arrière : possible tant que les lignes en clair existent ou que la fiche du prospect conserve l'adresse ; impossible pour un prospect effacé. Les entrées `erased:` ne sont pas convertibles (adresse inconnue) et restent valides.

**Limites** : une adresse devinée peut toujours être confirmée par quiconque détient la clé ; sans clé, par quiconque lit la base (formats 1 et 2). Le format 2 ne peut pas être remplacé tant que les adresses concernées sont inconnues. Aucune durée de conservation n'est fixée.


## 16. Audit du mécanisme de suppression (lot 3) : constats démontrés par test

**Backfill (`backfillSuppressionKeys`)** — ordre garanti dans un appel : écriture de l'entrée HMAC (instruction autonome, validée) → relecture → contrôle d'exploitabilité → suppression du clair. Démontré sur PostgreSQL avec deux connexions (et un second client Prisma qui lit depuis l'extérieur : le HMAC est visible, validé, tant que le clair existe encore).
- *Défaut 1 (corrigé)* : deux backfills simultanés, ou un backfill simultané d'un effacement, levaient une erreur Prisma (`upsert` : course sur la contrainte d'unicité ; `delete` par identifiant : ligne déjà supprimée). Aucune adresse n'était libérée, mais le traitement s'arrêtait en cours de route. Désormais : création tolérante à la course (l'entrée est relue), suppression par `deleteMany`.
- *Défaut 2 (corrigé)* : le clair était supprimé dès que l'entrée HMAC existait, même si la configuration de clés avait changé entre-temps (entrée devenue illisible pour la recherche d'envoi). Désormais le clair n'est supprimé que si la recherche d'envoi, avec la configuration ACTUELLE, retrouve l'entrée (`keptUnverified` compte les cas contraires).
- Désinscription concurrente : sans effet (trois désinscriptions simultanées de la même adresse, avec et sans clé, 16 passages : aucune erreur, une seule entrée). Effacement concurrent : le backfill attend le verrou de l'effacement, puis termine ; jamais d'adresse libérée ni de doublon.
- Arrêt simulé entre la création du HMAC et la suppression du clair : clair ET HMAC présents, adresse bloquée ; la reprise termine. Disparition de l'entrée HMAC avant vérification : le clair est conservé.
- Journal : le backfill émet une ligne `suppression.backfill` (comptages et identifiant public de clé, aucune adresse).

**Configuration dégradée** — pour TOUTES les configurations dégradées (clé absente, trop courte, blanche, identique à `SESSION_SECRET` ou `ENCRYPTION_KEY`, clé B sans A, précédente absente ou mal formée) quand l'espace contient des entrées `h1:` : aucun envoi marketing ne part (Leads et Portfolio), avec le motif explicite « Liste de suppression protégée par une clé inconnue… ». Les configurations saines (clé entourée de guillemets, précédente correcte, plusieurs précédentes, doublons et segments vides) se comportent comme le témoin. Une nouvelle désinscription est toujours enregistrée (en clair si aucune clé valide n'existe), et reconnue immédiatement.
- *Défaut 3 (corrigé)* : en configuration dégradée, `addProspect` créait la fiche « ne pas contacter » avec une date d'opposition (état définitif) ; le message d'éligibilité du Portfolio parlait à tort d'une « désinscription ». Désormais : aucune fiche n'est créée (erreur explicite) et le motif d'éligibilité est celui de la clé inconnue.
- **Conséquence métier d'un blocage global** : un espace qui contient des entrées HMAC d'une clé perdue ne peut plus envoyer ni importer de nouveaux prospects tant que la clé n'est pas restaurée. C'est le prix de l'échec fermé ; la sortie est la restauration de la clé (`SUPPRESSION_HMAC_KEY` ou `SUPPRESSION_HMAC_KEY_PREVIOUS`). Une entrée `h1:` à identifiant connu mais à empreinte illisible est inerte (comptée dans `malformedKeyed`) ; une entrée `h1:` à identifiant illisible déclenche l'échec fermé.

**Rotation** : A → B (A précédente) → nouvelle entrée sous B reconnue aussitôt → A retirée (échec fermé, jamais de réautorisation) → A restaurée → plusieurs précédentes → précédente mal configurée : vérifié sur SQLite et PostgreSQL. Condition d'exploitation : la clé utilisée pour migrer doit être celle de TOUTES les instances de l'application ; une instance qui ne la connaît pas passe en échec fermé.

**Journaux** — *Défaut 4 (corrigé)* : le masquage du journal ne portait que sur les NOMS de champs ; un texte d'erreur (exception, message de base de données) contenant une adresse ou une empreinte sortait tel quel. Le masquage porte désormais aussi sur les valeurs (adresses e-mail, empreintes `h1:` et `erased:`). Un avertissement `suppression.unknown_key` (identifiants publics de clés et motifs de refus, jamais une valeur de clé) est émis une fois par espace. Vérifié : aucune sortie de journal ni ligne d'audit ne contient clé, adresse, nom ou empreinte pour la désinscription, l'effacement, le backfill, la rotation, la clé inconnue ou absente, et l'envoi accepté, refusé ou incertain.

**Limites restantes** : rien n'a été migré sur une base réelle ; une adresse devinée reste confirmable par qui détient la clé ; les entrées `erased:` ne sont pas convertibles ; aucune durée de conservation n'est fixée.
