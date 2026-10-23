import assert from "node:assert/strict";
import { readChatModelSettingsPatch, resolveChatModelSettings } from "../server/utils/chat-model-config";

assert.deepEqual(resolveChatModelSettings({}, "ci-default-model"),
  { model: "ci-default-model", temperature: 0.7, maxTokens: 1800 },
  "Missing settings should use stable defaults.");
assert.deepEqual(resolveChatModelSettings({ chatModel: " custom-model ", chatTemperature: 1.2, chatMaxTokens: 4096 }, "fallback"),
  { model: "custom-model", temperature: 1.2, maxTokens: 4096 },
  "Saved per-character values should be normalized and resolved.");
assert.equal(resolveChatModelSettings({ chatModel: "  " }, "env-model").model, "env-model",
  "An empty model override should fall back to the server default.");
assert.equal(resolveChatModelSettings({ chatTemperature: 9, chatMaxTokens: 3 }, "fallback").temperature, 0.7,
  "Corrupted temperature should safely fall back.");
assert.equal(resolveChatModelSettings({ chatTemperature: 9, chatMaxTokens: 3 }, "fallback").maxTokens, 1800,
  "Corrupted token limits should safely fall back.");
assert.deepEqual(readChatModelSettingsPatch({ chatModel: "  ", chatTemperature: 0, chatMaxTokens: 8192 }),
  { chatModel: "", chatTemperature: 0, chatMaxTokens: 8192 },
  "Supported boundaries and clearing a model override should be allowed.");
assert.throws(() => readChatModelSettingsPatch({ chatModel: "x".repeat(121) }), /120 个字符/);
assert.throws(() => readChatModelSettingsPatch({ chatTemperature: 2.1 }), /0 到 2/);
assert.throws(() => readChatModelSettingsPatch({ chatMaxTokens: 255 }), /256 到 8192/);
assert.throws(() => readChatModelSettingsPatch({ chatMaxTokens: 1024.5 }), /整数/);

console.log("Chat model settings tests passed: defaults, per-character overrides, fallback, bounds, and malformed stored values.");
