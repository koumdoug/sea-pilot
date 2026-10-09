import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Subscription, Workspace } from "@prisma/client";
import { db } from "./db";
import { requireUser, type SessionUser } from "./auth";
import { WORKSPACE_COOKIE } from "./constants";
import { assertCan, can, type Action } from "./permissions";
import { entitlement, exemptEntitlement, type Entitlement } from "./plans";
import { isFreeOwner } from "./free-access";

export type Ctx = {
  user: SessionUser;
  workspace: Workspace;
  workspaceId: string;
  role: string;
  subscription: Subscription | null;
  ent: Entitlement;
  can: (a: Action) => boolean;
};

/**
 * Résout l'espace de travail courant. Le cookie ne sert que de PRÉFÉRENCE : l'appartenance est TOUJOURS
 * revérifiée en base (Membership) — un identifiant d'un autre espace est ignoré.
 */
export async function resolveWorkspaceFor(userId: string, preferredId?: string | null) {
  const memberships = await db.membership.findMany({
    where: { userId, workspace: { deletedAt: null } },
    include: { workspace: { include: { subscription: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (!memberships.length) return null;
  return memberships.find((m) => m.workspaceId === preferredId) ?? memberships[0];
}

export async function getCtx(): Promise<Ctx | null> {
  const user = await requireUser();
  const pref = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const m = await resolveWorkspaceFor(user.id, pref);
  if (!m) return null;
  return buildCtx(user, m.workspace, m.role, m.workspace.subscription);
}

export function buildCtx(user: SessionUser, workspace: Workspace, role: string, subscription: Subscription | null): Ctx {
  return { user, workspace, workspaceId: workspace.id, role, subscription, ent: isFreeOwner(user.id, role) ? exemptEntitlement() : entitlement(subscription), can: (a) => can(role, a) };
}

type RequireOpts = { action?: Action; allowInactive?: boolean; allowIncompleteOnboarding?: boolean };

/** Contexte obligatoire pour toute page ou action de l'application. */
export async function requireCtx(opts: RequireOpts = {}): Promise<Ctx> {
  const ctx = await getCtx();
  if (!ctx) redirect("/onboarding/workspace");
  if (!opts.allowIncompleteOnboarding && !ctx.workspace.onboardingCompletedAt) redirect("/onboarding");
  if (!opts.allowInactive && !ctx.ent.active) redirect("/billing?blocked=1");
  if (opts.action) assertCan(ctx.role, opts.action);
  return ctx;
}

/** Filtre multi-tenant à inclure dans toute requête Prisma sur un modèle portant workspaceId. */
export const inWs = (ctx: { workspaceId: string }) => ({ workspaceId: ctx.workspaceId });
