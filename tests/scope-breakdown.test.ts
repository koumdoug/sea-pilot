// R20 : le tableau « Attribué, non attribué et global » (ScopeBreakdown) a des EN-TÊTES DE LIGNE sémantiques : le libellé de chaque ligne est un
// <th scope="row">, les neuf en-têtes de colonne restent des <th scope="col">, les huit valeurs de chaque ligne restent des <td>.
// Rendu serveur (react-dom/server) : aucun navigateur ; l'analyse du HTML est faite par expressions régulières sur le balisage produit.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScopeBreakdown } from "@/components/scope-breakdown";
import { addTotals, type Totals } from "@/lib/kpi";

const attributed: Totals = { spend: 1490, impressions: 113_500, clicks: 1460, leads: 107, qualifiedLeads: 35, customers: 9, revenue: 4860, customersWithRevenue: 9 };
const unattributed: Totals = { spend: 26, impressions: 1200, clicks: 34, leads: 42, qualifiedLeads: 6, customers: 0, revenue: 0, customersWithRevenue: 0 };
const empty: Totals = { spend: 0, impressions: 0, clicks: 0, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0 };
const render = (un: Totals) => renderToStaticMarkup(createElement(ScopeBreakdown, { attributed, unattributed: un, total: addTotals(attributed, un), currency: "EUR", period: "du 1 au 30" }));
const html = render(unattributed);

const cellsOf = (row: string) => [...row.matchAll(/<(th|td)([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({ tag: m[1], attrs: m[2], text: m[3].replace(/<[^>]+>/g, "").trim() }));
const section = (tag: "thead" | "tbody") => html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))![1];
const rowsOf = (s: string) => [...s.matchAll(/<tr([^>]*)>([\s\S]*?)<\/tr>/g)].map((m) => ({ trAttrs: m[1], cells: cellsOf(m[2]) }));
const bodyRows = () => rowsOf(section("tbody"));

describe("R20 — en-têtes de ligne du tableau des périmètres", () => {
  it("les trois libellés de ligne sont des <th scope=\"row\"> avec les bons textes, dans l'ordre", () => {
    const labels = bodyRows().map((r) => r.cells[0]);
    expect(labels).toHaveLength(3);
    for (const c of labels) { expect(c.tag).toBe("th"); expect(c.attrs).toMatch(/scope="row"/); }
    expect(labels.map((c) => c.text)).toEqual(["Attribué aux campagnes", "Non attribué (sans campagne)", "Global (somme)"]);
  });
  it("les huit autres cellules de chaque ligne restent des <td> (24 au total)", () => {
    const rows = bodyRows();
    for (const r of rows) { expect(r.cells).toHaveLength(9); expect(r.cells.slice(1).every((c) => c.tag === "td")).toBe(true); }
    expect((html.match(/<td[\s>]/g) ?? []).length).toBe(24);
  });
  it("les neuf en-têtes de colonne gardent scope=\"col\" (dont « Périmètre »), sans aucun scope=\"row\" dans l'en-tête", () => {
    const head = rowsOf(section("thead"));
    expect(head).toHaveLength(1);
    expect(head[0].cells).toHaveLength(9);
    for (const c of head[0].cells) { expect(c.tag).toBe("th"); expect(c.attrs).toMatch(/scope="col"/); }
    expect(head[0].cells.map((c) => c.text)).toEqual(["Périmètre", "Dépense", "Clics", "Leads", "CPL", "Clients", "CAC", "CA", "ROAS"]);
    expect(section("thead")).not.toMatch(/scope="row"/);
  });
  it("total attendu : 12 <th> (9 colonnes + 3 lignes) et 24 <td> ; exactement 3 scope=\"row\" et 9 scope=\"col\"", () => {
    expect((html.match(/<th[\s>]/g) ?? []).length).toBe(12);
    expect((html.match(/<td[\s>]/g) ?? []).length).toBe(24);
    expect((html.match(/scope="row"/g) ?? []).length).toBe(3);
    expect((html.match(/scope="col"/g) ?? []).length).toBe(9);
  });
  it("le caption, la région accessible et son libellé sont conservés", () => {
    expect(html).toMatch(/<caption class="sr-only">Attribué, non attribué et global<\/caption>/);
    expect(html).toMatch(/role="region"/);
    expect(html).toMatch(/aria-label="Attribué, non attribué et global"/);
    expect(html).toMatch(/aria-labelledby="scope-title"/);
  });
  it("les 24 cellules de valeurs gardent text-right et tabular-nums", () => {
    for (const r of bodyRows()) for (const c of r.cells.slice(1)) { expect(c.attrs).toMatch(/text-right/); expect(c.attrs).toMatch(/tabular-nums/); }
  });
  it("les tirets « — » du lot non attribué sont conservés (CPL, CAC, chiffre d'affaires, ROAS) ; les chiffres existent toujours", () => {
    const [attr, un, glob] = bodyRows();
    const texts = (r: typeof attr) => r.cells.slice(1).map((c) => c.text);
    expect(texts(un)[3]).toBe("—"); // CPL
    expect(texts(un)[5]).toBe("—"); // CAC
    expect(texts(un)[6]).toBe("—"); // CA (aucun revenu non attribué)
    expect(texts(un)[7]).toBe("—"); // ROAS
    expect(texts(un)[1]).toBe("34"); // clics
    expect(texts(un)[2]).toBe("42"); // leads
    expect(texts(attr)).not.toContain("—");
    expect(texts(glob)).not.toContain("—");
    expect(texts(glob)[2]).toBe("149"); // 107 + 42
  });
  it("seul le libellé de la ligne « Global » est en gras : classe font-semibold sur sa ligne et son en-tête, jamais sur les deux autres", () => {
    const [attr, un, glob] = bodyRows();
    expect(glob.trAttrs).toMatch(/font-semibold/);
    expect(glob.cells[0].attrs).toMatch(/font-semibold/);
    for (const r of [attr, un]) {
      expect(r.trAttrs).not.toMatch(/font-semibold/);
      expect(r.cells[0].attrs).not.toMatch(/font-semibold/);
      expect(r.cells[0].attrs).toMatch(/font-normal/); // le navigateur met <th> en gras par défaut : poids explicite
    }
  });
  it("l'en-tête de ligne reprend l'apparence d'une cellule : bordure, remplissage, alignement haut, alignement à gauche", () => {
    const th = bodyRows()[0].cells[0].attrs;
    const td = bodyRows()[0].cells[1].attrs;
    for (const cls of ["border-b", "border-slate-100", "px-3", "py-2.5", "align-top"]) { expect(th, cls).toContain(cls); expect(td, cls).toContain(cls); }
    expect(th).toMatch(/text-left/);
  });
  it("sans lot non attribué : comportement existant conservé, aucun tableau rendu, uniquement le paragraphe d'information", () => {
    const h = render(empty);
    expect(h).not.toMatch(/<table/);
    expect(h).not.toMatch(/<th[\s>]/);
    expect(h).toMatch(/<p [^>]*>Périmètre : toutes les données de la période \(du 1 au 30\) sont rattachées à une campagne\.<\/p>/);
  });
});
