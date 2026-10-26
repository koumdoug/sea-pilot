import { expect, test } from "@playwright/test";

// R20 : en-têtes de ligne du tableau « Attribué, non attribué et global » (ScopeBreakdown), vérifiés dans le navigateur sur la page PUBLIQUE /demo.
// La démo est déterministe (données fictives codées dans le code) : aucun compte, aucune donnée de production, aucune inscription.
// Alignement : les libellés de ligne restent alignés à gauche ; les cellules voisines sont des valeurs numériques alignées à droite, donc la comparaison porte
// sur le poids de police, le remplissage, la bordure et l'alignement vertical ; l'alignement horizontal de l'en-tête de ligne est vérifié séparément (gauche).
const TABLE = "Attribué, non attribué et global";

test("démo : trois en-têtes de ligne et neuf en-têtes de colonne dans le tableau des périmètres", async ({ page }) => {
  await page.goto("/demo");
  const table = page.getByRole("table", { name: TABLE });
  await expect(table).toBeVisible();
  const rowheaders = table.getByRole("rowheader");
  await expect(rowheaders).toHaveCount(3);
  await expect(rowheaders).toHaveText(["Attribué aux campagnes", "Non attribué (sans campagne)", "Global (somme)"]);
  await expect(table.getByRole("columnheader")).toHaveCount(9);
  await expect(table.getByRole("columnheader", { name: "Périmètre" })).toBeVisible();
  await expect(table.getByRole("cell")).toHaveCount(24); // les valeurs restent des cellules de données
});

test("démo : la valeur d'une cellule est rattachée à son en-tête de ligne (nom accessible de la ligne)", async ({ page }) => {
  await page.goto("/demo");
  const table = page.getByRole("table", { name: TABLE });
  await expect(table.getByRole("row", { name: /Non attribué \(sans campagne\)/ })).toHaveCount(1);
  await expect(table.getByRole("row", { name: /Global \(somme\)/ })).toHaveCount(1);
});

test("démo : le style calculé de l'en-tête de ligne correspond à celui des cellules voisines (poids, remplissage, bordure, alignement vertical) et reste aligné à gauche", async ({ page }) => {
  await page.goto("/demo");
  const rows = await page.getByRole("table", { name: TABLE }).locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const th = tr.querySelector("th") as HTMLElement;
      const td = tr.querySelector("td") as HTMLElement;
      const s = (el: HTMLElement) => { const c = getComputedStyle(el); return { fontWeight: c.fontWeight, fontStyle: c.fontStyle, paddingTop: c.paddingTop, paddingBottom: c.paddingBottom, paddingLeft: c.paddingLeft, paddingRight: c.paddingRight, borderBottomWidth: c.borderBottomWidth, borderBottomStyle: c.borderBottomStyle, borderBottomColor: c.borderBottomColor, verticalAlign: c.verticalAlign, textAlign: c.textAlign, fontSize: c.fontSize, color: c.color }; };
      return { label: th.textContent, th: s(th), td: s(td) };
    }),
  );
  expect(rows).toHaveLength(3);
  for (const r of rows) {
    for (const k of ["fontWeight", "fontStyle", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "borderBottomWidth", "borderBottomStyle", "borderBottomColor", "verticalAlign", "fontSize"] as const) {
      expect(r.th[k], `${r.label} : ${k}`).toBe(r.td[k]);
    }
    expect(["left", "start"], `${r.label} : alignement`).toContain(r.th.textAlign);
    expect(r.td.textAlign, "les valeurs numériques restent alignées à droite").toBe("right");
  }
  expect(rows[2].th.fontWeight, "ligne Global en gras").toBe(rows[2].td.fontWeight);
  expect(Number(rows[2].th.fontWeight)).toBeGreaterThanOrEqual(600);
  expect(Number(rows[0].th.fontWeight)).toBeLessThan(600);
  expect(Number(rows[1].th.fontWeight)).toBeLessThan(600);
});
