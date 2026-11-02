-- AlterTable
ALTER TABLE "FollowUp" ADD COLUMN     "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failureKind" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "leaseToken" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "retryAfter" TIMESTAMP(3),
ADD COLUMN     "technicalFailureCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "EmailLog" ADD COLUMN     "attemptNo" INTEGER,
ADD COLUMN     "authorizedAt" TIMESTAMP(3),
ADD COLUMN     "callStartedAt" TIMESTAMP(3),
ADD COLUMN     "contradictionAckAt" TIMESTAMP(3),
ADD COLUMN     "contradictionAckById" TEXT,
ADD COLUMN     "contradictionAckNote" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "followUpId" TEXT,
ADD COLUMN     "httpStatus" INTEGER,
ADD COLUMN     "humanNote" TEXT,
ADD COLUMN     "humanVerdict" TEXT,
ADD COLUMN     "humanVerdictAt" TIMESTAMP(3),
ADD COLUMN     "humanVerdictById" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "payloadHash" TEXT;

-- CreateIndex
CREATE INDEX "FollowUp_status_leaseUntil_idx" ON "FollowUp"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "FollowUp_status_retryAfter_idx" ON "FollowUp"("status", "retryAfter");

-- CreateIndex
CREATE INDEX "EmailLog_followUpId_idx" ON "EmailLog"("followUpId");
