import { getPrisma } from "../prisma";
import type { QqConnectionRecord } from "./configure";
import { handleChannelMessage } from "./pipeline";
import { getQqAccessToken, sendQqMessage, type QqConnectionConfig } from "./qq";
import { routeEventToBinding } from "./route";
import {
  qqConversationKey,
  readQqAuthorOpenId,
  readQqMessageId,
  readQqMessageText,
  type QqMessageEventType,
} from "./types";

export type QqHandleOutcome =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/**
 * Builds the message-event handler shared by the long-running adapter and the test harness: parse
 * the event, route it to a bound character, run the pipeline and send the reply back through QQ.
 */
export function createQqMessageHandler(record: QqConnectionRecord, config: QqConnectionConfig) {
  return async (eventType: QqMessageEventType, data: unknown): Promise<QqHandleOutcome> => {
    const content = readQqMessageText(eventType, data);
    const externalMessageId = readQqMessageId(data);
    const externalConversationId = qqConversationKey(eventType, data);
    const authorOpenId = readQqAuthorOpenId(data);
    if (!content || !externalMessageId || !externalConversationId) {
      return { status: "ignored", reason: "missing_fields" };
    }

    const binding = routeEventToBinding(record.bindings, eventType, data);
    if (!binding) return { status: "ignored", reason: "no_binding" };

    await getPrisma()
      .platformConnection.update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);

    const token = await getQqAccessToken(config);

    return handleChannelMessage({
      platform: "qq",
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType,
      externalConversationId,
      externalMessageId,
      authorOpenId,
      content,
      sendReply: (reply) => sendQqMessage(config, token, { eventType, data, text: reply }),
    });
  };
}
