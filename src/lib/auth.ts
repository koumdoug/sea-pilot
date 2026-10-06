import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { env } from "./env";
import { SESSION_COOKIE } from "./constants";

const MAX_AGE = 60 * 60 * 24 * 30; // session persistante : 30 jours

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);

/** Politique de mot de passe : 10 caractères minimum, au moins une lettre et un chiffre. */
export function passwordProblem(p: string): string | null {
  if (p.length < 10) return "Mot de passe : 10 caractères minimum.";
  if (p.length > 200) return "Mot de passe trop long.";
  if (!/[A-Za-zÀ-ÿ]/.test(p) || !/\d/.test(p)) return "Mot de passe : au moins une lettre et un chiffre.";
  return null;
}

const secret = () => new TextEncoder().encode(env.sessionSecret);

export async function signSessionToken(userId: string) {
  return new SignJWT({ uid: userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(`${MAX_AGE}s`).sign(secret());
}

export async function readSessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.uid === "string" ? payload.uid : null;
  } catch {
    return null;
  }
}

export async function createSession(userId: string) {
  (await cookies()).set(SESSION_COOKIE, await signSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function destroySession() {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
  c.delete("seapilot_ws");
}

export type SessionUser = { id: string; name: string; email: string; locale: string };

/** L'utilisateur vient TOUJOURS de la base à partir du jeton signé, jamais d'un paramètre client. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const uid = await readSessionToken(token);
  if (!uid) return null;
  const u = await db.user.findFirst({ where: { id: uid, deletedAt: null }, select: { id: true, name: true, email: true, locale: true } });
  return u;
}

export async function requireUser(): Promise<SessionUser> {
  const u = await getSessionUser();
  if (!u) redirect("/login?expired=1");
  return u;
}
