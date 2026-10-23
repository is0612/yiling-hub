import { requireLocalDevOwner } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { enqueueDueMemorySnapshots } from "../../../utils/memory-scheduler";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const report = await enqueueDueMemorySnapshots(getPrisma(), { ownerId });
  return {
    ...report,
    note: "只负责将到期周期写入持久化任务队列；当前版本尚无 Worker 执行快照生成。",
  };
});
