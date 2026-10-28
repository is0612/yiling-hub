import "dotenv/config";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { superviseOnebotConnection } from "../server/utils/channel-adapter/onebot/supervise";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

function log(entry: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

async function main() {
  const records = await loadOnebotConnections();
  if (records.length === 0) {
    log({ event: "onebot-no-connections", hint: "请先在「系统管理 → QQ 渠道」添加 QQ 小号连接并绑定角色。" });
  }

  await Promise.all(
    records.map((record) =>
      superviseOnebotConnection({
        record,
        handleEvent: createOnebotMessageHandler(record),
        log,
        shouldStop: () => !running,
        onStatusChange: (status) => {
          const next = status === "ready" ? "CONNECTED" : "ERROR";
          prisma.platformConnection
            .update({ where: { id: record.id }, data: { status: next } })
            .catch(() => undefined);
        },
      }),
    ),
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("QQ 小号（OneBot）适配器启动失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
