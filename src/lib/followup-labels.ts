/** Libellés affichés pour les états d'envoi d'e-mail et les relances à examiner. Le résultat du FOURNISSEUR et la décision HUMAINE sont toujours présentés séparément. */

type AttemptLike = { status: string; callStartedAt: Date | null; humanVerdict?: string | null };

/** `attempting` n'est JAMAIS présenté comme « Envoyé ». */
export function emailAttemptLabel(a: AttemptLike): string {
  switch (a.status) {
    case "attempting": return a.callStartedAt ? "Envoi potentiellement effectué — vérification nécessaire" : "Intention enregistrée — appel fournisseur non commencé";
    case "sent": return "Accepté par le fournisseur";
    case "failed": return "Refusé par le fournisseur";
    case "uncertain": return "Résultat incertain (délai dépassé, erreur réseau ou erreur serveur)";
    case "aborted": return "Non envoyé (annulé avant l'appel)";
    default: return a.status;
  }
}

export function verdictLabel(v: string | null | undefined, providerStatus: string): string | null {
  if (v === "confirmed_sent") return providerStatus === "sent" ? "Confirmé envoyé par un administrateur" : "Confirmé envoyé par un administrateur (vérification humaine, non confirmée par le fournisseur)";
  if (v === "confirmed_not_sent") return "Déclaré non envoyé par un administrateur";
  return null;
}

export const FOLLOWUP_KIND_LABEL: Record<string, string> = {
  email_uncertain: "E-mail incertain : le message a peut-être été accepté par le fournisseur. Vérifiez avant tout renvoi.",
  technical_persistent: "Échec technique persistant : aucune action métier n'a pu aboutir.",
  exhausted: "Plafond d'autorisations atteint.",
  technical: "Erreur technique avant exécution.",
  business: "Erreur de configuration de l'étape.",
  revoked: "Annulée par un retrait de consentement ou un effacement.",
  email_changed: "Annulée : l'adresse e-mail du prospect a été modifiée (le consentement de l'ancienne adresse ne s'applique pas à la nouvelle).",
  status_progressed: "Le prospect a progressé commercialement : le changement automatique n'a pas été appliqué pour ne pas écraser cette progression. Décision humaine requise (appliquer, annuler).",
  status_conflict: "Le statut du prospect a changé pendant le traitement : l'étape n'a pas été appliquée pour ne pas écraser une décision plus récente.",
  sequence_inactive: "Séquence désactivée ou supprimée.",
};

export function reviewReason(it: { status: string; failureKind: string | null; legacy: boolean }): string {
  if (it.legacy) return "Ancienne relance « en cours » sans bail : interrompue avant la mise en place du bail, jamais reprise automatiquement. Vérifiez ce qui a été exécuté.";
  return (it.failureKind && FOLLOWUP_KIND_LABEL[it.failureKind]) || "À examiner par un administrateur.";
}
