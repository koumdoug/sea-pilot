-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "stripeSyncLeaseId" TEXT,
ADD COLUMN     "stripeSyncLeaseUntil" TIMESTAMP(3);
