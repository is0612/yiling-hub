import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  buildChatCompletionsEndpoint,
  readChatModelSettingsPatch,
  resolveChatModelSettings,
  validateChatApiBaseUrl,
} from "../server/utils/chat-model-config";
import { decryptApiKeyWithKey, encryptApiKeyWithKey } from "../server/utils/credential-encryption";

const defaults = resolveChatModelSettings({}, "ci-default-model");
assert.equal(defaults.model, "ci-default-model");
assert.equal(defaults.temperature, 0.7);
assert.equal(defaults.maxTokens, 1800);
assert.equal(defaults.apiBaseUrl, "https://api.openai.com/v1");
assert.equal(defaults.apiKeyConfigured, false);
assert.equal(defaults.apiKeySource, "missing");

const custom = resolveChatModelSettings({
  chatModel: " custom-model ",
  chatTemperature: 1.2,
  chatMaxTokens: 4096,
  chatApiBaseUrl: "https://api.example.com/v1/",
  chatApiKeyEncrypted: "v1.encrypted-placeholder",
}, "fallback");
assert.equal(custom.model, "custom-model");
assert.equal(custom.temperature, 1.2);
assert.equal(custom.maxTokens, 4096);
assert.equal(custom.apiBaseUrl, "https://api.example.com/v1");
assert.equal(custom.apiKeyConfigured, true);
assert.equal(custom.apiKeySource, "character");

assert.equal(resolveChatModelSettings({ chatModel: "  " }, "env-model").model, "env-model");
assert.equal(resolveChatModelSettings({ chatTemperature: 9, chatMaxTokens: 3 }, "fallback").temperature, 0.7);
assert.equal(resolveChatModelSettings({ chatTemperature: 9, chatMaxTokens: 3 }, "fallback").maxTokens, 1800);

assert.deepEqual(
  readChatModelSettingsPatch({
    chatModel: "  ",
    chatTemperature: 0,
    chatMaxTokens: 8192,
    chatApiBaseUrl: "https://api.deepseek.com/v1/",
    chatApiKey: "  secret-token  ",
    clearApiKey: false,
  }),
  {
    chatModel: "",
    chatTemperature: 0,
    chatMaxTokens: 8192,
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "secret-token",
    clearApiKey: false,
  },
  "API options and trimmed keys should be parsed without echoing keys in public DTOs.",
);

assert.throws(() => readChatModelSettingsPatch({ chatModel: "x".repeat(121) }), /120 个字符/);
assert.throws(() => readChatModelSettingsPatch({ chatTemperature: 2.1 }), /0 到 2/);
assert.throws(() => readChatModelSettingsPatch({ chatMaxTokens: 255 }), /256 到 8192/);
assert.throws(() => readChatModelSettingsPatch({ chatMaxTokens: 1024.5 }), /整数/);
assert.throws(() => readChatModelSettingsPatch({ chatApiKey: "k".repeat(8193) }), /8192 个字符/);
assert.throws(() => validateChatApiBaseUrl("http://api.example.com/v1"), /必须使用 HTTPS/);
assert.throws(() => validateChatApiBaseUrl("ftp://api.example.com/v1"), /只支持 HTTPS/);
assert.throws(() => validateChatApiBaseUrl("https://user:pass@api.example.com/v1"), /不应包含用户名/);
assert.throws(() => validateChatApiBaseUrl("https://api.example.com/v1/chat/completions"), /不要填写 \/chat\/completions/);
assert.equal(validateChatApiBaseUrl("http://127.0.0.1:4010/v1/"), "http://127.0.0.1:4010/v1");
assert.equal(buildChatCompletionsEndpoint("https://api.example.com/v1").href, "https://api.example.com/v1/chat/completions");

const encryptionKey = randomBytes(32);
const plaintextKey = "api-key-must-not-be-stored-in-plain-text";
const encryptedKey = encryptApiKeyWithKey(plaintextKey, encryptionKey);
assert.notEqual(encryptedKey, plaintextKey);
assert.match(encryptedKey, /^v1\./);
assert.equal(decryptApiKeyWithKey(encryptedKey, encryptionKey), plaintextKey);
assert.throws(() => decryptApiKeyWithKey(encryptedKey, randomBytes(32)), /Unsupported state|authenticate|unable to authenticate/i);

console.log("Chat API settings tests passed: browser config validation, URL safety, encryption round-trip, per-character defaults, and malformed input boundaries.");
