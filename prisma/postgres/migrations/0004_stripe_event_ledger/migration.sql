-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "checkoutReservationId" TEXT,
ADD COLUMN     "checkoutReservedUntil" TIMESTAMP(3),
ADD COLUMN     "checkoutSessionId" TEXT,
ADD COLUMN     "stripeSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lockedUntil" TIMESTAMP(3),
    "workspaceId" TEXT,
    "outcome" TEXT,
    "note" TEXT,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StripeEvent_status_lockedUntil_idx" ON "StripeEvent"("status", "lockedUntil");
