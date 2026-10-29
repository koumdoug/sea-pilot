// Règles du suivi éditorial (états, priorité, échéance, calendrier). LOGIQUE PURE, non branchée à l'interface :
// la persistance exige un modèle Prisma dédié (voir docs/lot2-modele-editorial.md), non créé dans ce lot (aucune migration autorisée).
// Règle centrale : « Publié » n'existe que sur confirmation explicite de l'utilisateur ; SEA Pilot ne publie rien sur un CMS.

export const EDITORIAL_STATES = ["idea", "brief_todo", "ready", "writing", "published"] as const;
export type EditorialState = (typeof EDITORIAL_STATES)[number];
export const EDITORIAL_LABEL: Record<EditorialState, string> = { idea: "Idée", brief_todo: "Brief à préparer", ready: "Prêt à rédiger", writing: "En rédaction", published: "Publié" };
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type EditorialItem = { id: string; title: string; state: EditorialState; priority: Priority; dueAt: Date | null; publishedConfirmedAt: Date | null; landingPageId: string | null };

export class EditorialError extends Error {}

/** Un état ne recule que d'un cran ou avance d'un cran ; « publié » est terminal et exige la confirmation. */
export function canTransition(from: EditorialState, to: EditorialState): boolean {
  if (from === to) return false;
  const a = EDITORIAL_STATES.indexOf(from), b = EDITORIAL_STATES.indexOf(to);
  if (from === "published") return false;
  return Math.abs(a - b) === 1;
}

export function transition(item: EditorialItem, to: EditorialState, opts: { confirmedPublished?: boolean; now?: Date } = {}): EditorialItem {
  if (!canTransition(item.state, to)) throw new EditorialError(`Passage « ${EDITORIAL_LABEL[item.state]} » → « ${EDITORIAL_LABEL[to]} » impossible.`);
  if (to === "published") {
    if (opts.confirmedPublished !== true) throw new EditorialError("Un contenu n'est « Publié » qu'après votre confirmation explicite : SEA Pilot ne publie rien lui-même.");
    return { ...item, state: to, publishedConfirmedAt: opts.now ?? new Date() };
  }
  return { ...item, state: to, publishedConfirmedAt: null };
}

const P_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
export const isOverdue = (i: EditorialItem, now = new Date()) => i.state !== "published" && !!i.dueAt && i.dueAt.getTime() < now.getTime();

/** Ordre de travail : en retard d'abord, puis priorité, puis échéance (sans échéance en dernier). Les contenus publiés sont exclus. */
export function workQueue(items: EditorialItem[], now = new Date()): EditorialItem[] {
  return items.filter((i) => i.state !== "published").sort((a, b) =>
    Number(isOverdue(b, now)) - Number(isOverdue(a, now)) || P_RANK[a.priority] - P_RANK[b.priority] || (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity));
}

/** Calendrier : regroupement par semaine ISO (lundi) ; les contenus sans échéance restent à part. */
export function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
export function calendarByWeek(items: EditorialItem[]): { weeks: { monday: string; items: EditorialItem[] }[]; undated: EditorialItem[] } {
  const map = new Map<string, EditorialItem[]>();
  const undated: EditorialItem[] = [];
  for (const i of items) { if (!i.dueAt) { undated.push(i); continue; } const k = mondayOf(i.dueAt); map.set(k, [...(map.get(k) ?? []), i]); }
  return { weeks: [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([monday, its]) => ({ monday, items: its })), undated };
}

/** Résultats observés : uniquement les mesures réelles d'une landing page rattachée ; jamais d'estimation. */
export function observedResults(item: EditorialItem, m: { views: number; leads: number } | null): { available: boolean; text: string } {
  if (item.state !== "published") return { available: false, text: "Aucun résultat : le contenu n'est pas publié." };
  if (!m) return { available: false, text: "Aucune landing page rattachée : résultats non mesurables." };
  if (m.views === 0) return { available: false, text: "Aucune visite mesurée sur la landing page rattachée." };
  return { available: true, text: `Landing page rattachée : ${m.views} visite(s), ${m.leads} lead(s) (mesures globales de la page, non attribuées à ce contenu).` };
}
