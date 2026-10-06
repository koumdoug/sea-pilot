import { db } from "@/lib/db";
import { createWorkspace } from "@/lib/workspaces";
import { resetRateLimits } from "@/lib/rate-limit";

export async function resetDb() {
  resetRateLimits();
  // l'ordre n'a pas d'importance : les suppressions en cascade partent des racines
  await db.auditLog.deleteMany();
  await db.workspace.deleteMany();
  await db.user.deleteMany();
}

let n = 0;
export async function makeWorkspace(name = "Acme", opts: { role?: string } = {}) {
  const i = ++n;
  const user = await db.user.create({ data: { email: `u${i}-${Date.now()}@test.local`, name: `User ${i}`, passwordHash: "x" } });
  const ws = await createWorkspace(user.id, `${name} ${i}`);
  if (opts.role && opts.role !== "owner") await db.membership.updateMany({ where: { userId: user.id, workspaceId: ws.id }, data: { role: opts.role } });
  await db.workspace.update({ where: { id: ws.id }, data: { onboardingCompletedAt: new Date() } });
  return { user, ws, workspaceId: ws.id, userId: user.id };
}
