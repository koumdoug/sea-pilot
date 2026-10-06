import { db } from "./db";
import { env } from "./env";
import { hashPassword } from "./auth";
import { audit } from "./audit";
import { DEFAULT_CRITERIA } from "./scoring";

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "page"
  );
}

export async function uniqueWorkspaceSlug(name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; await db.workspace.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${base}-${i}`;
  return slug;
}

/** Crée un espace de travail, l'adhésion « owner », l'abonnement d'essai et la configuration de qualification par défaut. */
export async function createWorkspace(userId: string, name: string, opts: { isDemo?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const slug = await uniqueWorkspaceSlug(name);
  const ws = await db.workspace.create({
    data: {
      name,
      slug,
      isDemo: !!opts.isDemo,
      memberships: { create: { userId, role: "owner" } },
      subscription: { create: { plan: "starter", status: "trialing", trialEndsAt: new Date(now.getTime() + env.trialDays * 86_400_000) } },
      qualificationConfig: { create: { criteria: DEFAULT_CRITERIA as unknown as object } },
    },
  });
  await audit({ workspaceId: ws.id, userId, action: "workspace.created", entity: "Workspace", entityId: ws.id });
  return ws;
}

export async function registerUser(input: { name: string; email: string; password: string; workspaceName: string }) {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return { error: "EMAIL_TAKEN" as const };
  const user = await db.user.create({ data: { email, name: input.name.trim(), passwordHash: await hashPassword(input.password) } });
  const workspace = await createWorkspace(user.id, input.workspaceName.trim());
  await audit({ workspaceId: workspace.id, userId: user.id, action: "user.registered" });
  return { user, workspace };
}
