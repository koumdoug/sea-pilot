// Lot 3A / R18 : le taux de conversion GLOBAL (leads ÷ clics, leads et clics sans campagne inclus) est libellé « global » et le taux rattaché aux campagnes est affiché à côté.
// Chiffres de référence calculés à la main : global 149 leads / 1 494 clics = 9,97 % ; rattaché 107 leads / 1 460 clics = 7,33 %.
import { describe, expect, it } from "vitest";
import { computeKpis, conversionTile, type Totals } from "@/lib/kpi";

const k = (t: Partial<Totals>) => computeKpis({ spend: 0, impressions: 0, clicks: 0, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0, ...t });
const global = k({ clicks: 1494, leads: 149 });
const attributed = k({ clicks: 1460, leads: 107 });

describe("conversionTile (tuile « taux de conversion » du tableau de bord et des analyses)", () => {
  it("le libellé indique « global » et la valeur est le taux global (10,0 %)", () => {
    const t = conversionTile(global, attributed, 42);
    expect(t.label).toMatch(/global/i);
    expect(t.value).toBe("10,0 %");
  });
  it("le taux rattaché aux campagnes (7,3 %) est affiché à côté, avec son périmètre", () => {
    const t = conversionTile(global, attributed, 42);
    expect(t.hint).toMatch(/7,3 %/);
    expect(t.hint).toMatch(/rattaché aux campagnes/i);
    expect(t.hint).toMatch(/sans campagne/i);
  });
  it("sans lead non attribué, les deux taux coïncident : pas de double affichage", () => {
    const t = conversionTile(global, global, 0);
    expect(t.hint).toBe("leads ÷ clics");
    expect(t.hint).not.toMatch(/rattaché/);
  });
  it("périmètre rattaché sans taux calculable (aucun clic) : le taux global est affiché sans valeur inventée", () => {
    const t = conversionTile(global, k({ leads: 0 }), 42);
    expect(t.value).toBe("10,0 %");
    expect(t.hint).not.toMatch(/rattaché aux campagnes : /);
  });
  it("taux global non calculable : valeur « — »", () => {
    expect(conversionTile(k({}), null, 0).value).toBe("—");
  });
});
