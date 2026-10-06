import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const db = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = db;

const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");

/** Filtre « contient » insensible à la casse, valable en SQLite (insensible par défaut) et PostgreSQL (mode: insensitive). */
export const containsCi = (q: string) => ({ contains: q, ...(isPostgres ? { mode: "insensitive" } : {}) }) as { contains: string };
