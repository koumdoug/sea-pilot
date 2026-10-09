-- AlterTable
ALTER TABLE "Audience" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "LandingPage" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "productId" TEXT;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT,
    "description" TEXT,
    "valueProposition" TEXT,
    "targetCustomers" TEXT,
    "problemsSolved" JSONB,
    "features" JSONB,
    "pricing" JSONB,
    "publicUrl" TEXT,
    "signupUrl" TEXT,
    "demoUrl" TEXT,
    "salesArguments" JSONB,
    "objections" JSONB,
    "channels" JSONB,
    "qualification" JSONB,
    "objectives" JSONB,
    "unconfirmed" JSONB,
    "status" TEXT NOT NULL DEFAULT 'preparation',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prospect" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "jobTitle" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "websiteDomain" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "audienceType" TEXT NOT NULL DEFAULT 'b2b',
    "segment" TEXT,
    "source" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "collectedAt" TIMESTAMP(3) NOT NULL,
    "legalBasis" TEXT NOT NULL DEFAULT 'unknown',
    "legalBasisNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'identified',
    "nextFollowUpAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "contactCount" INTEGER NOT NULL DEFAULT 0,
    "optedOutAt" TIMESTAMP(3),
    "campaignId" TEXT,
    "notes" TEXT,
    "importBatch" TEXT,
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prospect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectProduct" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectContact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "productId" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "templateId" TEXT,
    "subject" TEXT,
    "summary" TEXT,
    "outcome" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachChannel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "minDaysBetweenContacts" INTEGER NOT NULL DEFAULT 7,
    "maxContactsPerProspect" INTEGER NOT NULL DEFAULT 3,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateId" TEXT,
    "segment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "requestedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "prospectId" TEXT,
    "type" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION,
    "currency" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "externalRef" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "note" TEXT,
    "recordedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_workspaceId_status_idx" ON "Product"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_workspaceId_slug_key" ON "Product"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "Prospect_workspaceId_productId_status_idx" ON "Prospect"("workspaceId", "productId", "status");

-- CreateIndex
CREATE INDEX "Prospect_workspaceId_nextFollowUpAt_idx" ON "Prospect"("workspaceId", "nextFollowUpAt");

-- CreateIndex
CREATE UNIQUE INDEX "Prospect_workspaceId_dedupeKey_key" ON "Prospect"("workspaceId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectProduct_prospectId_productId_key" ON "ProspectProduct"("prospectId", "productId");

-- CreateIndex
CREATE INDEX "ProspectContact_workspaceId_prospectId_createdAt_idx" ON "ProspectContact"("workspaceId", "prospectId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageTemplate_workspaceId_productId_status_idx" ON "MessageTemplate"("workspaceId", "productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachChannel_workspaceId_channel_key" ON "OutreachChannel"("workspaceId", "channel");

-- CreateIndex
CREATE INDEX "OutreachCampaign_workspaceId_productId_status_idx" ON "OutreachCampaign"("workspaceId", "productId", "status");

-- CreateIndex
CREATE INDEX "ProductEvent_workspaceId_productId_type_occurredAt_idx" ON "ProductEvent"("workspaceId", "productId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProductEvent_workspaceId_dedupeKey_key" ON "ProductEvent"("workspaceId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospect" ADD CONSTRAINT "Prospect_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectProduct" ADD CONSTRAINT "ProspectProduct_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectProduct" ADD CONSTRAINT "ProspectProduct_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectContact" ADD CONSTRAINT "ProspectContact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectContact" ADD CONSTRAINT "ProspectContact_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachChannel" ADD CONSTRAINT "OutreachChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "Prospect"("id") ON DELETE SET NULL ON UPDATE CASCADE;

