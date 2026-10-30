import { db } from "@/lib/db";
import { createWorkspace } from "@/lib/workspaces";
import { resetRateLimits } from "@/lib/rate-limit";
import { fake } from "./stripe-fake";
import { setStripeGateway } from "@/lib/billing";

export async function resetDb() {
  resetRateLimits();
  // l'ordre n'a pas d'importance : les suppressions en cascade partent des racines
  await db.auditLog.deleteMany();
  await db.stripeEvent.deleteMany();
  fake.reset();
  setStripeGateway(null); // passerelle Stripe réelle par défaut : un test qui la remplace le fait explicitement
  await db.workspace.deleteMany();
  await db.user.deleteMany();
}

/** L'API par clé est comprise dans le forfait Pro seulement : les tests de l'API (et non du forfait) donnent donc Pro à l'espace qui porte la clé. */
export const grantApiPlan = (workspaceId: string) => db.subscription.update({ where: { workspaceId }, data: { plan: "pro" } });

let n = 0;
export async function makeWorkspace(name = "Acme", opts: { role?: string } = {}) {
  const i = ++n;
  const user = await db.user.create({ data: { email: `u${i}-${Date.now()}@test.local`, name: `User ${i}`, passwordHash: "x" } });
  const ws = await createWorkspace(user.id, `${name} ${i}`);
  if (opts.role && opts.role !== "owner") await db.membership.updateMany({ where: { userId: user.id, workspaceId: ws.id }, data: { role: opts.role } });
  await db.workspace.update({ where: { id: ws.id }, data: { onboardingCompletedAt: new Date() } });
  return { user, ws, workspaceId: ws.id, userId: user.id };
}
