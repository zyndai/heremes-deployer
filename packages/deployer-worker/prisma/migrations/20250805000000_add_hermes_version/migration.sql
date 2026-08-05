-- AlterTable: add hermesVersion and targetHermesVersion to Agent
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "hermesVersion" TEXT;
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "targetHermesVersion" TEXT;
