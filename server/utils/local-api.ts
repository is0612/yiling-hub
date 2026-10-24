import { createError, getHeader } from "h3";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Phase 2 uses an explicitly local-only API while authentication is not ready.
 * Production is denied even if the feature flag is accidentally enabled.
 */
export function requireLocalDevOwner(event: Parameters<typeof getHeader>[0]): string {
  const hostHeader = (getHeader(event, "host") ?? "").toLowerCase();
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : (hostHeader.split(":")[0] ?? "");

  if (
    !import.meta.dev ||
    process.env.YILING_LOCAL_API_ENABLED !== "true" ||
    !["localhost", "127.0.0.1", "::1"].includes(hostname)
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: "该接口仅在启用本地开发模式且通过 localhost 访问时可用。",
    });
  }

  // Loopback Host checks alone do not stop a malicious website from sending browser
  // requests to localhost. Validate browser fetch metadata when the browser supplies it.
  const originHeader = getHeader(event, "origin");
  if (originHeader) {
    let originUrl: URL | null = null;
    try {
      originUrl = new URL(originHeader);
    } catch {
      // Invalid and opaque origins (for example, "null") are not trusted.
    }
    const rawOriginHostname = originUrl?.hostname.toLowerCase() ?? "";
    const originHostname = rawOriginHostname.startsWith("[") && rawOriginHostname.endsWith("]")
      ? rawOriginHostname.slice(1, -1)
      : rawOriginHostname;
    if (
      !originUrl ||
      !["http:", "https:"].includes(originUrl.protocol) ||
      originUrl.host.toLowerCase() !== hostHeader ||
      !["localhost", "127.0.0.1", "::1"].includes(originHostname)
    ) {
      throw createError({ statusCode: 403, statusMessage: "本地开发接口拒绝跨源请求。" });
    }
  }
  const fetchSite = (getHeader(event, "sec-fetch-site") ?? "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw createError({ statusCode: 403, statusMessage: "本地开发接口拒绝跨站请求。" });
  }

  const ownerId = process.env.DEV_OWNER_ID;
  if (!ownerId || !UUID_PATTERN.test(ownerId)) {
    throw createError({
      statusCode: 503,
      statusMessage: "请在 .env 中设置有效的 DEV_OWNER_ID，并运行 npm run db:seed:dev。",
    });
  }

  return ownerId;
}

export function requireUuid(value: string, label = "资源 ID"): string {
  if (!UUID_PATTERN.test(value)) {
    throw createError({ statusCode: 404, statusMessage: `${label}不存在。` });
  }
  return value;
}

export function readTrimmedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { required?: boolean } = {},
): string {
  if (typeof value !== "string") {
    if (options.required) {
      throw createError({ statusCode: 400, statusMessage: `${label}不能为空。` });
    }
    return "";
  }

  const trimmed = value.trim();
  if (options.required && !trimmed) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能为空。` });
  }
  if (trimmed.length > maxLength) {
    throw createError({ statusCode: 400, statusMessage: `${label}不能超过 ${maxLength} 个字符。` });
  }
  return trimmed;
}
