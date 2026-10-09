import type { Role } from "./constants";

export type Action =
  | "read" // consulter
  | "write" // créer / modifier du contenu métier (campagnes, leads, pages…)
  | "delete" // supprimer / archiver définitivement
  | "ai" // utiliser l'IA (coûts)
  | "manage_integrations"
  | "manage_products" // catalogue des SaaS du portefeuille, canaux de prospection
  | "approve_outreach" // approuver modèles de messages et campagnes de prospection
  | "manage_members"
  | "manage_billing"
  | "manage_settings"
  | "delete_workspace";

const MATRIX: Record<Role, Action[]> = {
  viewer: ["read"],
  member: ["read", "write", "ai"],
  admin: ["read", "write", "delete", "ai", "manage_integrations", "manage_products", "approve_outreach", "manage_members", "manage_settings"],
  owner: ["read", "write", "delete", "ai", "manage_integrations", "manage_products", "approve_outreach", "manage_members", "manage_settings", "manage_billing", "delete_workspace"],
};

export function can(role: string | null | undefined, action: Action): boolean {
  if (!role || !(role in MATRIX)) return false;
  return MATRIX[role as Role].includes(action);
}

export class PermissionError extends Error {
  constructor(public action: Action) {
    super("Permission refusée pour cette action.");
  }
}

export function assertCan(role: string | null | undefined, action: Action) {
  if (!can(role, action)) throw new PermissionError(action);
}
