import { requireLocalDevOwner } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { enqueueDueMemorySnapshots } from "../../../utils/memory-scheduler";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const report = await enqueueDueMemorySnapshots(getPrisma(), { ownerId });
  return {
    ...report,
    note: "调度器只负责把到期周期写入持久化队列；由独立 Worker 调用已配置的模型执行快照生成。",
  };
});
