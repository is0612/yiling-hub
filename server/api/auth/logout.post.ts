import { setHeader, setResponseStatus } from "h3";
import { buildClearSessionCookie, readSessionToken, revokeSessionByToken } from "../../utils/auth";

/**
 * Revokes the presented session (if any) and clears the cookie. Always succeeds so a stale or
 * already-revoked cookie cannot trap the browser in a logged-in state.
 */
export default defineEventHandler(async (event) => {
  const token = readSessionToken(event);
  if (token) await revokeSessionByToken(token);
  setHeader(event, "set-cookie", buildClearSessionCookie());
  setResponseStatus(event, 204);
  return null;
});
