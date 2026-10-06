import { db } from "./db";
import { log, errMsg } from "./logger";

/** Journal d'audit des actions importantes. Ne doit jamais faire échouer l'action métier. */
export async function audit(p: { workspaceId?: string | null; userId?: string | null; action: string; entity?: string; entityId?: string; meta?: Record<string, unknown>; ipHash?: string | null }) {
  try {
    await db.auditLog.create({ data: { workspaceId: p.workspaceId ?? null, userId: p.userId ?? null, action: p.action, entity: p.entity, entityId: p.entityId, meta: p.meta as object | undefined, ipHash: p.ipHash ?? null } });
    log.info("audit", { action: p.action, entity: p.entity, workspaceId: p.workspaceId });
  } catch (e) {
    log.error("audit.failed", { action: p.action, error: errMsg(e) });
  }
}
