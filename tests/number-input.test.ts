// Passe 2bis / B : grammaire numérique partagée (client ET serveur) — src/lib/number-input.ts.
// Grammaire attendue, après suppression des espaces périphériques : /^-?(\d+(\.\d+)?|\.\d+)$/ ; la conversion numérique n'a lieu qu'APRÈS validation.
// Les résultats attendus viennent des exigences, pas du code. Les règles propres à chaque champ (signe, bornes) ne sont PAS ici : « -.5 » est reconnu comme nombre.
import { describe, expect, it } from "vitest";
import { parseDecimalInput, SCIENTIFIC_NOTATION_MESSAGE } from "@/lib/number-input";

const val = (v: string | number | undefined) => { const r = parseDecimalInput(v); return r.ok ? r.value : `REFUSÉ:${r.message}`; };

describe("parseDecimalInput : grammaire attendue", () => {
  it("valeur absente : \"\", espaces seuls, tabulations, undefined → absente (jamais zéro)", () => {
    for (const v of ["", "   ", "\t", " \n ", undefined]) expect(parseDecimalInput(v), JSON.stringify(v)).toEqual({ ok: true, value: undefined });
  });
  it("décimaux acceptés et normalisés : \".5\" → 0.5, \".28\" → 0.28, \"05\" → 5, \"28.0\" → 28, \"0005.50\" → 5.5, \" 28 \" → 28", () => {
    expect(val(".5")).toBe(0.5);
    expect(val(".28")).toBe(0.28);
    expect(val("05")).toBe(5);
    expect(val("28.0")).toBe(28);
    expect(val("0005.50")).toBe(5.5);
    expect(val(" 28 ")).toBe(28);
    expect(val(" .5 ")).toBe(0.5);
    expect(val("100")).toBe(100);
  });
  it("« -.5 » est RECONNU comme nombre (-0.5) : le signe est une règle de chaque champ, pas du format", () => {
    expect(val("-.5")).toBe(-0.5);
    expect(val("-5")).toBe(-5);
    expect(val("-0.28")).toBe(-0.28);
  });
  it("\"-0\" et \"-0.0\" → 0 (jamais -0) ; le nombre -0 → 0", () => {
    for (const v of ["-0", "-0.0", "-.0", -0]) {
      const r = parseDecimalInput(v as string | number);
      expect(r.ok, String(v)).toBe(true);
      expect(Object.is(r.ok && r.value, 0), String(v)).toBe(true);
    }
  });
  it("\"5.\" et \"0.\" refusés (Chrome ne les envoie jamais : valeur vide + badInput)", () => {
    expect(val("5.")).toMatch(/^REFUSÉ/);
    expect(val("0.")).toMatch(/^REFUSÉ/);
  });
  it("autres formats refusés avec « Nombre invalide » : \"+5\", \"5,5\", \".\", \"-\", \"--5\", \"abc\", \"0x10\", \"NaN\", \"Infinity\", \"-Infinity\", \"1_000\", \"12 5\", \"0b11\"", () => {
    for (const v of ["+5", "5,5", ".", "-", "--5", "abc", "0x10", "NaN", "Infinity", "-Infinity", "1_000", "12 5", "0b11", "0o7", "5..5", "1.2.3"]) expect(val(v), v).toBe("REFUSÉ:Nombre invalide");
  });
  it("notation scientifique refusée avec un message explicite : \"1e2\", \"1e-1\", \"1E3\", \"1.5e3\", \".5e1\"", () => {
    expect(SCIENTIFIC_NOTATION_MESSAGE).toMatch(/[ÉE]crivez le nombre en d[ée]cimal, sans notation scientifique/i);
    for (const v of ["1e2", "1e-1", "1E3", "1.5e3", ".5e1"]) expect(val(v), v).toBe(`REFUSÉ:${SCIENTIFIC_NOTATION_MESSAGE}`);
  });
  it("nombres JavaScript : finis conservés ; NaN et ±Infinity refusés", () => {
    expect(val(5)).toBe(5);
    expect(val(0.28)).toBe(0.28);
    for (const v of [Number.NaN, Infinity, -Infinity]) expect(val(v), String(v)).toBe("REFUSÉ:Nombre invalide");
  });
  it("lecture côté client : les valeurs que Chrome renvoie pour un champ numérique (mesurées) sont comprises comme côté serveur", () => {
    // mesures Playwright (passe 2) : « .5 » → ".5", « +5 » → "5", « 05 » → "05", « 28.0 » → "28.0", « 0005.50 » → "0005.50", « 5. » → "" (badInput), « 5,5 » → "5.5"
    expect(val(".5")).toBe(0.5);
    expect(val("5")).toBe(5);
    expect(val("05")).toBe(5);
    expect(val("28.0")).toBe(28);
    expect(val("0005.50")).toBe(5.5);
    expect(val("")).toBeUndefined();
    expect(val("5.5")).toBe(5.5);
  });
});
