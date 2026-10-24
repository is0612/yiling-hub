import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  countRecentLoginFailures,
  createSession,
  hashClientAddress,
  hashPassword,
  hashSessionToken,
  recordLoginAttempt,
  resolveSessionUser,
  revokeExpiredSessions,
  revokeSessionByToken,
} from "../server/utils/auth";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，认证数据库测试无法运行。");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = randomUUID();
const username = `auth-test-${suffix}`;
const bruteForceName = `auth-bruteforce-${suffix}`;
const ip = "127.0.0.1";
let userId = "";

try {
  const user = await prisma.user.create({
    data: { username, passwordHash: await hashPassword("integration-test-password"), displayName: "认证测试" },
    select: { id: true },
  });
  userId = user.id;

  // 1. A created session resolves back to its user.
  const session = await createSession({ userId, ip, userAgent: "auth-db-test" });
  const resolved = await resolveSessionUser(session.token);
  assert.equal(resolved?.id, userId, "A freshly created session must resolve to its user.");
  assert.equal(await resolveSessionUser("not-a-real-token"), null, "Unknown tokens must not resolve.");

  // 2. Only the hashed token is stored.
  const storedSession = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(session.token) },
    select: { tokenHash: true },
  });
  assert(storedSession && storedSession.tokenHash !== session.token, "The database must not store the raw session token.");
  assert.equal(storedSession?.tokenHash, hashSessionToken(session.token));

  // 3. Expired sessions stop resolving.
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(session.token) },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(await resolveSessionUser(session.token), null, "Expired sessions must not authenticate.");

  // 4. Active sessions refresh lastUsedAt when it is stale, and revocation is one-way.
  const second = await createSession({ userId, ip });
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(second.token) },
    data: { lastUsedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
  assert.equal((await resolveSessionUser(second.token))?.id, userId);
  const touched = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(second.token) },
    select: { lastUsedAt: true },
  });
  assert(touched && Date.now() - touched.lastUsedAt.getTime() < 60_000, "A stale session should have lastUsedAt refreshed.");
  assert.equal(await revokeSessionByToken(second.token), true, "Revoking an active session must report a change.");
  assert.equal(await resolveSessionUser(second.token), null, "Revoked sessions must not authenticate.");
  assert.equal(await revokeSessionByToken(second.token), false, "Revoking twice must not report a second change.");

  // 5. Disabled accounts cannot authenticate even with a valid session.
  const third = await createSession({ userId, ip });
  await prisma.user.update({ where: { id: userId }, data: { status: "DISABLED" } });
  assert.equal(await resolveSessionUser(third.token), null, "Disabled users must not authenticate.");
  await prisma.user.update({ where: { id: userId }, data: { status: "ACTIVE" } });
  assert.equal((await resolveSessionUser(third.token))?.id, userId, "Re-enabling the account restores existing sessions.");

  // 6. Expired session cleanup removes only old rows.
  const stale = await createSession({ userId, ip });
  await prisma.session.update({
    where: { tokenHash: hashSessionToken(stale.token) },
    data: { expiresAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
  });
  const removed = await revokeExpiredSessions();
  assert(removed >= 1, "Cleanup must delete sessions expired long ago.");
  assert.equal((await resolveSessionUser(third.token))?.id, userId, "Cleanup must keep sessions that are still valid.");

  // 7. Login throttling counters come from the database.
  const before = await countRecentLoginFailures({ username: bruteForceName, ip });
  assert.equal(before.userFailures, 0);
  await recordLoginAttempt({ username: bruteForceName, ip, succeeded: false });
  await recordLoginAttempt({ username: bruteForceName, ip, succeeded: false });
  const afterFailures = await countRecentLoginFailures({ username: bruteForceName, ip });
  assert.equal(afterFailures.userFailures, 2, "Failed attempts must be counted per username.");
  assert(afterFailures.ipFailures >= 2, "Failed attempts must also be counted per client address.");
  await recordLoginAttempt({ username: bruteForceName, ip, succeeded: true });
  const afterSuccess = await countRecentLoginFailures({ username: bruteForceName, ip });
  assert.equal(afterSuccess.userFailures, 0, "A successful login clears that account's failure history.");

  // 8. The stored client address is a hash, never the raw IP.
  const attempt = await prisma.loginAttempt.findFirst({ where: { username: bruteForceName }, select: { ipHash: true } });
  assert(attempt && attempt.ipHash === hashClientAddress(ip), "Login attempts must store a hashed client address.");
  assert.notEqual(attempt?.ipHash, ip, "The raw client address must not be stored.");

  console.log("Auth DB integration passed: session issue/resolve/expiry/revocation, disabled-user rejection, stale-session cleanup, hashed token and address storage, and database-backed login throttling counters.");
} finally {
  await prisma.session.deleteMany({ where: userId ? { userId } : { tokenHash: "none" } });
  await prisma.loginAttempt.deleteMany({ where: { username: { in: [username, bruteForceName] } } });
  if (userId) {
    await prisma.auditLog.deleteMany({ where: { actorId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
}
