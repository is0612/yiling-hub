import "dotenv/config";
import { loadQqConnections, type QqConnectionRecord } from "../server/utils/channel-adapter/configure";
import { connectQqGateway, resolveQqConfig } from "../server/utils/channel-adapter/qq";
import { createQqMessageHandler } from "../server/utils/channel-adapter/serve";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
let running = true;
const activeCloses = new Set<() => void>();
const shutdown = () => {
  running = false;
  for (const close of activeCloses) {
    try { close(); } catch { /* ignore */ }
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function log(record: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function serveConnection(record: QqConnectionRecord): Promise<void> {
  const config = resolveQqConfig({ appId: record.appId, appSecret: record.appSecret });
  const handleEvent = createQqMessageHandler(record, config);

  while (running) {
    await new Promise<void>((resolveLoop) => {
      connectQqGateway(config, {
        onMessageEvent: async (eventType, data) => {
          const result = await handleEvent(eventType, data);
          log({ event: "qq-message-handled", connectionId: record.id, ...result });
        },
        onStatus: (status, detail) => {
          if (status === "ready") {
            prisma.platformConnection.update({ where: { id: record.id }, data: { status: "CONNECTED" } }).catch(() => undefined);
            log({ event: "qq-connected", connectionId: record.id, appId: record.appId });
          } else if (status === "error" || status === "disconnected") {
            if (status === "error") {
              prisma.platformConnection.update({ where: { id: record.id }, data: { status: "ERROR" } }).catch(() => undefined);
            }
            log({ event: "qq-" + status, connectionId: record.id, detail: detail ?? "" });
          }
        },
        onClose: () => resolveLoop(),
      }).then((close) => {
        activeCloses.add(close);
      }).catch(() => resolveLoop());
    });
    if (!running) break;
    await sleep(3000);
  }
}

const records = await loadQqConnections();
if (records.length === 0) {
  log({ event: "qq-no-connections", hint: "请先在「渠道管理」创建 QQ 机器人连接并绑定角色。" });
}
await Promise.all(records.map(serveConnection));
await prisma.$disconnect();
