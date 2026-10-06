import { db } from "./db";

/** Export complet (RGPD / portabilité) des données d'un espace de travail. Aucun secret : les identifiants d'intégration sont exclus. */
export async function exportWorkspace(workspaceId: string) {
  const where = { workspaceId };
  const [workspace, memberships, offers, audiences, campaigns, landingPages, forms, leads, customers, contacts, conversations, qualifications, sequences, followUps, tasks, ads, keywords, metrics, events, consents, aiGenerations, strategies, researches] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId } }),
    db.membership.findMany({ where, include: { user: { select: { id: true, name: true, email: true } } } }),
    db.offer.findMany({ where }), db.audience.findMany({ where }), db.campaign.findMany({ where }), db.landingPage.findMany({ where }), db.form.findMany({ where }),
    db.lead.findMany({ where }), db.customer.findMany({ where }), db.contact.findMany({ where }), db.conversation.findMany({ where }), db.aIQualification.findMany({ where }),
    db.followUpSequence.findMany({ where }), db.followUp.findMany({ where }), db.task.findMany({ where }), db.ad.findMany({ where }), db.keyword.findMany({ where }),
    db.metric.findMany({ where }), db.analyticsEvent.findMany({ where, take: 50_000, orderBy: { createdAt: "desc" } }), db.consent.findMany({ where }),
    db.aIGeneration.findMany({ where, take: 5_000, orderBy: { createdAt: "desc" } }), db.strategy.findMany({ where }), db.marketResearch.findMany({ where }),
  ]);
  const integrations = (await db.integration.findMany({ where, select: { provider: true, status: true, accountName: true, connectedAt: true, lastSyncAt: true } }));
  return {
    exportedAt: new Date().toISOString(), format: "sea-pilot-export-v1",
    workspace, members: memberships.map((m) => ({ role: m.role, ...m.user })), offers, audiences, campaigns, landingPages, forms, leads, customers, contacts, conversations,
    qualifications, sequences, followUps, tasks, ads, keywords, metrics, analyticsEvents: events, consents, aiGenerations, strategies, researches, integrations,
  };
}

export async function exportUser(userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, locale: true, createdAt: true, lastLoginAt: true, memberships: { select: { role: true, createdAt: true, workspace: { select: { id: true, name: true } } } } } });
  const audit = await db.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 1000, select: { action: true, entity: true, createdAt: true } });
  return { exportedAt: new Date().toISOString(), format: "sea-pilot-user-export-v1", user, audit };
}
