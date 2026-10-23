import assert from "node:assert/strict";
import { extractRetrievalTerms, rankMemoryCandidates, rankSnapshotCandidates } from "../server/utils/memory-retrieval";

const query = "用户喜欢科幻电影和太空题材";
const terms = extractRetrievalTerms(query);
assert(terms.includes("科幻") && terms.includes("电影"), "Chinese bigrams should be extracted for keyword retrieval.");

const memories = [
  { id: "memory-film", content: "用户明确说喜欢科幻电影，尤其是太空探索题材。", updatedAt: "2026-10-20T10:00:00.000Z" },
  { id: "memory-food", content: "用户不喜欢香菜，点餐时偏好清淡口味。", updatedAt: "2026-10-23T10:00:00.000Z" },
  { id: "memory-space", content: "用户最近在关注天文学、行星和太空探索纪录片。", updatedAt: "2026-10-18T10:00:00.000Z" },
];

const rankedMemories = rankMemoryCandidates(query, memories, 2);
assert.equal(rankedMemories.length, 2, "Retrieval should respect the requested result limit.");
assert.equal(rankedMemories[0]?.id, "memory-film", "Exact topic matches should rank above weakly related items.");
assert(rankedMemories.every((item) => item.relevanceScore > 0));
assert(!rankMemoryCandidates("本周天气如何", memories).length, "Unrelated content should not be returned as relevant memory.");

const snapshots = [
  { id: "snapshot-1", summary: "本周期讨论了科幻电影与太空探索，并约好一起看一部新片。", periodEnd: "2026-10-21T00:00:00.000Z" },
  { id: "snapshot-2", summary: "用户询问了周末做饭和清淡饮食的建议。", periodEnd: "2026-10-22T00:00:00.000Z" },
];
const rankedSnapshots = rankSnapshotCandidates("我们之前聊过什么科幻电影", snapshots);
assert.equal(rankedSnapshots[0]?.id, "snapshot-1", "Snapshots with overlapping topics should rank first.");
assert.equal(rankSnapshotCandidates("完全无关的海边天气", snapshots).length, 0, "Unrelated snapshots should be excluded.");

console.log("Memory retrieval tests passed: Chinese/English term extraction, relevance ranking, result limits, and unrelated-context exclusion.");
