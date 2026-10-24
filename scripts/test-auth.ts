import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSessionToken,
  DEFAULT_SESSION_TTL_HOURS,
  hashPassword,
  hashSessionToken,
  isLoginThrottled,
  resolveActor,
  sessionTtlMs,
  verifyPassword,
} from "../server/utils/auth";
import { checkSameOrigin } from "../server/utils/local-api";

const user = { id: "11111111-1111-4111-8111-111111111111", username: "admin", displayName: "管理员" };

// 1. Password hashing round-trips and rejects wrong input.
const stored = await hashPassword("correct horse battery staple");
assert(stored.startsWith("scrypt$"), "New hashes must use the scrypt format.");
assert.equal(await verifyPassword("correct horse battery staple", stored), true);
assert.equal(await verifyPassword("wrong password", stored), false);
assert.equal(await verifyPassword("correct horse battery staple", "not-a-hash"), false);
assert.equal(await verifyPassword("correct horse battery staple", "scrypt$short$a"), false);
assert.equal(await verifyPassword("", stored), false);

// 2. Hashes produced by scripts/seed-dev-user.ts remain verifiable.
const seedSalt = randomBytes(16);
const seedHash = `scrypt$${seedSalt.toString("base64url")}$${scryptSync("local-dev-password", seedSalt, 64).toString("base64url")}`;
assert.equal(await verifyPassword("local-dev-password", seedHash), true, "Seed-script hashes must keep working.");
assert.equal(await verifyPassword("local-dev-passwore", seedHash), false);

// 3. Session tokens are opaque, unique and stored only as a hash.
const tokens = new Set(Array.from({ length: 50 }, () => createSessionToken()));
assert.equal(tokens.size, 50, "Session tokens must not repeat.");
for (const token of tokens) {
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/, "Session tokens must be base64url strings.");
}
const firstToken = [...tokens][0] ?? "";
assert.equal(hashSessionToken(firstToken), hashSessionToken(firstToken));
assert.match(hashSessionToken(firstToken), /^[0-9a-f]{64}$/, "Stored token hashes must be SHA-256 hex.");
assert.notEqual(hashSessionToken(firstToken), firstToken, "The stored hash must differ from the browser token.");

// 4. Cookie attributes.
const cookie = buildSessionCookie(firstToken, 12 * 60 * 60 * 1000, false);
assert(cookie.includes("yiling_session=" + firstToken));
assert(cookie.includes("HttpOnly"), "Session cookie must be HttpOnly.");
assert(cookie.includes("SameSite=Strict"), "Session cookie must be SameSite=Strict.");
assert(cookie.includes("Path=/"));
assert(cookie.includes("Max-Age=43200"));
assert(!cookie.includes("Secure"), "Local HTTP development must not force Secure.");
assert(buildSessionCookie(firstToken, 60_000, true).includes("Secure"), "Secure must be set when requested.");
const cleared = buildClearSessionCookie(false);
assert(cleared.includes("Max-Age=0") && cleared.includes("yiling_session="), "Logout must expire the cookie.");

// 5. Session TTL is bounded by configuration.
const originalTtl = process.env.AUTH_SESSION_TTL_HOURS;
try {
  process.env.AUTH_SESSION_TTL_HOURS = "30";
  assert.equal(sessionTtlMs(), 30 * 60 * 60 * 1000);
  process.env.AUTH_SESSION_TTL_HOURS = "0";
  assert.equal(sessionTtlMs(), DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000, "Out-of-range TTL falls back to the default.");
  process.env.AUTH_SESSION_TTL_HOURS = "abc";
  assert.equal(sessionTtlMs(), DEFAULT_SESSION_TTL_HOURS * 60 * 60 * 1000);
} finally {
  if (originalTtl === undefined) delete process.env.AUTH_SESSION_TTL_HOURS;
  else process.env.AUTH_SESSION_TTL_HOURS = originalTtl;
}

// 6. CSRF / same-origin decision matrix.
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000" }), { ok: true });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000", secFetchSite: "same-origin" }), { ok: true });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", secFetchSite: "none" }), { ok: true });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000" }), { ok: true }, "Non-browser clients send neither header.");
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "https://attacker.example" }),
  { ok: false, reason: "host_mismatch" },
);
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "http://localhost.evil.test:3000" }),
  { ok: false, reason: "host_mismatch" },
);
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000.evil.test" }),
  { ok: false, reason: "invalid_origin" },
  "A malformed port must be rejected rather than normalised.",
);
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "null" }), { ok: false, reason: "invalid_origin" });
assert.deepEqual(checkSameOrigin({ host: "localhost:3000", origin: "ftp://localhost:3000" }), { ok: false, reason: "invalid_origin" });
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", origin: "http://localhost:3000", secFetchSite: "cross-site" }),
  { ok: false, reason: "cross_site" },
);
assert.deepEqual(
  checkSameOrigin({ host: "localhost:3000", secFetchSite: "same-site" }),
  { ok: false, reason: "cross_site" },
);

// 7. Actor resolution: a broken session never falls back to the development owner.
assert.deepEqual(
  resolveActor({ hasSessionCookie: true, sessionUser: user, localDevUser: null }),
  { mode: "session", user },
);
assert.deepEqual(
  resolveActor({ hasSessionCookie: true, sessionUser: null, localDevUser: user }),
  { mode: "anonymous", reason: "invalid_session", user: null },
  "An expired or revoked cookie must require a fresh login, not a silent dev fallback.",
);
assert.deepEqual(
  resolveActor({ hasSessionCookie: false, sessionUser: null, localDevUser: user }),
  { mode: "local-dev", user },
);
assert.deepEqual(
  resolveActor({ hasSessionCookie: false, sessionUser: null, localDevUser: null }),
  { mode: "anonymous", reason: "missing_session", user: null },
);

// 8. Login throttling thresholds.
assert.equal(isLoginThrottled({ userFailures: 4, ipFailures: 0 }), false);
assert.equal(isLoginThrottled({ userFailures: 5, ipFailures: 0 }), true);
assert.equal(isLoginThrottled({ userFailures: 0, ipFailures: 20 }), true);
assert.equal(isLoginThrottled({ userFailures: 0, ipFailures: 19 }), false);

console.log("Auth unit tests passed: scrypt hashing and seed compatibility, token hashing, cookie attributes, TTL bounds, same-origin/CSRF matrix, actor fallback refusal, and login throttling thresholds.");
