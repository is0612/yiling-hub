import { execFile, spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { getPrisma } from "../../prisma";

/** Acknowledge the request served by this ready socket without replacing concurrent metadata. */
export async function markOnebotReloadApplied(connectionId: string, requestedAt: string): Promise<void> {
  await getPrisma().$executeRaw`
    UPDATE platform_connections
    SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('onebotReloadAppliedAt', ${requestedAt}::text)
    WHERE id = ${connectionId}::uuid AND platform = 'qq-onebot'
  `;
}

/**
 * 适配器进程的「我在跑」标记，与 scripts/run-onebot-adapter.ts 里写的那个文件同一个。
 *
 * 网页上的「启动适配器」只能到这里为止：它不去 kill、不去 supervise，
 * 只负责把终端拉起来，然后把 pid 记下来，好让人知道起没起来、要不要再点一次。
 */
export type OnebotAdapterStatus = {
  running: boolean;
  pid?: number;
  startedAt?: string;
};

function adapterStateFile(): string {
  return path.join(process.cwd(), ".data", "onebot-adapter.json");
}

export async function readOnebotAdapterStatus(): Promise<OnebotAdapterStatus> {
  try {
    const raw = await fs.readFile(adapterStateFile(), "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
    const pid = Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) return { running: false };
    try {
      // 只探活，不真的发信号；进程没了会抛 ESRCH
      process.kill(pid, 0);
    } catch {
      return { running: false };
    }
    return {
      running: true,
      pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
    };
  } catch {
    return { running: false };
  }
}

/**
 * 在项目根目录开一个命令行窗口跑 `yarn onebot:run`。
 *
 * 用独立控制台（detached）而不是挂在 nuxt 底下：dev server 每次热重启都会带走子进程，
 * 而适配器是要长期跑的。窗口里能看到 onebot-connected 这类日志，关掉窗口就是停。
 * 命令是写死的，不接受任何外部输入。
 */
export async function launchOnebotAdapter(): Promise<{ ok: boolean; pid?: number; message?: string }> {
  if (process.platform !== "win32") {
    return { ok: false, message: "自动开终端只做了 Windows 版，请手动在项目根目录运行 yarn onebot:run。" };
  }
  try {
    const child = spawn("cmd.exe", ["/k", "yarn", "onebot:run"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "启动终端失败，请手动运行 yarn onebot:run。",
    };
  }
}

/**
 * TCP 探活：网关那个端口有没有人在听。
 *
 * 适配器日志里一直刷 `code=1006` 就是这个问题的表现 —— 1006 只说明「连接被异常关闭」，
 * 看不出是网关没启动还是 token 填错。页面直接把「端口有没有人接」摆出来，省一轮猜。
 */
export function probeTcp(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** 从 ws://127.0.0.1:3001 里拆出 host/port；解析不了就返回 null（那说明地址本身填错了） */
export function parseWsEndpoint(wsUrl: string): { host: string; port: number } | null {
  try {
    const url = new URL(wsUrl);
    const port = url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

// ── SnowLuma（网关本体）──────────────────────────────────
/**
 * SnowLuma 装在哪。**能不让人填就不让人填**，所以这里是一条发现链：
 *
 * 1. 页面里存过的目录（`.data/snowluma-home.json`）—— 填过就认它
 * 2. 环境变量 `SNOWLUMA_HOME` —— 部署时批量指定，和 bili CLI 的 `BILI_CLI_HOME` 一个套路
 * 3. **反查运行中的进程**：5099 在听 → netstat 拿 pid → PowerShell 拿 exe 路径 → 上一级就是安装目录
 * 4. **扫常见位置**：Downloads / 桌面 / 文档 / Program Files / 各盘根下两层，找带 start.bat 的 SnowLuma 目录
 * 5. 都没有 → 本机默认 `D:\Tools\SnowLuma`（多半是错的，但至少页面上能看到它在找哪儿）
 *
 * 3 最准（它就在跑，路径不可能错），4 覆盖「AI 帮我在下载文件夹解压的」这种。
 * 前两层是显式配置，所以优先于自动发现 —— 用户填过就别自作聪明。
 */
const SNOWLUMA_DEFAULT_HOME = "D:\\Tools\\SnowLuma";
const SNOWLUMA_DEFAULT_PANEL_PORT = 5099;
/** 自动发现的结果缓存 60 秒：页面在轮询，别每次都去 netstat + 扫盘 */
const DISCOVERY_TTL_MS = 60_000;

export type SnowlumaHomeSource = "saved" | "env" | "process" | "scan" | "default";

function snowlumaHomeFile(): string {
  return path.join(process.cwd(), ".data", "snowluma-home.json");
}

async function hasStartBat(home: string): Promise<boolean> {
  try {
    await fs.access(path.join(home, "start.bat"));
    return true;
  } catch {
    return false;
  }
}

async function readSavedHome(): Promise<string | null> {
  try {
    const raw = await fs.readFile(snowlumaHomeFile(), "utf8");
    const parsed = JSON.parse(raw) as { home?: unknown };
    if (typeof parsed.home === "string" && parsed.home.trim()) {
      return path.resolve(parsed.home.trim());
    }
  } catch {
    // 没存过（或存坏了）就往下一层退
  }
  return null;
}

/** 跑一个命令把 stdout 抓回来；失败一律当空串，发现失败不该把整个状态接口带崩 */
function runCapture(file: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : String(stdout ?? "")),
    );
  });
}

/** 谁在听这个端口。只认 LISTENING，`TCP 127.0.0.1:5099 ... LISTENING 1234` 取最后一列 */
async function listeningPids(port: number): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const out = await runCapture("netstat", ["-ano", "-p", "tcp"]);
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (!String(cols[1] ?? "").endsWith(`:${port}`)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * pid 的可执行文件在哪 —— 就是安装目录。
 *
 * SnowLuma 的 start.bat 用的是发行包自带的 `node.exe`，所以 exe 的 dirname 正好是它的根；
 * 万一不是（比如用系统 node 跑的），再往上找三层，哪层有 start.bat 就是哪层。
 * pid 先校验成整数再拼命令，避免任何注入。
 */
async function homeFromPid(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const out = (
    await runCapture("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`,
    ])
  ).trim();
  if (!out) return null;
  let dir = path.dirname(out);
  for (let depth = 0; depth < 4; depth += 1) {
    if (await hasStartBat(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function homeFromRunningProcess(port: number): Promise<string | null> {
  for (const pid of await listeningPids(port)) {
    const home = await homeFromPid(pid);
    if (home) return home;
  }
  return null;
}

/** 候选盘符：C 到 H，存在的才算 */
async function driveRoots(): Promise<string[]> {
  if (process.platform !== "win32") return ["/"];
  const roots: string[] = [];
  for (const letter of "CDEFGH") {
    const root = `${letter}:\\`;
    try {
      await fs.access(root);
      roots.push(root);
    } catch {
      // 没这个盘
    }
  }
  return roots;
}

/**
 * 在 dir 下面找「有 start.bat 且名字像 SnowLuma」的目录。
 *
 * `strict` 时不进名字不含 snowluma 的子目录 —— 扫 Downloads 不会一头扎进几百个无关文件夹；
 * 放宽时（第二遍）什么目录都进，但**名字像的先试**：`D:\Tools` 下几十个目录、SnowLuma 字母序靠后，
 * 不排序的话预算会被前面的目录吃光，还没轮到它就返回 null 了（真踩过）。
 */
async function findSnowlumaUnder(
  dir: string,
  depth: number,
  budget: { left: number },
  strict: boolean,
  deadline: number,
): Promise<string | null> {
  if (budget.left <= 0 || Date.now() > deadline) return null;
  budget.left -= 1;
  if (/snowluma/i.test(path.basename(dir)) && (await hasStartBat(dir))) return dir;
  if (depth <= 0) return null;

  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (!strict) {
    // 稳定的「像的排前面」：SnowLuma / SnowLuma-win-x64 / snowluma-v1.2
    dirs.sort((a, b) => Number(/snowluma/i.test(b.name)) - Number(/snowluma/i.test(a.name)));
  }
  for (const entry of dirs) {
    if (strict && !/snowluma/i.test(entry.name)) continue;
    const found = await findSnowlumaUnder(path.join(dir, entry.name), depth - 1, budget, strict, deadline);
    if (found) return found;
  }
  return null;
}

/** 导出只为排查：页面显示「没找到程序」时跑 `npx tsx scripts/probe-snowluma-home.ts` 看扫到哪了 */
export async function scanForSnowluma(): Promise<string | null> {
  const home = os.homedir();
  const roots = [
    path.join(home, "Downloads"),
    path.join(home, "Desktop"),
    path.join(home, "Documents"),
    path.join(home, "AppData", "Local", "Programs"),
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    ...(await driveRoots()),
  ];

  // 第一遍：只钻名字带 snowluma 的目录（绝大多数情况，几毫秒）
  const strictDeadline = Date.now() + 800;
  for (const root of roots) {
    const found = await findSnowlumaUnder(root, 3, { left: 80 }, true, strictDeadline);
    if (found) return found;
  }
  // 第二遍：允许外层是任意名字的包装（「新建文件夹」之类）。
  // 每个根一份独立预算 + 总时限兜底 —— 共享预算的话，一个塞满子目录的下载夹就能把后面所有盘的机会吃光。
  const looseDeadline = Date.now() + 1500;
  for (const root of roots) {
    const found = await findSnowlumaUnder(root, 2, { left: 200 }, false, looseDeadline);
    if (found) return found;
  }
  return null;
}

let processDiscovery: { home: string; at: number } | null = null;
let scanDiscovery: { home: string; at: number } | null = null;

/** 反查结果缓存 60 秒：页面在轮询，别每次都 netstat + powershell 一遍 */
async function homeFromRunningProcessCached(port: number): Promise<string | null> {
  if (processDiscovery && Date.now() - processDiscovery.at < DISCOVERY_TTL_MS) return processDiscovery.home;
  const home = await homeFromRunningProcess(port);
  if (home) processDiscovery = { home, at: Date.now() };
  return home;
}

async function scanForSnowlumaCached(): Promise<string | null> {
  if (scanDiscovery && Date.now() - scanDiscovery.at < DISCOVERY_TTL_MS) return scanDiscovery.home;
  const home = await scanForSnowluma();
  if (home) scanDiscovery = { home, at: Date.now() };
  return home;
}

/** 清掉发现缓存：用户改了目录之后，下一次要重新认 */
export function forgetSnowlumaDiscovery(): void {
  processDiscovery = null;
  scanDiscovery = null;
}

/**
 * 定下这次用哪个目录。顺序里有个刻意的取舍：
 *
 * - 显式的（页面存过 / 环境变量）只认「里面真有 start.bat」的，填错不该把后面的路堵死；
 * - **正在跑的进程排在默认路径前面** —— 它就在跑，路径不可能是错的，而 `D:\Tools\SnowLuma`
 *   可能只是上一台机器留下的空壳；
 * - 默认路径又排在扫盘前面 —— 命中时一次 access 就够，不用去翻盘。
 */
async function resolveSnowlumaHome(
  panelPort = SNOWLUMA_DEFAULT_PANEL_PORT,
): Promise<{ home: string; source: SnowlumaHomeSource }> {
  const saved = await readSavedHome();
  if (saved && (await hasStartBat(saved))) return { home: saved, source: "saved" };

  const env = process.env.SNOWLUMA_HOME?.trim();
  const envHome = env ? path.resolve(env) : null;
  if (envHome && (await hasStartBat(envHome))) return { home: envHome, source: "env" };

  const fromProcess = await homeFromRunningProcessCached(panelPort);
  if (fromProcess) return { home: fromProcess, source: "process" };

  if (await hasStartBat(SNOWLUMA_DEFAULT_HOME)) return { home: SNOWLUMA_DEFAULT_HOME, source: "default" };

  const fromScan = await scanForSnowlumaCached();
  if (fromScan) return { home: fromScan, source: "scan" };

  // 一个都没找到：把「最后说的那个位置」回显出来，让用户知道我们在找哪儿
  return { home: saved ?? envHome ?? SNOWLUMA_DEFAULT_HOME, source: "default" };
}

/** 保存页面里填的目录。只收「里面真有 start.bat」的目录，免得存进一个错路径还看不出来。 */
export async function saveSnowlumaHome(input: string): Promise<{ ok: boolean; home?: string; message?: string }> {
  const trimmed = input.trim().replace(/^"|"$/g, "");
  if (!trimmed) return { ok: false, message: "目录不能为空。" };
  const home = path.resolve(trimmed);
  if (!(await hasStartBat(home))) {
    return {
      ok: false,
      message: `${home} 里没有 start.bat。填解压后直接看到 start.bat 的那一层，别填上一级。`,
    };
  }
  await fs.mkdir(path.dirname(snowlumaHomeFile()), { recursive: true });
  await fs.writeFile(snowlumaHomeFile(), `${JSON.stringify({ home }, null, 2)}\n`, "utf8");
  forgetSnowlumaDiscovery();
  return { ok: true, home };
}

export type SnowlumaStatus = {
  home: string;
  /** 这个目录是怎么来的，页面据此决定要不要标「自动找到」 */
  source: SnowlumaHomeSource;
  /** start.bat 在不在（找不到就别假装能启动） */
  installed: boolean;
  running: boolean;
  panelPort: number;
};

/** 面板端口以它自己的 config/runtime.json 为准，读不到就用 5099 */
async function snowlumaPanelPort(home: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(home, "config", "runtime.json"), "utf8");
    const parsed = JSON.parse(raw) as { webuiPort?: unknown };
    const port = Number(parsed.webuiPort);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    // 首次安装还没有配置文件，走默认端口
  }
  return SNOWLUMA_DEFAULT_PANEL_PORT;
}

export async function readSnowlumaStatus(): Promise<SnowlumaStatus> {
  // 先按默认端口定目录（自动发现要拿它反查进程），定下来再读它自己的真实端口
  const { home, source } = await resolveSnowlumaHome(SNOWLUMA_DEFAULT_PANEL_PORT);
  const installed = await hasStartBat(home);
  const panelPort = await snowlumaPanelPort(home);
  // 面板端口在听 = SnowLuma 起来了（它和 3001/3002 同一个进程）
  const running = installed ? await probeTcp("127.0.0.1", panelPort) : false;
  return { home, source, installed, running, panelPort };
}

/**
 * 启动 SnowLuma：在它自己的目录里开一个命令行窗口跑 start.bat。
 *
 * 用它自带的 start.bat 而不是直接 node index.mjs —— 那个脚本里做了版本闸门
 * （官方入口调 PATH 里的 node，本机 v22 会被挡；start.bat 用发行包自带的 node.exe）。
 * 同样 detached：nuxt 重启不影响它，关掉窗口就是停。
 */
export async function launchSnowluma(): Promise<{ ok: boolean; pid?: number; message?: string }> {
  if (process.platform !== "win32") {
    return { ok: false, message: "自动启动只做了 Windows 版，请手动双击 SnowLuma 的 start.bat。" };
  }
  const { home } = await resolveSnowlumaHome();
  if (!(await hasStartBat(home))) {
    return {
      ok: false,
      message: `在 ${home} 没找到 start.bat，常见位置也扫过了。把 SnowLuma 解压后直接看到 start.bat 的那一层填进「换目录」。`,
    };
  }
  try {
    const child = spawn("cmd.exe", ["/c", "start.bat"], {
      cwd: home,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "启动 SnowLuma 失败，请手动双击 start.bat。",
    };
  }
}
