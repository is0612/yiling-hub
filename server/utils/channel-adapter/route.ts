import type { QqBindingRecord } from "./configure";
import type { QqMessageEventType } from "./types";

/**
 * Chooses which character binding handles an incoming QQ event. Group events prefer an exact
 * routingKey (group openid) match, then fall back to the connection's default binding; private
 * messages use the default binding.
 */
export function routeEventToBinding(
  bindings: readonly QqBindingRecord[],
  eventType: QqMessageEventType,
  data: unknown,
): QqBindingRecord | null {
  const record = data as { group_openid?: unknown } | null;
  const groupOpenId = typeof record?.group_openid === "string" ? record.group_openid : "";
  const defaults = bindings.filter((binding) => !binding.routingKey || binding.routingKey === "*");

  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    if (groupOpenId) {
      const exact = bindings.find((binding) => binding.routingKey === groupOpenId);
      if (exact) return exact;
    }
    return defaults[0] ?? null;
  }

  return defaults[0] ?? null;
}
