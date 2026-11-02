-- Migration additive (aucune table reconstruite, aucune colonne supprimée) : bail et compteurs des relances, journal des tentatives d'e-mail.
-- Les anciennes lignes gardent des valeurs nulles, sauf les deux compteurs (0). Une ancienne ligne « running » n'a pas de jeton : elle n'est jamais reprise automatiquement.

-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "FollowUp" ADD COLUMN "failureKind" TEXT;
ALTER TABLE "FollowUp" ADD COLUMN "lastAttemptAt" DATETIME;
ALTER TABLE "FollowUp" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "FollowUp" ADD COLUMN "leaseUntil" DATETIME;
ALTER TABLE "FollowUp" ADD COLUMN "retryAfter" DATETIME;
ALTER TABLE "FollowUp" ADD COLUMN "technicalFailureCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN "attemptNo" INTEGER;
ALTER TABLE "EmailLog" ADD COLUMN "authorizedAt" DATETIME;
ALTER TABLE "EmailLog" ADD COLUMN "callStartedAt" DATETIME;
ALTER TABLE "EmailLog" ADD COLUMN "contradictionAckAt" DATETIME;
ALTER TABLE "EmailLog" ADD COLUMN "contradictionAckById" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "contradictionAckNote" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "finishedAt" DATETIME;
ALTER TABLE "EmailLog" ADD COLUMN "followUpId" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "httpStatus" INTEGER;
ALTER TABLE "EmailLog" ADD COLUMN "humanNote" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "humanVerdict" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "humanVerdictAt" DATETIME;
ALTER TABLE "EmailLog" ADD COLUMN "humanVerdictById" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "EmailLog" ADD COLUMN "payloadHash" TEXT;

-- CreateIndex
CREATE INDEX "FollowUp_status_leaseUntil_idx" ON "FollowUp"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "FollowUp_status_retryAfter_idx" ON "FollowUp"("status", "retryAfter");

-- CreateIndex
CREATE INDEX "EmailLog_followUpId_idx" ON "EmailLog"("followUpId");
