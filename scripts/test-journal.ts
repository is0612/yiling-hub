import assert from "node:assert/strict";
import {
  DIARY_CONTENT_MIN,
  HANDBOOK_QUOTE_MIN,
  isQuoteFromContent,
  renderHandbookContent,
  validateDiaryAiOutput,
  validateHandbookAiOutput,
} from "../server/utils/journal-ai";
import { isJournalDayKey, retryOnVersionConflict } from "../server/utils/journal-service";
import { firstJournalLine } from "../server/utils/journal-dto";

/**
 * 日记 / 手账的纯逻辑：来源白名单、摘句校验、SKIP、日期键。
 *
 * 两份文本共用素材，但校验规则不同：日记是一篇叙事；手账是结构化记录，
 * 它的一句必须能在**给定的日记正文**里找到。
 */

const diaryContent = [
  "今天下午其实有点不开心。一开始我觉得自己的想法没有问题，所以主人提出不同意见的时候，我还有点不服气。",
  "后来重新看了一遍，才发现他的担心确实有道理。虽然中间有点小别扭，不过最后还是一起把问题解决了。",
].join("\n");

const validMessages = ["msg-1", "msg-2"];
const validEvents = ["event-1"];

function diaryBase(overrides: Record<string, unknown> = {}) {
  return {
    action: "CREATE",
    title: "有点小别扭的一天",
    content: diaryContent,
    sourceMessageIds: ["msg-1"],
    sourceEventIds: ["event-1"],
    ...overrides,
  };
}

function handbookBase(overrides: Record<string, unknown> = {}) {
  return {
    action: "CREATE",
    snippets: ["下午跟主人讨论项目，意见不太一样。", "晚上一起把问题改好了。"],
    thought: "坚持自己的想法没错，但也应该认真听听别人的意见。",
    quote: "我还有点不服气",
    inspirations: ["分歧不等于否定。"],
    followUps: ["明天再看看改完的效果。"],
    tags: ["项目", "自我反思"],
    sourceMessageIds: ["msg-1"],
    sourceEventIds: ["event-1"],
    ...overrides,
  };
}

// 1. 日记：正常输出
{
  const entry = validateDiaryAiOutput(diaryBase(), validMessages, validEvents);
  assert.equal(entry.action, "CREATE");
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(entry.title, "有点小别扭的一天");
  assert.deepEqual(entry.sourceMessageIds, ["msg-1"]);
  assert.equal(entry.thought, undefined, "日记没有「想法」字段");
}

// 2. 日记：太短 / 编来源 / SKIP
{
  assert.throws(
    () => validateDiaryAiOutput(diaryBase({ content: "太短" }), validMessages, validEvents),
    /LLM_INVALID_CONTENT/,
  );
  assert.throws(
    () => validateDiaryAiOutput(diaryBase({ sourceMessageIds: ["fake"], sourceEventIds: [] }), validMessages, validEvents),
    /LLM_INVALID_SOURCES/,
  );
  const skip = validateDiaryAiOutput({ action: "SKIP", reason: "今天只有寒暄。" }, validMessages, validEvents);
  assert.equal(skip.action, "SKIP");
  assert.ok(DIARY_CONTENT_MIN > 0);
}

// 3. 手账：栏目拼成正文，想法/一句/标签独立保存
{
  const entry = validateHandbookAiOutput(handbookBase(), validMessages, validEvents, diaryContent);
  assert.equal(entry.action, "CREATE");
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.match(entry.content, /## 今日片段/);
  assert.match(entry.content, /## 灵感与发现/);
  assert.match(entry.content, /## 待续事项/);
  assert.equal(entry.thought, "坚持自己的想法没错，但也应该认真听听别人的意见。");
  assert.equal(entry.quote, "我还有点不服气");
  assert.deepEqual(entry.tags, ["项目", "自我反思"]);
  assert.ok(HANDBOOK_QUOTE_MIN > 0);
}

// 4. 手账：一句必须来自给定日记；不是原话就丢掉这一句，不连坐其它栏目
{
  const entry = validateHandbookAiOutput(handbookBase({ quote: "今天真是充实的一天。" }), validMessages, validEvents, diaryContent);
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(entry.quote, undefined);
  assert.ok(entry.content.length > 0);
}

// 5. 手账：那天没有日记时，一句不能凭空存在
{
  const entry = validateHandbookAiOutput(handbookBase(), validMessages, validEvents, null);
  if (entry.action !== "CREATE") throw new Error("expected CREATE");
  assert.equal(entry.quote, undefined);
}

// 6. 手账：一个栏目都没有 → 拒绝；没有来源 → 拒绝
{
  assert.throws(
    () => validateHandbookAiOutput({
      action: "CREATE",
      snippets: [],
      thought: "",
      quote: "",
      inspirations: [],
      followUps: [],
      tags: [],
      sourceMessageIds: ["msg-1"],
    }, validMessages, validEvents, diaryContent),
    /LLM_INVALID_CONTENT/,
  );
  assert.throws(
    () => validateHandbookAiOutput(handbookBase({ sourceMessageIds: [], sourceEventIds: [] }), validMessages, validEvents, diaryContent),
    /LLM_INVALID_SOURCES/,
  );
}

// 7. 手账：SKIP
{
  const skip = validateHandbookAiOutput({ action: "SKIP", reason: "没什么可留的。" }, validMessages, validEvents, diaryContent);
  assert.equal(skip.action, "SKIP");
}

// 8. 空白归一化与子串判定
{
  assert.equal(isQuoteFromContent(diaryContent, "我还有点不服气"), true);
  assert.equal(isQuoteFromContent(diaryContent, "有点不开心。  一开始"), true, "空白差异不算改字");
  assert.equal(isQuoteFromContent(diaryContent, "他今天很开心"), false);
}

// 9. 手账正文渲染：空栏目不出现小标题
{
  assert.equal(renderHandbookContent({ snippets: ["片段"], inspirations: [], followUps: [] }), "## 今日片段\n- 片段");
}

// 10. 日期键 / 列表首句
{
  assert.equal(isJournalDayKey("2026-10-31"), true);
  assert.equal(isJournalDayKey("2026-13-01"), false);
  assert.equal(isJournalDayKey("2026-02-30"), false);
  assert.equal(isJournalDayKey("2026-1-1"), false);
  assert.equal(firstJournalLine("今天下午其实有点不开心。后面还有。"), "今天下午其实有点不开心");
  assert.equal(firstJournalLine(""), "");
}

// 11. 版本号冲突：只对 P2002 重试，其他错误不吞
{
  let calls = 0;
  const result = await retryOnVersionConflict(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("version conflict"), { code: "P2002" });
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2, "P2002 应重试一次");

  let attempts = 0;
  await assert.rejects(
    retryOnVersionConflict(async () => {
      attempts += 1;
      throw Object.assign(new Error("still conflicting"), { code: "P2002" });
    }, 2),
    /still conflicting/,
  );
  assert.equal(attempts, 2, "重试次数有上限");

  await assert.rejects(
    retryOnVersionConflict(async () => {
      throw Object.assign(new Error("db down"), { code: "P1001" });
    }),
    /db down/,
  );
}

console.log("✅ test-journal 全部通过");
console.log("   日记：第一人称叙事校验 / 来源白名单 / SKIP");
console.log("   手账：栏目渲染 / 一句必须来自日记 / 空手账拒绝");
console.log("   日期键与列表首句：通过");
