import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createError, getHeader, getRequestURL, type H3Event } from "h3";
import { getPrisma } from "./prisma";

const scrypt = promisify(scryptCallback);

export const SESSION_COOKIE_NAME = "yiling_session";
export const SESSION_TOKEN_BYTES = 32;
export const SESSION_LAST_USED_REFRESH_MS = 5 * 60 * 1000;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FAILURE_LIMIT_PER_USER = 5;
export const LOGIN_FAILURE_LIMIT_PER_IP = 20;
export const LOGIN_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MIN_SESSION_TTL_HOURS = 1;
export const MAX_SESSION_TTL_HOURS = 720;
export const DEFAULT_SESSION_TTL_HOURS = 12;

export type AuthMode = "session" | "local-dev" | "anonymous";

export type AuthenticatedUser = {
  id: string;
  username: string;
  displayName: string | null;
};

export type ActorContext =
  | { mode: "session"; user: AuthenticatedUser }
  | { mode: "local-dev"; user: AuthenticatedUser }
  | { mode: "anonymous"; reason: "missing_session" | "invalid_session" | "disabled_user"; user: null };

// ---------------------------------------------------------------------------
// Password hashing (scrypt; the format matches scripts/seed-dev-user.ts)
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return "scrypt$" + salt.toString("base64url") + "$" + derived.toString("base64url");
}

