export type StoredChatModelSettings = {
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
};
export type ResolvedChatModelSettings = { model: string; temperature: number; maxTokens: number };
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 1800;
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 8192;
const MAX_MODEL_LENGTH = 120;
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Credentials and API endpoints deliberately remain server-side environment config. */
export function readChatModelSettingsPatch(body: Record<string, unknown>): Partial<StoredChatModelSettings> {
  const patch: Partial<StoredChatModelSettings> = {};
  if ("chatModel" in body) {
    if (typeof body.chatModel !== "string") throw new Error("模型名称必须是文本。");
    const model = body.chatModel.trim();
    if (model.length > MAX_MODEL_LENGTH) throw new Error("模型名称不能超过 120 个字符。");
    patch.chatModel = model;
  }
  if ("chatTemperature" in body) {
    const value = body.chatTemperature;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) throw new Error("模型温度必须是 0 到 2 之间的数字。");
    patch.chatTemperature = Math.round(value * 10) / 10;
  }
  if ("chatMaxTokens" in body) {
    const value = body.chatMaxTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_MAX_TOKENS || value > MAX_MAX_TOKENS) throw new Error("最大输出 Token 必须是 256 到 8192 之间的整数。");
    patch.chatMaxTokens = value;
  }
  return patch;
}
export function resolveChatModelSettings(value: unknown, fallbackModel = process.env.LLM_MODEL?.trim() || "gpt-4o-mini"): ResolvedChatModelSettings {
  const config = asRecord(value);
  const configuredModel = typeof config.chatModel === "string" ? config.chatModel.trim() : "";
  const temperature = config.chatTemperature;
  const maxTokens = config.chatMaxTokens;
  return {
    model: (configuredModel || fallbackModel).slice(0, MAX_MODEL_LENGTH),
    temperature: typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? Math.round(temperature * 10) / 10 : DEFAULT_TEMPERATURE,
    maxTokens: typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= MIN_MAX_TOKENS && maxTokens <= MAX_MAX_TOKENS ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}
