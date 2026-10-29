import { requireAdminActor } from "../../../../utils/auth";
import { loadOnebotConnections } from "../../../../utils/channel-adapter/onebot/configure";
import {
  parseWsEndpoint,
  probeTcp,
  readOnebotAdapterStatus,
  readSnowlumaStatus,
} from "../../../../utils/channel-adapter/onebot/runtime";

/**
 * QQ 渠道这条链路上两个进程的现状：
 *
 * - **SnowLuma**（网关本体）：面板端口在听就算起来了，它和 3001/3002 是同一个进程。
 * - **适配器**（`yarn onebot:run`）：靠它自己写的「我在跑」标记 + pid 探活。
 * - **gateway**：适配器要连的那个 WS 端口通不通 —— 日志里一直刷 `code=1006` 就是它不通。
 *
 * 一次请求把三件事说清楚，省得用户在日志和终端之间来回猜。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const [adapter, snowluma] = await Promise.all([
    readOnebotAdapterStatus(),
    readSnowlumaStatus(),
  ]);

  let gateway: { wsUrl: string; host: string; port: number; reachable: boolean } | null = null;
  try {
    const records = await loadOnebotConnections();
    const record = records[0];
    const endpoint = record ? parseWsEndpoint(record.config.wsUrl) : null;
    if (record && endpoint) {
      gateway = {
        wsUrl: record.config.wsUrl,
        host: endpoint.host,
        port: endpoint.port,
        reachable: await probeTcp(endpoint.host, endpoint.port),
      };
    }
  } catch {
    // 读不到连接配置就不显示网关状态，不影响另外两项
    gateway = null;
  }

  return { adapter, snowluma, gateway };
});
