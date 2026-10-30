import fs from "node:fs/promises";
import path from "node:path";
import { loadOnebotConnections } from "./configure";
import { portFromUrl, provisionOnebotNodes } from "./panel";
import {
  launchOnebotAdapter,
  launchSnowluma,
  probeTcp,
  readOnebotAdapterStatus,
  readSnowlumaStatus,
} from "./runtime";

/**
 * 「装了就该在跑」。
 *
 * 别人的鱼是宿主里的插件：宿主启动时把它加载进来，宿主活着它就活着，用户从来不用管进程。
 * 我们是两个独立进程（协议端 + 适配器），以前只能靠人点「启动」。这个模块把那一步补上 ——
 * server 起来、或者打开 QQ 渠道页时，发现链路没通就自己补一遍。
 *
 * 但有一个必须留的口子：**人点了「停止」就得是真停**。
 * 自动补起最难受的形态是「我明明关了它又自己回来」。所以停止会落一个开关文件，
 * 之后不管重启 server 还是刷新页面都不再自动补，直到人重新点启动/重连。
 */

/** 自动补起的总开关：点过「停止」就写它 */
function pauseFile(): string {
  return path.join(process.cwd(), ".data", "onebot-autostart.json");
}

export async function readAutoStartPause(): Promise<{ paused: boolean; at?: string }> {
  try {
    const raw = await fs.readFile(pauseFile(), "utf8");
    const parsed = JSON.parse(raw) as { paused?: unknown; at?: unknown };
    return {
      paused: parsed.paused === true,
      at: typeof parsed.at === "string" ? parsed.at : undefined,
    };
  } catch {
    // 没有这个文件 = 没停过 = 可以补
    return { paused: false };
  }
}

/**
 * 记下「人是想让它跑，还是想让它停」。
 *
 * 单独一个文件而不是塞进数据库：它描述的是**这台机器上这两个进程**的状态，
 * 换台机器、换个数据库都该重新判断，不该跟着环境走。
 */
export async function setAutoStartPaused(paused: boolean): Promise<void> {
  try {
    await fs.mkdir(path.dirname(pauseFile()), { recursive: true });
    const payload = paused ? { paused: true, at: new Date().toISOString() } : { paused: false };
    await fs.writeFile(pauseFile(), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // 写不进去只影响「下次还会不会自动补」，不该让停止/启动本身失败
  }
}

export type EnsureResult = {
  /** already-running=本来就在跑；started=补了；partial=补了一半；skipped=不该补 */
  action: "already-running" | "started" | "partial" | "skipped";
  reason?: string;
  steps: string[];
  message: string;
};

/**
 * 读「主连接」，读不到就退几步再试。
 *
 * 这个函数大概率是在 server 刚起来的那一秒被调用的 —— 那时 prisma 的连接池可能还没热，
 * 第一次查询会直接抛错。抛错和「表里没有连接」是两件事：前者该重试，后者才是真的没配。
 * 以前一律 `.catch(() => [])`，结果就是启动时静默退化成「没有可补的连接」，自动补起看着像没生效。
 */
async function loadPrimaryConnection(): Promise<
  { ok: true; connection: Awaited<ReturnType<typeof loadOnebotConnections>>[number] | null } | { ok: false; message: string }
> {
  let lastMessage = "读不到渠道连接。";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const connections = await loadOnebotConnections();
      return { ok: true, connection: connections[0] ?? null };
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }
  return { ok: false, message: lastMessage };
}

/**
 * 补起的轨迹落在 `.data/onebot-autostart.log`。
 *
 * 要它而不是只靠终端输出，是因为「自动补起没生效」最难判定的恰是「它到底有没有试过」——
 * 没起来、起来了又被杀、根本没跑，三种情况在页面上长得一模一样。留一条带时间的记录，
 * 事后能直接分辨。
 */
async function trace(action: string, message: string): Promise<void> {
  try {
    const line = `${new Date().toISOString()} ${action} ${message}\n`;
    await fs.appendFile(path.join(process.cwd(), ".data", "onebot-autostart.log"), line, "utf8");
  } catch {
    // 记不下来不影响补起本身
  }
}

/** 同一时刻只允许一次补齐：server 启动和页面打开可能同时触发，不能让两边各起一套进程 */
let inFlight: Promise<EnsureResult> | null = null;

