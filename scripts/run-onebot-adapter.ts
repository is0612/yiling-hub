import "dotenv/config";
import { connectOnebot, resolveOnebotEvent } from "../server/utils/channel-adapter/onebot/client";
import { loadOnebotConnections, type OnebotConnectionRecord } from "../server/utils/channel-adapter/onebot/configure";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
let running = true;
const shutdown = () => {
  running = false;
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function log(record: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 指数退避重连（1s → 30s 上限）。 */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

async function serveConnection(record: OnebotConnectionRecord): Promise<void> {
  const handleEvent = createOnebotMessageHandler(record);
  let attempt = 0;

  while (running) {
    try {
      await new Promise<void>((resolve, reject) => {
        connectOnebot(record.config, {
          onMessage: async (event) => {
            const result = await handleEvent(event);
            log({ event: "onebot-message-handled", connectionId: record.id, ...result });
          },
          onStatus: (status, detail) => {
            if (status === "ready") {
              attempt = 0;
              prisma.platformConnection.update({ where: { id: record.id }, data: { status: "CONNECTED" } }).catch(() => undefined);
              log({ event: "onebot-connected", connectionId: record.id });
            } else if (status === "error" || status === "disconnected") {
              if (status === "error") {
                prisma.platformConnection.update({ where: { id: record.id }, data: { status: "ERROR" } }).catch(() => undefined);
              }
              log({ event: "onebot-" + status, connectionId: record.id, detail: detail ?? "" });
            }
          },
        }).then(
          () => resolve(),
          (error) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      });
      // 连接正常结束（通常是被探测失败/对端关闭触发），这里不退出循环，等下一轮重连。
      attempt = 0;
    } catch (error) {
      log({ event: "onebot-connect-failed", connectionId: record.id, error: error instanceof Error ? error.message : String(error) });
    }

    if (!running) break;
    const wait = backoffMs(attempt);
    attempt += 1;
    await sleep(wait);
  }
}

async function main() {
  const records = await loadOnebotConnections();
  if (records.length === 0) {
    log({ event: "onebot-no-connections", hint: "请先在「渠道管理」创建 QQ 小号（OneBot）连接并绑定角色。" });
  }
  await Promise.all(records.map(serveConnection));
  await prisma.$disconnect();
}

// 导出 resolveOnebotEvent 供测试直接引用（避免未使用告警）。
export { resolveOnebotEvent };

main().catch(async (error) => {
  console.error("QQ 小号（OneBot）适配器启动失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
