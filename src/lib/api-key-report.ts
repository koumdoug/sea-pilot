// Mesure des clés API par forfait — LECTURE SEULE. Aucune écriture, aucun identifiant de clé, préfixe, empreinte ni adresse n'est lu ni produit : uniquement des comptages.
// Destiné à mesurer, APRÈS autorisation explicite et sur la base visée, l'impact du réservé-à-Pro de l'API (voir docs/stripe-hardening.md, section « Clés API existantes »).

export type ApiKeyRow = {
  workspaceId: string;
  /** forfait de l'espace au moment de la mesure ; null si l'espace n'a pas d'abonnement */
  plan: string | null;
  /** l'espace est exempté (accès propriétaire gratuit, droits Pro) : compté à part, jamais « concerné » */
  exempt: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
};

export type ApiKeyPlanSummary = {
  keys: number; activeKeys: number;
  /** clés actives utilisées au cours de la fenêtre récente */
  recentlyUsedKeys: number;
  workspaces: number; workspacesWithActiveKeys: number; workspacesWithRecentUse: number;
  /** dernière utilisation connue parmi les clés du forfait (ISO), null si jamais utilisée */
  lastUsedAt: string | null;
};
export type ApiKeyReport = {
  generatedAt: string; recentDays: number;
  byPlan: Record<string, ApiKeyPlanSummary>;
  exempt: ApiKeyPlanSummary;
  /** clients dont l'API cesserait de fonctionner sous la règle « Pro seulement » : forfaits sans droit API (hors exemptés), clés actives uniquement */
  affected: { workspacesWithActiveKeys: number; workspacesWithRecentUse: number; activeKeys: number; recentlyUsedKeys: number };
};

const empty = (): ApiKeyPlanSummary => ({ keys: 0, activeKeys: 0, recentlyUsedKeys: 0, workspaces: 0, workspacesWithActiveKeys: 0, workspacesWithRecentUse: 0, lastUsedAt: null });

/** Forfaits qui incluent l'API (miroir de `PlanRights.api` : le test d'alignement avec plans.ts est dans tests/hardening-secondary.test.ts). */
export const API_PLANS = ["pro"] as const;

export function summarizeApiKeys(rows: ApiKeyRow[], opts: { now?: Date; recentDays?: number } = {}): ApiKeyReport {
  const now = opts.now ?? new Date(), recentDays = opts.recentDays ?? 30;
  const since = now.getTime() - recentDays * 86_400_000;
  const groups = new Map<string, ApiKeyRow[]>();
  for (const r of rows) { const k = r.exempt ? "__exempt" : (r.plan ?? "sans_abonnement"); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const summarize = (list: ApiKeyRow[]): ApiKeyPlanSummary => {
    const s = empty();
    const ws = new Set<string>(), active = new Set<string>(), recent = new Set<string>();
    let last = 0;
    for (const r of list) {
      s.keys++; ws.add(r.workspaceId);
      const isActive = !r.revokedAt;
      if (isActive) { s.activeKeys++; active.add(r.workspaceId); }
      const used = r.lastUsedAt?.getTime() ?? 0;
      if (used > last) last = used;
      if (isActive && used >= since) { s.recentlyUsedKeys++; recent.add(r.workspaceId); }
    }
    s.workspaces = ws.size; s.workspacesWithActiveKeys = active.size; s.workspacesWithRecentUse = recent.size; s.lastUsedAt = last ? new Date(last).toISOString() : null;
    return s;
  };
  const byPlan: Record<string, ApiKeyPlanSummary> = {};
  for (const [k, list] of groups) if (k !== "__exempt") byPlan[k] = summarize(list);
  const affectedRows = rows.filter((r) => !r.exempt && !(API_PLANS as readonly string[]).includes(r.plan ?? ""));
  const a = summarize(affectedRows);
  return {
    generatedAt: now.toISOString(), recentDays, byPlan, exempt: summarize(groups.get("__exempt") ?? []),
    affected: { workspacesWithActiveKeys: a.workspacesWithActiveKeys, workspacesWithRecentUse: a.workspacesWithRecentUse, activeKeys: a.activeKeys, recentlyUsedKeys: a.recentlyUsedKeys },
  };
}