export function ensureOnebotStack(): Promise<EnsureResult> {
  if (inFlight) return inFlight;
  inFlight = runEnsure()
    .then((result) => {
      void trace(result.action, result.message);
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function waitForPanel(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp("127.0.0.1", port, 800)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return false;
}

/**
 * 补齐整条链路，顺序和页面上的「重连」一致：协议端 → 节点 → 适配器。
 *
 * 只补缺的那一段：SnowLuma 在跑就不动它（重启一次要等 40 秒，白白让鱼掉线），
 * 适配器在跑就不重开（新进程会重新建 WS，等于白白断一次）。
 */
async function runEnsure(): Promise<EnsureResult> {
  const steps: string[] = [];

  const pause = await readAutoStartPause();
  if (pause.paused) {
    return {
      action: "skipped",
      reason: "paused",
      steps,
      message: "之前点过停止，这次不自动补 —— 需要时点「重连」。",
    };
  }

  const loaded = await loadPrimaryConnection();
  if (!loaded.ok) {
    return {
      action: "skipped",
      reason: "db-unavailable",
      steps,
      message: `读不到渠道连接，这次不补：${loaded.message}`,
    };
  }
  const primary = loaded.connection;
  if (!primary) {
    return { action: "skipped", reason: "no-connection", steps, message: "还没有接进来的 QQ 小号，不用补。" };
  }

  const [snowlumaBefore, adapterBefore] = await Promise.all([
    readSnowlumaStatus(),
    readOnebotAdapterStatus(),
  ]);

  if (snowlumaBefore.running && adapterBefore.running) {
    return { action: "already-running", steps, message: "链路本来就在跑。" };
  }

  // ① 协议端。没装就别假装能补 —— 那是「去第 2 步填目录」的事，不是自动化能解决的。
  if (!snowlumaBefore.installed) {
    return {
      action: "skipped",
      reason: "not-installed",
      steps,
      message: `没找到 SnowLuma（找的是 ${snowlumaBefore.home}），补不了。`,
    };
  }

  if (!snowlumaBefore.running) {
    steps.push("启动 SnowLuma");
    const launched = await launchSnowluma();
    if (!launched.ok) {
      return { action: "partial", reason: "gateway-launch-failed", steps, message: launched.message ?? "SnowLuma 启动失败。" };
    }
    if (!(await waitForPanel(snowlumaBefore.panelPort, 40_000))) {
      // 它挂在 QQ 客户端上，客户端没登录时就是这个结果 —— 这不是「重试能好」的故障
      return {
        action: "partial",
        reason: "gateway-timeout",
        steps,
        message: "SnowLuma 40 秒内没应答面板，先确认 QQ 已经登录。",
      };
    }
  }

  // ② 节点。补不上不拦着 —— 适配器起来了页面也会显示「节点没开」，比彻底不动强。
  const snowlumaNow = await readSnowlumaStatus();
  if (snowlumaNow.running && primary.accountQq) {
    const provision = await provisionOnebotNodes({
      password: primary.snowlumaPassword,
      uin: primary.accountQq,
      wsUrl: primary.config.wsUrl,
      httpUrl: primary.config.httpUrl,
      wsToken: primary.config.accessToken ?? "",
      httpToken: primary.config.httpToken ?? "",
      wsPortFallback: 3001,
      httpPortFallback: 3002,
      panelPort: snowlumaNow.panelPort,
    }).catch(() => null);

    if (provision?.ok) {
      // 只在真的改过东西时才记一笔，否则每次启动都刷一行噪声
      if (provision.changes.length) steps.push(`对齐节点：${provision.changes.join("；")}`);
    } else if (provision) {
      steps.push(`节点没对齐：${provision.message}`);
    }
  }

  // ③ 适配器
  const adapterNow = await readOnebotAdapterStatus();
  if (!adapterNow.running) {
    steps.push("启动适配器");
    const launched = await launchOnebotAdapter();
    if (!launched.ok) {
      return { action: "partial", reason: "adapter-launch-failed", steps, message: launched.message ?? "适配器启动失败。" };
    }
  }

  const ports = {
    ws: portFromUrl(primary.config.wsUrl, 3001),
    http: portFromUrl(primary.config.httpUrl, 3002),
  };

  return {
    action: "started",
    steps,
    message: steps.length ? `已补起链路（${ports.ws}/${ports.http}）。` : "链路已就绪。",
  };
}
