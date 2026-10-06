"use server";

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { db } from "@/lib/db";
import { createSession, destroySession, hashPassword, passwordProblem, verifyPassword } from "@/lib/auth";
import { registerUser } from "@/lib/workspaces";
import { audit } from "@/lib/audit";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { hashIp, randomToken, sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import { sendSystemEmail } from "@/lib/email";
import { parse, formObject, ValidationError, type ActionState } from "@/lib/action";
import { WORKSPACE_COOKIE } from "@/lib/constants";
import { log } from "@/lib/logger";

let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword("dummy-password-for-timing"));

const email = z.string().trim().toLowerCase().email("Adresse e-mail invalide.").max(200);

async function ip() {
  return clientIp(await headers());
}

function fail(e: unknown): ActionState {
  if (e instanceof ValidationError) return { error: e.message, fieldErrors: e.fieldErrors };
  throw e;
}

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let data: { email: string; password: string; next?: string };
  try {
    data = parse(z.object({ email, password: z.string().min(1, "Mot de passe requis."), next: z.string().optional() }), formObject(fd));
  } catch (e) { return fail(e); }

  const rl = rateLimit(`login:${await ip()}:${data.email}`, 10, 10 * 60_000);
  if (!rl.ok) return { error: `Trop de tentatives. Réessayez dans ${Math.ceil(rl.retryAfterSec / 60)} min.` };

  const user = await db.user.findFirst({ where: { email: data.email, deletedAt: null } });
  // Comparaison systématique pour ne pas révéler l'existence du compte par le temps de réponse.
  const ok = await verifyPassword(data.password, user?.passwordHash ?? (await dummyHash()));
  if (!user || !user.passwordHash || !ok) {
    await audit({ action: "auth.login_failed", meta: { reason: "invalid" }, ipHash: hashIp(await ip()) });
    return { error: "Identifiants invalides." };
  }
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id);
  await audit({ userId: user.id, action: "auth.login", ipHash: hashIp(await ip()) });
  const next = data.next && data.next.startsWith("/") && !data.next.startsWith("//") ? data.next : "/dashboard";
  redirect(next);
}

export async function registerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let data: { name: string; email: string; password: string; workspaceName: string };
  try {
    data = parse(z.object({
      name: z.string().trim().min(2, "Nom requis.").max(100),
      email,
      password: z.string().superRefine((p, ctx) => { const m = passwordProblem(p); if (m) ctx.addIssue({ code: "custom", message: m }); }),
      workspaceName: z.string().trim().min(2, "Nom de l'entreprise requis.").max(100),
      terms: z.literal("on", { error: "Vous devez accepter les conditions d'utilisation et la politique de confidentialité." }),
    }), formObject(fd));
  } catch (e) { return fail(e); }

  const rl = rateLimit(`register:${await ip()}`, 5, 60 * 60_000);
  if (!rl.ok) return { error: "Trop d'inscriptions depuis cette adresse. Réessayez plus tard." };

  const r = await registerUser(data);
  if ("error" in r) return { error: "Un compte existe déjà avec cette adresse e-mail.", fieldErrors: { email: "Adresse déjà utilisée." } };
  await createSession(r.user.id);
  (await cookies()).set(WORKSPACE_COOKIE, r.workspace.id, { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/onboarding");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function forgotPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let data: { email: string };
  try { data = parse(z.object({ email }), formObject(fd)); } catch (e) { return fail(e); }
  const generic: ActionState = { ok: true, message: "Si un compte existe pour cette adresse, un e-mail de réinitialisation vient d'être envoyé (valable 1 heure)." };

  const rl = rateLimit(`forgot:${await ip()}`, 5, 15 * 60_000);
  if (!rl.ok) return { error: "Trop de demandes. Réessayez dans quelques minutes." };

  const user = await db.user.findFirst({ where: { email: data.email, deletedAt: null } });
  if (!user) return generic;
  const token = randomToken(32);
  await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3_600_000) } });
  const link = `${env.appUrl}/reset-password?token=${token}`;
  const sent = await sendSystemEmail({ to: user.email, subject: "Réinitialisation de votre mot de passe SEA Pilot", text: `Bonjour ${user.name},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.` });
  if (!sent) log.error("password_reset.email_not_sent", { userId: user.id });
  await audit({ userId: user.id, action: "auth.password_reset_requested", meta: { emailSent: sent } });
  return generic;
}

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let data: { token: string; password: string };
  try {
    data = parse(z.object({ token: z.string().min(10), password: z.string().superRefine((p, ctx) => { const m = passwordProblem(p); if (m) ctx.addIssue({ code: "custom", message: m }); }) }), formObject(fd));
  } catch (e) { return fail(e); }
  const rec = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256(data.token) } });
  if (!rec || rec.usedAt || rec.expiresAt.getTime() < Date.now()) return { error: "Ce lien est invalide ou expiré. Demandez-en un nouveau." };
  await db.$transaction([
    db.user.update({ where: { id: rec.userId }, data: { passwordHash: await hashPassword(data.password) } }),
    db.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    db.passwordResetToken.updateMany({ where: { userId: rec.userId, usedAt: null }, data: { usedAt: new Date() } }),
  ]);
  await audit({ userId: rec.userId, action: "auth.password_reset" });
  redirect("/login?reset=1");
}
