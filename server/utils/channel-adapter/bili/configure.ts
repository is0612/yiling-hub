/**
 * B站渠道的连接加载与值班配置 —— 对应 QQ 的 configure.ts，但 B站 连接的"凭据"不是
 * AppID/AppSecret，而是值班设置（perDay/keywords/zone 等）与 bili 可执行文件路径。
 *
 * 这些配置写在 PlatformConnection.metadata 的 JSON 里；B站 的登录凭证（cookie）沿用
 * bili-cli 自己的 `%APPDATA%\bili-cli\credential.json`，不随代码、不入库。
 */

import { getPrisma } from "../../prisma";
import { BILI_PLATFORM } from "./types";

export type BiliBindingRecord = { id: string; characterId: string; routingKey: string | null };

export type BiliDutyConfig = {
  /** 每天挑几条上限。 */
  perDay: number;
  /** 是否只在谷时窗口刷。 */
  peakValley: boolean;
  /** 中午谷时窗口（12:00-14:00）。 */
  noon: boolean;
  /** 夜间谷时窗口（18:00-09:00）。 */
  night: boolean;
  /** 关注关键词（空则只看推荐流 + 热榜）。 */
  keywords: string[];
  /** 热门分区，默认 all。 */
  zone: string;
  /** 抽帧数（0 = 不抽）。 */
  frames: number;
  /** 是否开公开评论。 */
  autoComment: boolean;
  /** 每轮最多公开评论条数。 */
  commentPerRound: number;
  /** 公开评论里 @ 谁（空 = 不 @）。 */
  mentionName: string;
  /** 私信投递模式：only / both / off。 */
  dmMode: "only" | "both" | "off";
};

export type BiliConnectionRecord = {
  id: string;
  platform: string;
  /** 数据目录（对应 bili-desk 的 DATA_HOME，可覆盖 bili 的 BILI_DESK_HOME）。 */
  dataHome: string;
  /** bili 可执行文件路径（空则从 BILI_BIN / PATH 找）。 */
  biliBin: string;
  duty: BiliDutyConfig;
  bindings: BiliBindingRecord[];
};

export const BILI_DUTY_DEFAULTS: BiliDutyConfig = {
  perDay: 5,
  peakValley: true,
  noon: true,
  night: true,
  keywords: [],
  zone: "all",
  frames: 0,
  autoComment: false,
  commentPerRound: 1,
  mentionName: "",
  dmMode: "only",
};

function readDutyConfig(metadata: unknown): BiliDutyConfig {
  const record = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const duty = (record.duty && typeof record.duty === "object" ? record.duty : {}) as Record<string, unknown>;
  return parseDutyInput(duty);
}

/**
 * 从用户提交的「值班设置」对象里解析出规范化的 BiliDutyConfig。
 * 通道创建（channels/index.post.ts）和值班设置更新（bili/duty 接口）共用这一套，
 * 避免两处各写一份字段校验。缺省字段回退到 BILI_DUTY_DEFAULTS。
 */
export function parseDutyInput(input: unknown): BiliDutyConfig {
  const duty = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const keywords = Array.isArray(duty.keywords)
    ? duty.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim()).slice(0, 20)
    : [];
  const dmMode = duty.dmMode === "both" || duty.dmMode === "off" ? duty.dmMode : "only";
  return {
    perDay: num(duty.perDay, BILI_DUTY_DEFAULTS.perDay, 0, 50),
    peakValley: bool(duty.peakValley, BILI_DUTY_DEFAULTS.peakValley),
    noon: bool(duty.noon, BILI_DUTY_DEFAULTS.noon),
    night: bool(duty.night, BILI_DUTY_DEFAULTS.night),
    keywords,
    zone: typeof duty.zone === "string" && duty.zone.trim() ? duty.zone.trim() : "all",
    frames: num(duty.frames, BILI_DUTY_DEFAULTS.frames, 0, 30),
    autoComment: bool(duty.autoComment, BILI_DUTY_DEFAULTS.autoComment),
    commentPerRound: num(duty.commentPerRound, BILI_DUTY_DEFAULTS.commentPerRound, 0, 20),
    mentionName: typeof duty.mentionName === "string" ? duty.mentionName.trim() : "",
    dmMode,
  };
}

/**
 * 加载所有应服务的 B站 连接及其值班配置和活动角色绑定。配置残缺的连接被跳过而不崩溃。
 */
export async function loadBiliConnections(platform: string = BILI_PLATFORM): Promise<BiliConnectionRecord[]> {
  const prisma = getPrisma();
  const connections = await prisma.platformConnection.findMany({
    where: { platform, status: { not: "DISABLED" } },
    select: {
      id: true,
      platform: true,
      metadata: true,
      characterBindings: { where: { status: "ACTIVE" }, select: { id: true, characterId: true, routingKey: true } },
    },
  });

  const records: BiliConnectionRecord[] = [];
  for (const connection of connections) {
    const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
    const dataHome = typeof metadata.dataHome === "string" ? metadata.dataHome.trim() : "";
    const biliBin = typeof metadata.biliBin === "string" ? metadata.biliBin.trim() : "";
    records.push({
      id: connection.id,
      platform: connection.platform,
      dataHome,
      biliBin,
      duty: readDutyConfig(metadata),
      bindings: connection.characterBindings.map((binding) => ({
        id: binding.id,
        characterId: binding.characterId,
        routingKey: binding.routingKey,
      })),
    });
  }
  return records;
}
