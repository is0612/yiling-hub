/**
 * 宽松 JSON 解析：模型经常带 ```json 围栏，或在前后加一句解释。
 *
 * 原来长在 `channel-adapter/bili/cards.ts` 里，主动机制也要解 JSON 数组，
 * 所以抽出来共用；那里保留同名导出，调用点和测试都不用改。
 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = (text || "").trim();
  if (!cleaned) return null;
  const unfenced = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // 落到下面的截取
  }
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const start = unfenced.indexOf(open);
    const end = unfenced.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // 继续试下一个括号
      }
    }
  }
  return null;
}