function parseStoredPasswordHash(storedHash: string): { salt: Buffer; digest: Buffer } | null {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return null;
  const salt = Buffer.from(parts[1] ?? "", "base64url");
  const digest = Buffer.from(parts[2] ?? "", "base64url");
  if (salt.length < 8 || digest.length !== 64) return null;
  return { salt, digest };
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredPasswordHash(storedHash);
  if (!parsed) return false;
  const derived = await scrypt(password, parsed.salt, parsed.digest.length) as Buffer;
  return derived.length === parsed.digest.length && timingSafeEqual(derived, parsed.digest);
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function hashClientAddress(address: string): string {
  return createHash("sha256").update("yiling-ip:" + address, "utf8").digest("hex");
}

export function sessionTtlMs(): number {
  const raw = Number(process.env.AUTH_SESSION_TTL_HOURS ?? DEFAULT_SESSION_TTL_HOURS);
  const hours = Number.isFinite(raw) && raw >= MIN_SESSION_TTL_HOURS && raw <= MAX_SESSION_TTL_HOURS
    ? raw
    : DEFAULT_SESSION_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function isSecureCookieRuntime(): boolean {
  return process.env.NODE_ENV === "production" || process.env.YILING_COOKIE_SECURE === "true";
}

export function buildSessionCookie(token: string, ttlMs: number, secure = isSecureCookieRuntime()): string {
  const attributes = [
    SESSION_COOKIE_NAME + "=" + token,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=" + Math.max(1, Math.floor(ttlMs / 1000)),
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function buildClearSessionCookie(secure = isSecureCookieRuntime()): string {
  const attributes = [SESSION_COOKIE_NAME + "=", "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readSessionToken(event: H3Event): string {
  const header = getHeader(event, "cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return value;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

export function isLoginThrottled(input: {
  userFailures: number;
  ipFailures: number;
  perUserLimit?: number;
  perIpLimit?: number;
}): boolean {
  const perUser = input.perUserLimit ?? LOGIN_FAILURE_LIMIT_PER_USER;
  const perIp = input.perIpLimit ?? LOGIN_FAILURE_LIMIT_PER_IP;
  return input.userFailures >= perUser || input.ipFailures >= perIp;
}

// ---------------------------------------------------------------------------
// Actor resolution
// ---------------------------------------------------------------------------

/**
 * Decides who is acting on a request. A presented-but-invalid session never silently falls back to
 * the local development user: an expired or revoked cookie must be re-authenticated.
 */
export function resolveActor(input: {
  hasSessionCookie: boolean;
  sessionUser: AuthenticatedUser | null;
  localDevUser: AuthenticatedUser | null;
}): ActorContext {
  if (input.hasSessionCookie) {
    return input.sessionUser
      ? { mode: "session", user: input.sessionUser }
      : { mode: "anonymous", reason: "invalid_session", user: null };
  }
  if (input.localDevUser) return { mode: "local-dev", user: input.localDevUser };
  return { mode: "anonymous", reason: "missing_session", user: null };
}

export function isDevOwnerBypassEnabled(): boolean {
  return process.env.YILING_ALLOW_DEV_OWNER_BYPASS !== "false";
}

function isLoopbackRequest(event: H3Event): boolean {
  const hostHeader = (getHeader(event, "host") ?? "").toLowerCase();
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(1, hostHeader.indexOf("]"))
    : (hostHeader.split(":")[0] ?? "");
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

/**
 * The local development owner is a development-only convenience: it requires the dev server,
 * the explicit local API flag, a loopback Host header and the bypass toggle. Production builds
 * never satisfy `import.meta.dev`, so this path cannot exist there.
 */
export function canUseLocalDevOwner(event: H3Event): boolean {
  return Boolean(import.meta.dev)
    && process.env.YILING_LOCAL_API_ENABLED === "true"
    && isDevOwnerBypassEnabled()
    && isLoopbackRequest(event);
}

export async function findLocalDevUser(): Promise<AuthenticatedUser | null> {
  const ownerId = process.env.DEV_OWNER_ID;
  if (!ownerId) return null;
  const user = await getPrisma().user.findUnique({
    where: { id: ownerId },
    select: { id: true, username: true, displayName: true, status: true },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return { id: user.id, username: user.username, displayName: user.displayName };
}

export async function resolveSessionUser(token: string): Promise<AuthenticatedUser | null> {
  const prisma = getPrisma();
  const now = new Date();
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, username: true, displayName: true, status: true } },
    },
  });
  if (!session) return null;
  if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return null;
  if (session.user.status !== "ACTIVE") return null;

  // Touch the session at most every few minutes so a busy client does not write on every request.
  if (now.getTime() - session.lastUsedAt.getTime() > SESSION_LAST_USED_REFRESH_MS) {
    await prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: now } }).catch(() => undefined);
  }
  return { id: session.user.id, username: session.user.username, displayName: session.user.displayName };
}

export async function resolveActorContext(event: H3Event): Promise<ActorContext> {
  const token = readSessionToken(event);
  const sessionUser = token ? await resolveSessionUser(token) : null;
  const localDevUser = !token && canUseLocalDevOwner(event) ? await findLocalDevUser() : null;
  return resolveActor({ hasSessionCookie: Boolean(token), sessionUser, localDevUser });
}

export async function requireActor(event: H3Event): Promise<Extract<ActorContext, { mode: "session" | "local-dev" }>> {
  const actor = await resolveActorContext(event);
  if (actor.mode === "anonymous") {
    if (actor.reason === "invalid_session") {
      throw createError({ statusCode: 401, statusMessage: "登录状态已失效，请重新登录。" });
    }
    throw createError({ statusCode: 401, statusMessage: "请先登录后再访问该接口。" });
  }
  return actor;
}

export async function requireActorUserId(event: H3Event): Promise<string> {
  const actor = await requireActor(event);
  return actor.user.id;
}

// ---------------------------------------------------------------------------
// Session and login-attempt persistence
// ---------------------------------------------------------------------------

export async function createSession(input: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const ttlMs = sessionTtlMs();
  const expiresAt = new Date(Date.now() + ttlMs);
  await getPrisma().session.create({
    data: {
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ipHash: input.ip ? hashClientAddress(input.ip) : null,
      userAgent: input.userAgent ? input.userAgent.slice(0, 255) : null,
    },
    select: { id: true },
  });
  return { token, expiresAt };
}

export async function revokeSessionByToken(token: string): Promise<boolean> {
  if (!token) return false;
  const result = await getPrisma().session.updateMany({
    where: { tokenHash: hashSessionToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count > 0;
}

export async function recordLoginAttempt(input: {
  username: string;
  ip: string;
  succeeded: boolean;
}): Promise<void> {
  const prisma = getPrisma();
  await prisma.loginAttempt.create({
    data: {
      username: input.username.slice(0, 100),
      ipHash: hashClientAddress(input.ip),
      succeeded: input.succeeded,
    },
  });
  if (input.succeeded) {
    // A successful login clears that account's failure history.
    await prisma.loginAttempt.deleteMany({ where: { username: input.username.slice(0, 100), succeeded: false } });
  }
  // Opportunistic retention: keep the table small without a scheduled job.
  await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - LOGIN_ATTEMPT_RETENTION_MS) } },
  }).catch(() => undefined);
}

export async function countRecentLoginFailures(input: {
  username: string;
  ip: string;
}): Promise<{ userFailures: number; ipFailures: number }> {
  const prisma = getPrisma();
  const since = new Date(Date.now() - LOGIN_FAILURE_WINDOW_MS);
  const ipHash = hashClientAddress(input.ip);
  const [userFailures, ipFailures] = await Promise.all([
    prisma.loginAttempt.count({ where: { username: input.username.slice(0, 100), succeeded: false, createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { ipHash, succeeded: false, createdAt: { gte: since } } }),
  ]);
  return { userFailures, ipFailures };
}

export async function revokeExpiredSessions(): Promise<number> {
  const result = await getPrisma().session.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
        { revokedAt: { not: null, lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      ],
    },
  });
  return result.count;
}

export function clientAddressOf(event: H3Event): string {
  // Nuxt/nitro populates this from the socket or the trusted proxy configuration. Never trust a
  // client-supplied X-Forwarded-For unless the deployment explicitly configures a proxy.
  const address = event.node?.req?.socket?.remoteAddress;
  if (address) return address;
  try {
    return getRequestURL(event).hostname;
  } catch {
    return "unknown";
  }
}
