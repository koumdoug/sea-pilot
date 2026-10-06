"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { destroySession, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth";
import { run, parse, formObject, optNum, optStr, UserError, type ActionState } from "@/lib/action";
import { COMPANY_SIZES, CURRENCIES, LANGUAGES, ROLES } from "@/lib/constants";
import { randomToken, sha256 } from "@/lib/crypto";
import { limitReached } from "@/lib/plans";
import { workspaceUsage } from "@/lib/billing";
import { normalizeCriteria } from "@/lib/scoring";
import { rateLimit } from "@/lib/rate-limit";

export async function updateProfileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "read" }, async (ctx) => {
    const d = parse(z.object({ name: z.string().trim().min(2, "Nom requis").max(100), locale: z.enum(LANGUAGES.map((l) => l[0]) as [string, ...string[]]) }), formObject(fd));
    await db.user.update({ where: { id: ctx.user.id }, data: { name: d.name, locale: d.locale } });
    revalidatePath("/settings");
    return { ok: true, message: "Profil mis à jour." };
  });
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "read" }, async (ctx) => {
    const d = parse(z.object({ current: z.string().min(1, "Mot de passe actuel requis"), next: z.string().superRefine((p, c) => { const m = passwordProblem(p); if (m) c.addIssue({ code: "custom", message: m }); }) }), formObject(fd));
    if (!rateLimit(`pwd:${ctx.user.id}`, 5, 15 * 60_000).ok) throw new UserError("Trop de tentatives. Réessayez plus tard.");
    const u = await db.user.findUnique({ where: { id: ctx.user.id } });
    if (!u?.passwordHash || !(await verifyPassword(d.current, u.passwordHash))) return { error: "Mot de passe actuel incorrect.", fieldErrors: { current: "Incorrect." } };
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(d.next) } });
    await audit({ userId: u.id, workspaceId: ctx.workspaceId, action: "auth.password_changed" });
    return { ok: true, message: "Mot de passe modifié." };
  });
}

const url = z.string().trim().max(300).optional().transform((v) => (v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : undefined));

export async function updateWorkspaceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_settings" }, async (ctx) => {
    const d = parse(z.object({
      name: z.string().trim().min(2, "Nom requis").max(100), website: url, industry: optStr(120), country: optStr(80), language: z.enum(LANGUAGES.map((l) => l[0]) as [string, ...string[]]), currency: z.enum(CURRENCIES),
      description: optStr(1500), companySize: z.enum(COMPANY_SIZES).optional().or(z.literal("")),
      goalLeadsPerMonth: optNum, goalSalesPerMonth: optNum, adBudgetMonthly: optNum, maxCac: optNum, revenueGoal: optNum,
    }), formObject(fd));
    await db.workspace.update({
      where: { id: ctx.workspaceId },
      data: {
        name: d.name, website: d.website ?? null, industry: d.industry ?? null, country: d.country ?? null, language: d.language, currency: d.currency, description: d.description ?? null, companySize: d.companySize || null,
        goalLeadsPerMonth: d.goalLeadsPerMonth ? Math.round(d.goalLeadsPerMonth) : null, goalSalesPerMonth: d.goalSalesPerMonth ? Math.round(d.goalSalesPerMonth) : null,
        adBudgetMonthly: d.adBudgetMonthly ?? null, maxCac: d.maxCac ?? null, revenueGoal: d.revenueGoal ?? null,
      },
    });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "workspace.updated" });
    revalidatePath("/settings");
    return { ok: true, message: "Réglages enregistrés." };
  });
}

// ── Équipe ──
export async function addMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_members" }, async (ctx) => {
    const d = parse(z.object({ email: z.string().trim().toLowerCase().email("E-mail invalide"), role: z.enum(["admin", "member", "viewer"]) }), formObject(fd));
    const usage = await workspaceUsage(ctx.workspaceId);
    if (limitReached(ctx.ent.plan, "members", usage.members)) throw new UserError("Limite d'utilisateurs atteinte pour votre plan.");
    const user = await db.user.findFirst({ where: { email: d.email, deletedAt: null } });
    if (!user) throw new UserError("Aucun compte SEA Pilot avec cette adresse. Demandez à cette personne de créer un compte (page d'inscription) puis ajoutez-la ici.");
    if (await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: ctx.workspaceId } } })) throw new UserError("Cette personne fait déjà partie de l'espace.");
    await db.membership.create({ data: { userId: user.id, workspaceId: ctx.workspaceId, role: d.role } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "member.added", entity: "User", entityId: user.id, meta: { role: d.role } });
    revalidatePath("/settings");
    return { ok: true, message: `${user.name} a été ajouté(e) avec le rôle « ${d.role} ».` };
  });
}

export async function changeMemberRoleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_members" }, async (ctx) => {
    const d = parse(z.object({ userId: z.string(), role: z.enum(ROLES) }), formObject(fd));
    const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId: d.userId, workspaceId: ctx.workspaceId } } });
    if (!m) throw new UserError("Membre introuvable.");
    if (m.role === "owner" || d.role === "owner") throw new UserError("Le rôle de propriétaire ne peut pas être modifié ici.");
    if (ctx.role !== "owner" && (m.role === "admin" || d.role === "admin")) throw new UserError("Seul le propriétaire gère les administrateurs.");
    await db.membership.update({ where: { id: m.id }, data: { role: d.role } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "member.role_changed", entity: "User", entityId: d.userId, meta: { role: d.role } });
    revalidatePath("/settings");
  });
}

