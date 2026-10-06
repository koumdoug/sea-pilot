import { db } from "./db";

/** Analyse CSV minimale (RFC 4180) : guillemets, séparateur « , » ou « ; » détecté sur la première ligne. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const first = t.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const HEADERS: Record<string, string[]> = {
  date: ["date", "jour", "day"], campaign: ["campaign", "campagne", "campaign name", "nom de la campagne"], spend: ["spend", "depense", "depenses", "cost", "cout", "montant depense"],
  impressions: ["impressions", "impr", "impr."], clicks: ["clicks", "clics", "clic"],
};

function num(s: string | undefined): number | null {
  if (s === undefined || s === "") return 0;
  const n = Number(s.replace(/\s/g, "").replace(/[€$£]/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export type CsvImportResult = { imported: number; errors: { line: number; message: string }[] };

export async function importMetricsCsv(workspaceId: string, text: string): Promise<CsvImportResult> {
  const rows = parseCsv(text);
  if (rows.length < 2) return { imported: 0, errors: [{ line: 1, message: "Le fichier doit contenir un en-tête et au moins une ligne." }] };
  const head = rows[0].map(norm);
  const idx: Record<string, number> = {};
  for (const [k, names] of Object.entries(HEADERS)) idx[k] = head.findIndex((h) => names.includes(h));
  const missing = ["date", "campaign", "spend"].filter((k) => idx[k] < 0);
  if (missing.length) return { imported: 0, errors: [{ line: 1, message: `Colonnes manquantes : ${missing.join(", ")} (attendu : date, campagne, dépense, impressions, clics).` }] };
  if (rows.length > 5001) return { imported: 0, errors: [{ line: 1, message: "Maximum 5 000 lignes par import." }] };

  const campaigns = await db.campaign.findMany({ where: { workspaceId }, select: { id: true, name: true, platform: true } });
  const byKey = new Map<string, { id: string; platform: string }>();
  for (const c of campaigns) { byKey.set(norm(c.name), c); byKey.set(c.id, c); }
  const errors: CsvImportResult["errors"] = [];
  let imported = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const date = r[idx.date];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) { errors.push({ line, message: `Date invalide « ${date} » (format AAAA-MM-JJ).` }); continue; }
    if (new Date(`${date}T00:00:00Z`).getTime() > Date.now() + 86_400_000) { errors.push({ line, message: "Date dans le futur." }); continue; }
    const c = byKey.get(norm(r[idx.campaign] ?? "")) ?? byKey.get(r[idx.campaign] ?? "");
    if (!c) { errors.push({ line, message: `Campagne inconnue « ${r[idx.campaign]} » : créez-la d'abord.` }); continue; }
    const spend = num(r[idx.spend]), impressions = idx.impressions >= 0 ? num(r[idx.impressions]) : 0, clicks = idx.clicks >= 0 ? num(r[idx.clicks]) : 0;
    if (spend === null || impressions === null || clicks === null) { errors.push({ line, message: "Valeur numérique invalide." }); continue; }
    if (impressions > 0 && clicks > impressions) { errors.push({ line, message: "Plus de clics que d'impressions." }); continue; }
    const dedupeKey = `csv:${c.id}:${date}`;
    await db.metric.upsert({
      where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
      create: { workspaceId, campaignId: c.id, platform: c.platform, date: new Date(`${date}T00:00:00.000Z`), spend, impressions: Math.round(impressions), clicks: Math.round(clicks), source: "csv", dedupeKey },
      update: { spend, impressions: Math.round(impressions), clicks: Math.round(clicks) },
    });
    imported++;
  }
  return { imported, errors: errors.slice(0, 50) };
}
