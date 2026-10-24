export type RankedCandidate<T> = T & {
  relevanceScore: number;
  matchedTerms: string[];
};

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

const ENGLISH_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "about", "be", "been", "before", "but", "by", "can", "did",
  "discuss", "discussed", "do", "earlier", "for", "from", "how", "i", "in", "is", "it", "like",
  "liked", "likes", "love", "loved", "loves", "me", "my", "of", "on", "or", "our", "please",
  "previously", "remember", "remembered", "talk", "talked", "tell", "the", "their", "them", "they",
  "this", "that", "to", "told", "was", "we", "what", "when", "where", "which", "who", "why", "with",
  "you", "your",
]);

// These are query-intent words, not usually the topic the user wants to retrieve.
const CJK_INTENT_STOPWORDS = [
  "我想知道", "我想问", "告诉我", "帮我", "请问", "有没有", "是不是", "为什么",
  "怎么样", "怎么样了", "如何", "怎么", "怎样", "哪个", "哪些", "什么", "用户",
  "角色", "我们", "你们", "他们", "她们", "它们", "之前", "以后", "后来", "目前",
  "现在", "那个", "这个", "这些", "那些", "一下", "已经", "喜欢", "讨论", "聊过",
  "说过", "提到", "谈过", "有关", "关于", "可以", "是否", "就是", "不是", "然后",
  "因为", "所以", "但是", "如果", "以及", "还有", "记忆",
].sort((left, right) => right.length - left.length);

const CJK_CONNECTORS = new Set(["和", "与", "及", "跟"]);

function splitCjkIntent(run: string): string[] {
  let segments = [run];
  for (const stopword of CJK_INTENT_STOPWORDS) {
    segments = segments.flatMap((segment) => segment.split(stopword));
  }

  // Split short conjunctions only when they join two multi-character topic phrases.
  // This avoids treating words such as “和平” as a conjunction.
  return segments.flatMap((segment) => {
    const pieces: string[] = [];
    let start = 0;
    for (let index = 0; index < segment.length; index += 1) {
      if (
        CJK_CONNECTORS.has(segment[index] ?? "") &&
        index - start >= 2 &&
        segment.length - index - 1 >= 2
      ) {
        pieces.push(segment.slice(start, index));
        start = index + 1;
      }
    }
    pieces.push(segment.slice(start));
    return pieces.filter(Boolean);
  });
}

export function extractRetrievalTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set<string>();

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    if (!ENGLISH_STOPWORDS.has(match[0])) terms.add(match[0]);
  }

  const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      terms.add(run);
      continue;
    }
    for (const segment of splitCjkIntent(run)) {
      if (!segment) continue;
      // Keep a complete short phrase as a high-value signal, in addition to n-grams.
      if (segment.length >= 2 && segment.length <= 8) terms.add(segment);
      for (const size of [3, 2]) {
        for (let index = 0; index <= segment.length - size; index += 1) {
          terms.add(segment.slice(index, index + size));
        }
      }
    }
  }

  // Bound term extraction so unusually long messages cannot trigger unbounded scoring work.
  return [...terms].slice(0, 160);
}

function dateValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
}

function termLengthWeight(term: string): number {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term)) {
    if (term.length >= 5) return 1.7;
    if (term.length === 4) return 1.55;
    if (term.length === 3) return 1.3;
    if (term.length === 2) return 1;
    return 0.6;
  }
  return Math.min(1.8, 1.1 + term.length * 0.08);
}

function rankCandidates<T extends { id: string }>(
  query: string,
  candidates: T[],
  textOf: (candidate: T) => string,
  recencyOf: (candidate: T) => unknown,
  limit: number,
): RankedCandidate<T>[] {
  const terms = extractRetrievalTerms(query);
  if (!terms.length || limit <= 0) return [];

  const normalizedQuery = normalizeComparable(query);
  const prepared = candidates.map((candidate) => ({
    candidate,
    normalizedText: normalizeComparable(textOf(candidate)),
    recency: dateValue(recencyOf(candidate)),
  }));

  // IDF within the current candidate set dampens generic terms shared by many records.
  const termWeights = new Map(terms.map((term) => {
    const normalizedTerm = normalizeComparable(term);
    const documentFrequency = prepared.reduce(
      (count, entry) => count + (entry.normalizedText.includes(normalizedTerm) ? 1 : 0),
      0,
    );
    const inverseDocumentFrequency = Math.log(1 + (prepared.length + 1) / (documentFrequency + 1));
    return [term, termLengthWeight(term) * inverseDocumentFrequency] as const;
  }));
  const totalWeight = [...termWeights.values()].reduce((sum, weight) => sum + weight, 0);

  const ranked = prepared
    .map((entry) => {
      const matchedTerms = terms.filter((term) =>
        entry.normalizedText.includes(normalizeComparable(term)),
      );
      const matchedWeight = matchedTerms.reduce((sum, term) => sum + (termWeights.get(term) ?? 0), 0);
      const weightedCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      const exactPhraseBonus = normalizedQuery.length >= 2 && entry.normalizedText.includes(normalizedQuery) ? 5 : 0;
      const score = weightedCoverage * 10 + exactPhraseBonus + Math.min(matchedTerms.length, 4) * 0.05;
      return {
        candidate: entry.candidate,
        score,
        matchedTerms,
        recency: entry.recency,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.recency - left.recency ||
      left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, limit);

  return ranked.map((entry) => ({
    ...entry.candidate,
    relevanceScore: Math.round(entry.score * 100) / 100,
    matchedTerms: entry.matchedTerms,
  }));
}

export function rankMemoryCandidates<T extends { id: string; content: string; updatedAt?: unknown; createdAt?: unknown }>(
  query: string,
  memories: T[],
  limit = 8,
): RankedCandidate<T>[] {
  return rankCandidates(query, memories, (memory) => memory.content, (memory) => memory.updatedAt ?? memory.createdAt, limit);
}

export function rankSnapshotCandidates<T extends { id: string; summary: string; createdAt?: unknown; periodEnd?: unknown }>(
  query: string,
  snapshots: T[],
  limit = 4,
): RankedCandidate<T>[] {
  return rankCandidates(query, snapshots, (snapshot) => snapshot.summary, (snapshot) => snapshot.createdAt ?? snapshot.periodEnd, limit);
}
