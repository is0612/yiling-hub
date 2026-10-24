/**
 * bili CLI 执行器 —— 从 bili-desk 的 runner.py / subproc.py / netenv.py 迁移而来。
 *
 * 一次调用 = 一个 `bili <argv...>` 子进程 + 一段 stdout（尝试解析为 JSON）。
 * Node 后端用 child_process.spawn 调用，跨平台处理：
 *   - Windows 上隐藏控制台窗口（对应 bili-desk 的 CREATE_NO_WINDOW / SW_HIDE）。
 *   - 探测代理端口，连不上就摘掉代理变量改直连（对应 netenv.py，避免 ProxyError 502）。
 */

import { spawn } from "node:child_process";
import { createConnection } from "node:net";

export type BiliRunResult = {
  code: number | null;
  json: unknown;
  stdout: string;
  stderr: string;
  elapsed: number;
  argv: string[];
  timedOut: boolean;
};

export type BiliRunOptions = {
  /** 超时毫秒，默认 240 秒。 */
  timeoutMs?: number;
  /** 工作目录。 */
  cwd?: string;
  /** 追加的环境变量。 */
  env?: Record<string, string>;
  /** bili 可执行文件路径；缺省从环境变量 BILI_BIN 或 PATH 里找。 */
  bin?: string;
};

const DEFAULT_TIMEOUT_MS = 240_000;

function resolveBiliBin(): string {
  return process.env.BILI_BIN?.trim() || "bili";
}

// ---------------------------------------------------------------------------
// 代理处理：机器上残留了死代理时，bili 子进程会撞上 ProxyError 502。
// 起子进程前探一下代理端口，连不上就摘掉 http_proxy / https_proxy / all_proxy。
// ---------------------------------------------------------------------------

const PROXY_KEYS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

function hostPort(value: string): { host: string; port: number } | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  let withScheme = raw;
  if (!withScheme.includes("://")) withScheme = "http://" + withScheme;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { host: u.hostname, port };
}

function proxyAlive(value: string): Promise<boolean> {
  const hp = hostPort(value);
  if (!hp) return Promise.resolve(false);
  // 简单 TCP 连通性探测（对应 netenv.py 的 socket.create_connection 探测）。
  return new Promise((resolve) => {
    const sock = createConnection({ host: hp.host, port: hp.port, timeout: 400 });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function childEnv(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PYTHONIOENCODING = "utf-8";
  for (const key of PROXY_KEYS) {
    const val = env[key];
    if (val && !(await proxyAlive(val))) {
      delete env[key];
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v) env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// 主执行函数
// ---------------------------------------------------------------------------

export async function runBili(argv: string[], options: BiliRunOptions = {}): Promise<BiliRunResult> {
  const started = Date.now();
  const bin = options.bin?.trim() || resolveBiliBin();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!argv || argv.length === 0) {
    return { code: 2, json: null, stdout: "", stderr: "空命令", elapsed: 0, argv: [], timedOut: false };
  }

  const env = await childEnv(options.env);

  return new Promise<BiliRunResult>((resolve) => {
    const child = spawn(bin, argv, {
      cwd: options.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const notFound = error.code === "ENOENT";
      resolve({
        code: notFound ? 127 : 125,
        json: null,
        stdout,
        stderr: notFound ? `找不到 bili 可执行文件（${bin}）` : String(error.message || error),
        elapsed: Math.round((Date.now() - started) / 10) / 100,
        argv,
        timedOut,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmedOut = stdout.trim();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(trimmedOut);
      } catch {
        parsed = null;
      }
      resolve({
        code,
        json: parsed,
        stdout: trimmedOut.slice(-20_000),
        stderr: stderr.trim().slice(-4_000),
        elapsed: Math.round((Date.now() - started) / 10) / 100,
        argv,
        timedOut,
      });
    });
  });
}

/** 只返回 bili 输出的 JSON 部分（等价 bili-desk 的 bili_json）。 */
export async function biliJson(argv: string[], options: BiliRunOptions = {}): Promise<unknown> {
  const result = await runBili(argv, { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
  return result.json;
}

// 导出用于测试
export { resolveBiliBin };
