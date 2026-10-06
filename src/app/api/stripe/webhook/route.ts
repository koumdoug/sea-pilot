import { env } from "@/lib/env";
import { handleStripeEvent, verifyStripeSignature, type StripeEvent } from "@/lib/billing";
import { log, errMsg } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = env.stripeWebhookSecret;
  if (!secret) return Response.json({ error: "Webhook Stripe non configuré (STRIPE_WEBHOOK_SECRET)." }, { status: 503 });
  const payload = await req.text();
  if (!verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret)) return Response.json({ error: "Signature invalide." }, { status: 400 });
  let ev: StripeEvent;
  try { ev = JSON.parse(payload) as StripeEvent; } catch { return Response.json({ error: "Corps invalide." }, { status: 400 }); }
  try {
    const r = await handleStripeEvent(ev);
    return Response.json({ received: true, handled: r.handled });
  } catch (e) {
    log.error("stripe.webhook_error", { type: ev.type, error: errMsg(e) });
    return Response.json({ error: "Erreur de traitement." }, { status: 500 }); // Stripe réessaiera
  }
}
