export type RankedCandidate<T> = T & {
  relevanceScore: number;
  matchedTerms: string[];
};

function normalizeComparable(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function extractRetrievalTerms(query: string): string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) terms.add(match[0]);

  const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) terms.add(run);
    for (const size of [2, 3]) {
      for (let index = 0; index <= run.length - size; index += 1) terms.add(run.slice(index, index + size));
    }
  }
  return [...terms].slice(0, 80);
}

function relevanceForText(query: string, terms: string[], candidateText: string): { score: number; matchedTerms: string[] } {
  const normalizedQuery = normalizeComparable(query);
  const normalizedText = normalizeComparable(candidateText);
  if (!normalizedText || terms.length === 0) return { score: 0, matchedTerms: [] };
  const matchedTerms = terms.filter((term) => normalizedText.includes(normalizeComparable(term)));
  if (!matchedTerms.length) return { score: 0, matchedTerms: [] };

  const coverage = matchedTerms.length / terms.length;
  const exactPhraseBonus = normalizedQuery.length >= 2 && normalizedText.includes(normalizedQuery) ? 5 : 0;
  return { score: coverage * 10 + exactPhraseBonus + Math.min(matchedTerms.length, 4) * 0.15, matchedTerms };
}

function dateValue(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
  return 0;
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
  return candidates
    .map((candidate) => {
      const match = relevanceForText(query, terms, textOf(candidate));
      return { candidate, score: match.score, matchedTerms: match.matchedTerms };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      dateValue(recencyOf(right.candidate)) - dateValue(recencyOf(left.candidate)) ||
      left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, limit)
    .map((entry) => ({
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
