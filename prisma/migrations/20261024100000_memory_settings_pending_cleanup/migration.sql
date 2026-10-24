-- Add settings required by the memory-settings API.
-- Keep the original initial migration immutable so existing databases can upgrade safely.
ALTER TABLE "character_memory_settings"
  ADD COLUMN "pendingSnapshotIntervalDays" INTEGER,
  ADD COLUMN "rawMessageCleanupEnabled" BOOLEAN NOT NULL DEFAULT false;
