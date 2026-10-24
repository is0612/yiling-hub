import "dotenv/config";
import { loadBiliConnections, type BiliConnectionRecord } from "../server/utils/channel-adapter/bili/configure";
import { runDutyRound } from "../server/utils/channel-adapter/bili/duty-pipeline";
import { shouldRunDuty, toDayKey } from "../server/utils/channel-adapter/bili/duty-scheduler";
import { createBiliMessageHandler, pollBiliInbox } from "../server/utils/channel-adapter/bili/serve";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
let running = true;
const shutdown = () => {
  running = false;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const SCAN_INTERVAL_MS = Number(process.env.YILING_BILI_DUTY_INTERVAL_MS ?? 60_000);

function log(record: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 每个连接的今日状态（已挑条数、已跑窗口）缓存，避免每轮都查库。 */
type ConnectionState = {
  picked: number;
  windowsRun: string[];
  running: boolean;
};

const states = new Map<string, ConnectionState>();

async function refreshState(record: BiliConnectionRecord, bindingId: string): Promise<ConnectionState> {
  const today = toDayKey(new Date());
  const reports = await prisma.biliRoundReport.findMany({
    where: { bindingId, day: today },
    select: { pickedCount: true },
  });
  const picked = reports.reduce((sum, r) => sum + r.pickedCount, 0);
  return { picked, windowsRun: [], running: false };
}

async function serveConnection(record: BiliConnectionRecord): Promise<void> {
  // B站连接可能绑定多个角色，逐个绑定服务
  for (const binding of record.bindings) {
    const stateKey = binding.id;
    let state = states.get(stateKey) ?? { picked: 0, windowsRun: [], running: false };
    states.set(stateKey, state);

    const config = record.duty;
    const now = new Date();
    const today = toDayKey(now);

    // 跨天后重置状态
    const current = await refreshState(record, binding.id);
    const decision = shouldRunDuty(now, config, current, state.running);

    if (decision.due && decision.window) {
      state.running = true;
      const mark = `${today}:${decision.window}`;
      if (!state.windowsRun.includes(mark)) state.windowsRun.push(mark);

      log({ event: "bili-duty-start", connectionId: record.id, bindingId: binding.id, window: decision.window });
      try {
        const result = await runDutyRound(record, binding);
        log({ event: "bili-duty-done", connectionId: record.id, bindingId: binding.id, ...result });
      } catch (error) {
        log({ event: "bili-duty-error", connectionId: record.id, bindingId: binding.id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        state.running = false;
      }
    }

    // 被动回复：轮询收件箱（私信 / 回复我的评论）
    try {
      const handler = createBiliMessageHandler(record, binding);
      const handled = await pollBiliInbox(record, binding, handler);
      if (handled > 0) {
        log({ event: "bili-inbox-handled", connectionId: record.id, bindingId: binding.id, handled });
      }
    } catch (error) {
      log({ event: "bili-inbox-error", connectionId: record.id, bindingId: binding.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function main() {
  log({ event: "bili-adapter-start", intervalMs: SCAN_INTERVAL_MS });

  while (running) {
    try {
      const records = await loadBiliConnections();
      if (records.length === 0) {
        log({ event: "bili-no-connections", hint: "请先在「渠道管理」创建 B站 连接并绑定角色。" });
      } else {
        for (const record of records) {
          await serveConnection(record);
        }
      }
    } catch (error) {
      log({ event: "bili-scan-error", error: error instanceof Error ? error.message : String(error) });
    }
    await sleep(SCAN_INTERVAL_MS);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("B站适配器启动失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
