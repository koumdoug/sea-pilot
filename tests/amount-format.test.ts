// R10 : montants affichés à la française (virgule décimale, deux décimales ; quatre pour le coût IA en dollars).
// Périmètre : portfolio/page.tsx, products/[id]/page.tsx (2 occurrences), prospects/[id]/page.tsx, ai-studio/page.tsx.
// Exclusions à NE PAS toucher : components/charts.tsx (coordonnées SVG : point décimal obligatoire) et lib/portfolio/rules.ts (clé de déduplication).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as K from "@/lib/kpi";

type FmtAmount = (amount: number | null | undefined, currency?: string | null, digits?: number) => string;
const fmtAmount = (K as unknown as { fmtAmount: FmtAmount }).fmtAmount;
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("format français des décimales (fmtDec) — référence du résultat attendu", () => {
  it("12.5 → « 12,50 » ; 1234.5 → « 1 234,50 » (séparateur de milliers) ; 0 → « 0,00 »", () => {
    expect(K.fmtDec(12.5, 2)).toBe("12,50");
    expect(K.fmtDec(1234.5, 2)).toMatch(/^1\s234,50$/);
    expect(K.fmtDec(0, 2)).toBe("0,00");
  });
  it("le coût IA garde QUATRE décimales : 0.0012 → « 0,0012 » ; 0.001 → « 0,0010 » (jamais réduit à deux)", () => {
    expect(K.fmtDec(0.0012, 4)).toBe("0,0012");
    expect(K.fmtDec(0.001, 4)).toBe("0,0010");
    expect(K.fmtDec(0.0012, 2)).toBe("0,00"); // deux décimales perdraient le coût : c'est ce que R10 interdit
  });
});

describe("fmtAmount : montant + devise en suffixe, « — » si la valeur est absente", () => {
  it("12.5 EUR → « 12,50 EUR » ; 1234.5 USD → « 1 234,50 USD »", () => {
    expect(fmtAmount(12.5, "EUR")).toBe("12,50 EUR");
    expect(fmtAmount(1234.5, "USD")).toMatch(/^1\s234,50 USD$/);
  });
  it("aucune virgule remplacée par un point, aucune décimale perdue : 0 → « 0,00 EUR »", () => {
    expect(fmtAmount(0, "EUR")).toBe("0,00 EUR");
    expect(fmtAmount(12.5, "EUR")).not.toContain(".");
  });
  it("valeur absente (null, undefined, NaN) → « — », sans devise orpheline", () => {
    for (const v of [null, undefined, Number.NaN]) expect(fmtAmount(v, "EUR"), String(v)).toBe("—");
  });
  it("devise absente : pas d'espace final ; précision paramétrable (4 décimales)", () => {
    expect(fmtAmount(12.5, null)).toBe("12,50");
    expect(fmtAmount(12.5, undefined)).toBe("12,50");
    expect(fmtAmount(0.0012, null, 4)).toBe("0,0012");
  });
});

describe("pages concernées : plus de « toFixed » d'affichage (point décimal anglais)", () => {
  const PAGES = ["src/app/(app)/portfolio/page.tsx", "src/app/(app)/products/[id]/page.tsx", "src/app/(app)/prospects/[id]/page.tsx", "src/app/(app)/ai-studio/page.tsx"];
  for (const p of PAGES) it(`${p} : aucun .toFixed(`, () => expect(src(p)).not.toMatch(/\.toFixed\(/));
  it("les gardes de valeur absente sont conservées (événements produit et prospect : « e.amount != null » ... « — »)", () => {
    expect(src("src/app/(app)/products/[id]/page.tsx")).toMatch(/e\.amount != null/);
    expect(src("src/app/(app)/prospects/[id]/page.tsx")).toMatch(/e\.amount != null/);
    expect(src("src/app/(app)/products/[id]/page.tsx")).toContain('"—"');
  });
  it("le coût IA garde quatre décimales et le dollar", () => {
    const s = src("src/app/(app)/ai-studio/page.tsx");
    expect(s).toMatch(/fmtDec\(g\.costUsd, 4\)/);
    expect(s).toMatch(/\$/);
  });
});

describe("exclusions : fichiers dont le point décimal est obligatoire (non-régression : ils ne doivent PAS changer)", () => {
  it("charts.tsx : coordonnées SVG avec point décimal (toFixed(1) × 2)", () => {
    expect(src("src/components/charts.tsx").match(/\.toFixed\(1\)/g)).toHaveLength(2);
  });
  it("lib/portfolio/rules.ts : clé de déduplication des paiements avec toFixed(2)", () => {
    expect(src("src/lib/portfolio/rules.ts")).toMatch(/\(e\.amount \?\? 0\)\.toFixed\(2\)/);
  });
});