export async function removeMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_members" }, async (ctx) => {
    const { userId } = parse(z.object({ userId: z.string() }), formObject(fd));
    const m = await db.membership.findUnique({ where: { userId_workspaceId: { userId, workspaceId: ctx.workspaceId } } });
    if (!m) throw new UserError("Membre introuvable.");
    if (m.role === "owner") throw new UserError("Le propriétaire ne peut pas être retiré.");
    if (ctx.role !== "owner" && m.role === "admin") throw new UserError("Seul le propriétaire retire un administrateur.");
    await db.membership.delete({ where: { id: m.id } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "member.removed", entity: "User", entityId: userId });
    revalidatePath("/settings");
  });
}

// ── Qualification ──
export async function saveQualificationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_settings" }, async (ctx) => {
    const raw = formObject(fd);
    const d = parse(z.object({ hot: z.coerce.number().int().min(1).max(100), warm: z.coerce.number().int().min(0).max(99) }), raw);
    if (d.warm >= d.hot) throw new UserError("Le seuil « tiède » doit être inférieur au seuil « chaud ».");
    const criteria = normalizeCriteria(["need", "budget", "urgency", "fit", "location", "size", "intent"].map((key) => ({ key, label: key, weight: Number(raw[`w_${key}`] ?? 0), enabled: raw[`e_${key}`] === "on" })));
    if (!criteria.some((c) => c.enabled && c.weight > 0)) throw new UserError("Activez au moins un critère avec un poids supérieur à 0.");
    const data = { criteria: criteria as unknown as object, hotThreshold: d.hot, warmThreshold: d.warm, autoQualify: raw.autoQualify === "on", useAi: raw.useAi === "on" };
    await db.qualificationConfig.upsert({ where: { workspaceId: ctx.workspaceId }, create: { workspaceId: ctx.workspaceId, ...data }, update: data });
    revalidatePath("/settings");
    return { ok: true, message: "Critères de qualification enregistrés. Ils s'appliquent aux prochaines qualifications." };
  });
}

// ── Clés API ──
export async function createApiKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const { name } = parse(z.object({ name: z.string().trim().min(2, "Nom requis").max(80) }), formObject(fd));
    const usage = await workspaceUsage(ctx.workspaceId);
    if (limitReached(ctx.ent.plan, "apiKeys", usage.apiKeys)) throw new UserError("Limite de clés API atteinte pour votre plan.");
    const key = `sp_${randomToken(32)}`;
    await db.apiKey.create({ data: { workspaceId: ctx.workspaceId, name, prefix: key.slice(0, 10), keyHash: sha256(key), createdById: ctx.user.id } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "apikey.created", meta: { name } });
    revalidatePath("/settings");
    return { ok: true, message: "Clé créée. Copiez-la maintenant : elle ne sera plus jamais affichée.", data: { key } };
  });
}

export async function revokeApiKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_integrations" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const u = await db.apiKey.updateMany({ where: { id, workspaceId: ctx.workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!u.count) throw new UserError("Clé introuvable.");
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "apikey.revoked", entityId: id });
    revalidatePath("/settings");
  });
}

// ── Suppression de données ──
export async function deleteWorkspaceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const r = await run({ action: "delete_workspace", allowInactive: true }, async (ctx) => {
    const d = parse(z.object({ confirm: z.string() }), formObject(fd));
    if (d.confirm.trim() !== ctx.workspace.name) throw new UserError(`Saisissez exactement « ${ctx.workspace.name} » pour confirmer.`);
    if (ctx.subscription?.stripeSubscriptionId && ctx.subscription.status === "active" && !ctx.subscription.cancelAtPeriodEnd) throw new UserError("Résiliez d'abord votre abonnement payant dans Billing.");
    await audit({ workspaceId: null, userId: ctx.user.id, action: "workspace.deleted", meta: { name: ctx.workspace.name } });
    await db.workspace.delete({ where: { id: ctx.workspaceId } }); // cascade : toutes les données de l'espace
    done = true;
  });
  if (done) redirect("/dashboard");
  return r;
}

export async function deleteAccountAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "read", allowInactive: true, allowIncompleteOnboarding: true }, async (ctx) => {
  const user = ctx.user;
  const d = parse(z.object({ password: z.string().min(1, "Mot de passe requis") }), formObject(fd));
  const u = await db.user.findUnique({ where: { id: user.id }, include: { memberships: { include: { workspace: { include: { memberships: true, subscription: true } } } } } });
  if (!u?.passwordHash || !(await verifyPassword(d.password, u.passwordHash))) return { error: "Mot de passe incorrect.", fieldErrors: { password: "Incorrect." } };
  for (const m of u.memberships) {
    if (m.role === "owner" && m.workspace.memberships.length > 1) return { error: `Vous êtes propriétaire de « ${m.workspace.name} » qui compte d'autres membres : retirez-les ou supprimez l'espace avant de supprimer votre compte.` };
    if (m.role === "owner" && m.workspace.subscription?.stripeSubscriptionId && m.workspace.subscription.status === "active" && !m.workspace.subscription.cancelAtPeriodEnd) return { error: `Résiliez d'abord l'abonnement de « ${m.workspace.name} » dans Billing.` };
  }
  const owned = u.memberships.filter((m) => m.role === "owner").map((m) => m.workspaceId);
  await audit({ userId: u.id, action: "account.deleted" });
  await db.$transaction([
    db.workspace.deleteMany({ where: { id: { in: owned } } }),
    db.membership.deleteMany({ where: { userId: u.id } }),
    db.oAuthAccount.deleteMany({ where: { userId: u.id } }),
    db.passwordResetToken.deleteMany({ where: { userId: u.id } }),
    db.user.update({ where: { id: u.id }, data: { email: `deleted-${u.id}@deleted.invalid`, name: "Compte supprimé", passwordHash: null, deletedAt: new Date() } }),
  ]);
  await destroySession();
  redirect("/?account=deleted");
  });
}
