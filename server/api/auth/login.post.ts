import { createError, getHeader, readBody, setHeader } from "h3";
import {
  buildSessionCookie,
  clientAddressOf,
  countRecentLoginFailures,
  createSession,
  isLoginThrottled,
  recordLoginAttempt,
  revokeExpiredSessions,
  sessionTtlMs,
  verifyPassword,
} from "../../utils/auth";
import { readTrimmedString } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

// Verified against this constant when the account does not exist, so a missing user and a wrong
// password take comparable time and cannot be told apart by latency.
const DUMMY_PASSWORD_HASH = "scrypt$1NXKk3kzK9HVvczz_d_I4Q$NrOGKeahE3B0LhCEErUpuOa1gMif9MMfKSeN_8hw5DKBSkgAJb7TtwsVvtF3VCll9RUGfpUp6KK1saQ_w-0wug";

export default defineEventHandler(async (event) => {
  const body = await readBody<Record<string, unknown>>(event);
  const username = readTrimmedString(body?.username, "用户名", 100, { required: true });
  if (typeof body?.password !== "string" || body.password.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "密码不能为空。" });
  }
  if (body.password.length > 4096) {
    throw createError({ statusCode: 400, statusMessage: "密码长度超出限制。" });
  }

  const ip = clientAddressOf(event);
  const failures = await countRecentLoginFailures({ username, ip });
  if (isLoginThrottled(failures)) {
    throw createError({ statusCode: 429, statusMessage: "登录尝试过于频繁，请稍后再试。" });
  }

  const prisma = getPrisma();
  const account = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, displayName: true, status: true, passwordHash: true },
  });
  const passwordMatches = await verifyPassword(body.password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  const authenticated = Boolean(account) && passwordMatches && account?.status === "ACTIVE";

  await recordLoginAttempt({ username, ip, succeeded: authenticated });

  if (!authenticated || !account) {
    throw createError({ statusCode: 401, statusMessage: "用户名或密码不正确。" });
  }

  const session = await createSession({
    userId: account.id,
    ip,
    userAgent: getHeader(event, "user-agent") ?? undefined,
  });
  setHeader(event, "set-cookie", buildSessionCookie(session.token, sessionTtlMs()));
  await revokeExpiredSessions().catch(() => undefined);

  return {
    user: { id: account.id, username: account.username, displayName: account.displayName },
    expiresAt: session.expiresAt.toISOString(),
  };
});
