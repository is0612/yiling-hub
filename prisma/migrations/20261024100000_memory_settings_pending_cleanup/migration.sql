-- Add the deferred interval field required by the memory-settings API.
-- rawMessageCleanupEnabled is already introduced by
-- 20261024000000_explicit_raw_message_cleanup_opt_in.
ALTER TABLE "character_memory_settings"
  ADD COLUMN "pendingSnapshotIntervalDays" INTEGER;
