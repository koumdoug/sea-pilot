import { BillingError, handleStripeEvent, type StripeEvent, type StripeGateway, type StripeSub } from "@/lib/billing";

// Stripe en mémoire pour les tests : AUCUN appel réseau, aucun paiement. Il détient « l'état réel » des abonnements et des sessions de paiement ;
// les tests décident de ce que Stripe répond, indépendamment du contenu (éventuellement ancien) des événements livrés.
export class FakeStripe implements StripeGateway {
  subs = new Map<string, StripeSub>();
  sessions = new Map<string, { status: string; url: string }>();
  private byKey = new Map<string, { id: string; url: string }>();
  customersCreated = 0;
  sessionsCreated = 0;
  expired: string[] = [];
  calls: string[] = [];
  unavailable = false;
  /** Latence simulée (ms) : force l'entrelacement des requêtes concurrentes. */
  lagMs = 0;
  /** Plus grand nombre de lectures simultanées d'un MÊME abonnement observé (les synchronisations sous bail doivent le garder à 1). */
  maxConcurrentReads = 0;
  private activeReads = new Map<string, number>();
  private holds: { entered: () => void; released: Promise<void> }[] = [];
  private failures: { method: string; error: Error }[] = [];

  /** Panne ponctuelle : le prochain appel de `method` échoue (erreur réseau simulée). */
  failNext(method: string, error: Error = new BillingError("Erreur réseau Stripe (simulation)")) { this.failures.push({ method, error }); }
  /**
   * Suspend la PROCHAINE lecture d'abonnement APRÈS qu'elle a capturé l'état courant de Stripe : la lecture renverra donc un état qui sera ancien
   * quand elle reprendra. `entered` se résout quand la lecture est suspendue ; `release()` la laisse reprendre.
   */
  holdNextRead() {
    let entered!: () => void, release!: () => void;
    const e = new Promise<void>((r) => { entered = r; }), released = new Promise<void>((r) => { release = r; });
    this.holds.push({ entered, released });
    return { entered: e, release };
  }
  private takeFailure(method: string) { const i = this.failures.findIndex((f) => f.method === method); if (i >= 0) throw this.failures.splice(i, 1)[0].error; }

  reset() { this.maxConcurrentReads = 0; this.activeReads.clear(); this.holds = []; this.failures = []; this.subs.clear(); this.sessions.clear(); this.byKey.clear(); this.customersCreated = 0; this.sessionsCreated = 0; this.expired = []; this.calls = []; this.unavailable = false; this.lagMs = 0; }
  private async gate(call: string) {
    this.calls.push(call);
    if (this.lagMs) await new Promise((r) => setTimeout(r, this.lagMs));
    if (this.unavailable) throw new BillingError("Stripe indisponible (simulation)");
  }
  async getSubscription(id: string) {
    this.takeFailure("getSubscription");
    await this.gate(`getSubscription:${id}`);
    const n = (this.activeReads.get(id) ?? 0) + 1;
    this.activeReads.set(id, n);
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, n);
    try {
      const s = this.subs.get(id), snapshot = s ? structuredClone(s) : null; // l'état est capturé ICI (instant de traitement chez Stripe)
      const hold = this.holds.shift();
      if (hold) { hold.entered(); await hold.released; }
      return snapshot;
    } finally { this.activeReads.set(id, (this.activeReads.get(id) ?? 1) - 1); }
  }
  async getCheckoutSession(id: string) { await this.gate(`getCheckoutSession:${id}`); const s = this.sessions.get(id); return s ? { status: s.status } : null; }
  async expireCheckoutSession(id: string) {
    await this.gate(`expireCheckoutSession:${id}`);
    const s = this.sessions.get(id);
    if (!s || s.status !== "open") throw new BillingError("La session n'est pas ouverte.");
    s.status = "expired"; this.expired.push(id);
  }
  async createCustomer() { await this.gate("createCustomer"); return { id: `cus_fake_${++this.customersCreated}` }; }
  async createCheckoutSession(_body: Record<string, string>, idempotencyKey: string) {
    await this.gate("createCheckoutSession");
    const prev = this.byKey.get(idempotencyKey); // même clé d'idempotence : Stripe renvoie la même session
    if (prev) return prev;
    const id = `cs_fake_${++this.sessionsCreated}`, url = `https://checkout.example/${id}`;
    this.sessions.set(id, { status: "open", url }); this.byKey.set(idempotencyKey, { id, url });
    return { id, url };
  }

  /** Définit l'état réel d'un abonnement chez Stripe. */
  set(id: string, over: Partial<StripeSub> = {}) { this.subs.set(id, { id, customer: "cus_1", status: "active", items: { data: [{ price: { id: "price_growth_test" } }] }, metadata: { plan: "growth" }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400, ...(this.subs.get(id) ?? {}), ...over }); }

  /**
   * Mode « rétrocompatible » des anciens tests : Stripe suit ce que l'événement annonce (comme si l'événement était le plus récent),
   * avec la sémantique réelle d'une facture : un impayé ne dégrade qu'un abonnement actif, une facture payée ne ressuscite pas un abonnement terminé.
   */
  mirror(ev: StripeEvent) {
    const o = ev.data.object as Record<string, unknown>;
    if (ev.type === "customer.subscription.deleted") this.subs.set(String(o.id), { ...(o as unknown as StripeSub), status: "canceled" });
    else if (ev.type.startsWith("customer.subscription.")) this.subs.set(String(o.id), structuredClone(o as unknown as StripeSub));
    else if (ev.type === "checkout.session.completed" && typeof o.subscription === "string" && !this.subs.has(o.subscription)) this.subs.set(o.subscription, { id: o.subscription, customer: o.customer as string, status: "incomplete" });
    else if (ev.type.startsWith("invoice.") && typeof o.subscription === "string") {
      const s = this.subs.get(o.subscription);
      if (s && ev.type === "invoice.payment_failed" && s.status === "active") s.status = "past_due";
      if (s && ev.type === "invoice.paid" && (s.status === "past_due" || s.status === "unpaid")) s.status = "active";
    }
  }
}

export const fake = new FakeStripe();

/** Livre un événement dont le contenu est aussi l'état réel chez Stripe (comportement des tests d'origine). */
export function deliver(ev: StripeEvent) { fake.mirror(ev); return handleStripeEvent(ev, fake); }
