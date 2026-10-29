// Produit pilote du premier parcours d'acquisition : DriverPilot.
// Choix fondé sur des constats observables (voir docs/lot3-produit-pilote.md) : site public en ligne avec appel à l'action vers l'inscription,
// essai gratuit de 30 jours annoncé, tarifs affichés, fonctionnalités vérifiées dans le code, statut « validation » (les deux autres sont en préparation,
// FreelanceNexa n'a ni page de présentation ni tarif, OperaPilot n'est pas déployé).
export const PILOT_PRODUCT_SLUG = "driverpilot";
export const isPilotProduct = (slug: string) => slug === PILOT_PRODUCT_SLUG;

export type ReadinessInput = {
  product: { status: string; publicUrl: string | null; signupUrl: string | null; pricing: unknown; unconfirmed: unknown; salesArguments: unknown; objections: unknown };
  pages: { status: string; hasActiveForm: boolean }[];
  webhookEvents: number;
  linkedAdCampaigns: number;
  approvedTemplates: number;
};
export type ReadinessCheck = { id: string; label: string; ok: boolean; detail: string; blocking: boolean };

const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/** Liste de contrôle factuelle avant d'acquérir des prospects. « blocking » = sans cela, le parcours ne produit pas de prospect exploitable. */
export function acquisitionReadiness(i: ReadinessInput): { checks: ReadinessCheck[]; ready: boolean } {
  const plans = arr((i.product.pricing as { plans?: unknown } | null)?.plans) as { verified?: boolean; currency?: string | null }[];
  const live = i.pages.filter((p) => p.status === "published" && p.hasActiveForm).length;
  const args = arr(i.product.salesArguments) as { approved?: boolean }[];
  const objs = arr(i.product.objections) as { approved?: boolean }[];
  const checks: ReadinessCheck[] = [
    { id: "landing", label: "Landing page publiée avec formulaire actif", ok: live > 0, blocking: true, detail: live > 0 ? `${live} page(s) publiée(s) liée(s) au produit.` : "Aucune page publiée avec formulaire actif n'est liée au produit : aucun prospect ne peut être capté. Créez une page depuis une offre rattachée au produit." },
    { id: "signup", label: "URL d'inscription du produit renseignée", ok: !!i.product.signupUrl, blocking: true, detail: i.product.signupUrl ? "Renseignée." : "Absente : le parcours ne peut pas mener à l'inscription." },
    { id: "public", label: "URL publique du produit renseignée", ok: !!i.product.publicUrl, blocking: false, detail: i.product.publicUrl ? "Renseignée." : "Absente." },
    { id: "status", label: "Statut « commercialisation »", ok: i.product.status === "commercialisation", blocking: false, detail: i.product.status === "commercialisation" ? "Prospection sortante autorisée." : "Tant que le produit n'est pas en commercialisation, la prospection sortante reste bloquée (la capture entrante par landing page reste possible)." },
    { id: "pricing", label: "Tarif confirmé avec devise", ok: plans.some((p) => p.verified && !!p.currency), blocking: false, detail: plans.some((p) => p.verified && !!p.currency) ? "Au moins un plan confirmé." : "Aucun plan confirmé avec sa devise : ne citez aucun prix dans les messages." },
    { id: "unconfirmed", label: "Points « à confirmer » traités", ok: arr(i.product.unconfirmed).length === 0, blocking: false, detail: arr(i.product.unconfirmed).length === 0 ? "Aucun point en attente." : `${arr(i.product.unconfirmed).length} point(s) à confirmer sur la fiche.` },
    { id: "arguments", label: "Argument ou réponse approuvé", ok: [...args, ...objs].some((x) => x.approved), blocking: false, detail: [...args, ...objs].some((x) => x.approved) ? "Au moins un contenu approuvé." : "Aucun argument ni réponse à une objection approuvé : les messages n'ont pas de base validée." },
    { id: "feed", label: "Conversions reçues du produit", ok: i.webhookEvents > 0, blocking: false, detail: i.webhookEvents > 0 ? `${i.webhookEvents} événement(s) reçu(s).` : "Aucune conversion reçue du produit : inscriptions, essais et paiements devront être saisis à la main (non vérifiés)." },
    { id: "ads", label: "Campagne publicitaire liée au produit", ok: i.linkedAdCampaigns > 0, blocking: false, detail: i.linkedAdCampaigns > 0 ? "Au moins une campagne liée : dépenses et CPL calculables." : "Aucune campagne liée : dépenses, CPL et CAC resteront indisponibles." },
    { id: "templates", label: "Modèle de message approuvé (prospection sortante)", ok: i.approvedTemplates > 0, blocking: false, detail: i.approvedTemplates > 0 ? "Au moins un modèle approuvé." : "Aucun modèle approuvé : aucun contact sortant possible." },
  ];
  return { checks, ready: checks.filter((c) => c.blocking).every((c) => c.ok) };
}
