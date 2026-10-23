import type { Character } from "~/utils/mock-data";

/**
 * 角色列表的共享状态。布局与页面共用同一份数据，避免重复请求 /api/characters。
 */
export function useCharacterList() {
  return useState<Character[]>("character-list", () => []);
}

/**
 * 拉取角色列表并写入共享状态。数据库未就绪时不抛出，交由页面自行提示。
 */
export async function loadCharacters(): Promise<Character[]> {
  const characters = useCharacterList();
  try {
    characters.value = await $fetch<Character[]>("/api/characters");
  } catch {
    // 保持已有列表，调用方按空列表处理。
  }
  return characters.value;
}

/**
 * 在 SSR 与客户端共享同一份角色数据：同 key 在一次请求内只拉取一次，
 * 让首屏渲染（侧边栏导航、首页卡片）就能拿到真实角色 id。
 */
export function useCharacterListData() {
  return useAsyncData("character-list", () => loadCharacters());
}

/**
 * 当前上下文里的角色 id：
 * 1. 角色相关页面取路由参数 [id]；
 * 2. 其余页面回退到角色列表的第一个角色；
 * 3. 没有任何角色时返回 null，调用方应退回 /characters。
 */
export function useActiveCharacterId() {
  const route = useRoute();
  const characters = useCharacterList();

  return computed<string | null>(() => {
    const param = route.params.id;
    if (typeof param === "string" && param) return param;
    return characters.value[0]?.id ?? null;
  });
}
