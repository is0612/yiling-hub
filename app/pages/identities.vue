<script setup lang="ts">
/**
 * 她的朋友。
 *
 * 一行 = 某角色认识的某个人（一条关系），不是一个账号。同一个 QQ 号跟两个角色都聊过
 * 就有两行，所以页面先选角色，再看这个角色的名单。
 *
 * 口径（和产品对齐过）：私聊一进来就记；群里只记她真的回了谁。所以这里出现的人，
 * 都是跟她有过一来一往的，不是「在群里出现过」。
 */
import { Refresh, Search, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

type Friend = {
  scopeId: string;
  characterId: string;
  characterName: string;
  identityId: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  status: string;
  linkedUserId: string | null;
  interactionCount: number;
  lastInteractedAt: string | null;
  knownSince: string;
  firstSource: string | null;
  conversationCount: number;
};

type Character = { id: string; name: string; status: string };

const loading = ref(true);
const friends = ref<Friend[]>([]);
const characters = ref<Character[]>([]);
const activeCharacterId = ref("");
const query = ref("");
const sourceFilter = ref<"ALL" | "PRIVATE" | "GROUP">("ALL");
type SortBy = "recent" | "count" | "closeness" | "known";
type SortDirection = "asc" | "desc";
const sortBy = ref<SortBy>("recent");

const SORT_OPTIONS: ReadonlyArray<{ value: SortBy; label: string; defaultDirection: SortDirection }> = [
  { value: "recent", label: "最近互动", defaultDirection: "desc" },
  { value: "count", label: "互动次数", defaultDirection: "desc" },
  { value: "closeness", label: "关系亲疏", defaultDirection: "desc" },
  { value: "known", label: "认识先后", defaultDirection: "asc" },
];

/**
 * 每个维度各记各的方向。
 *
 * 不是「一个下拉选字段 + 一个全局箭头」：那样子切换字段方向会被带跑（刚把次数翻成升序，
 * 切到时间又变成升序）。这里每个维度自己存，点当前那个再点一次才翻转。
 */
const sortDirections = ref<Record<SortBy, SortDirection>>({
  recent: "desc",
  count: "desc",
  closeness: "desc",
  known: "asc",
});

function pickSort(value: SortBy) {
  if (sortBy.value === value) {
    sortDirections.value[value] = sortDirections.value[value] === "asc" ? "desc" : "asc";
    return;
  }
  sortBy.value = value;
}

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function platformLabel(platform: string) {
  if (platform === "bili") return "B站";
  if (platform === "qq-onebot") return "QQ";
  if (platform === "wechat") return "微信";
  return platform;
}

function sourceLabel(source: string | null) {
  if (source === "GROUP") return "群里认识";
  if (source === "PRIVATE") return "私聊认识";
  return "来源不明";
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 头像只放一个字：昵称取首字，没有昵称就取 UID 首位。 */
function initialOf(friend: Friend) {
  const source = friend.displayName || friend.platformUid || "?";
  return Array.from(source)[0] ?? "?";
}

const currentCharacter = computed(
  () => characters.value.find((item) => item.id === activeCharacterId.value) ?? null,
);

const characterFriends = computed(
  () => friends.value.filter((item) => item.characterId === activeCharacterId.value),
);

/** 聊过两次以上才算「熟」。只回一句就再没出现过的，是路人，不是朋友。 */
const familiarCount = computed(
  () => characterFriends.value.filter((item) => item.interactionCount >= 2).length,
);

const recentCount = computed(() => {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return characterFriends.value.filter(
    (item) => item.lastInteractedAt && Date.parse(item.lastInteractedAt) >= weekAgo,
  ).length;
});

const sourceCounts = computed(() => ({
  ALL: characterFriends.value.length,
  PRIVATE: characterFriends.value.filter((item) => item.firstSource === "PRIVATE").length,
  GROUP: characterFriends.value.filter((item) => item.firstSource === "GROUP").length,
}));

const sourceOptions = computed<Array<{ value: "ALL" | "PRIVATE" | "GROUP"; label: string; count: number }>>(() => [
  { value: "ALL", label: "全部", count: sourceCounts.value.ALL },
  { value: "PRIVATE", label: "私聊认识", count: sourceCounts.value.PRIVATE },
  { value: "GROUP", label: "群里认识", count: sourceCounts.value.GROUP },
]);

function timeOf(value: string | null) {
  return value ? Date.parse(value) : 0;
}/** 私聊是对方主动找上来的，比在群里被回一句更近 —— 「关系亲疏」拿它做第一权重。 */
function closenessRank(item: Friend) {
  return item.firstSource === "PRIVATE" ? 1 : 0;
}

const visibleFriends = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return characterFriends.value
    .filter((item) => sourceFilter.value === "ALL" || item.firstSource === sourceFilter.value)
    .filter((item) => {
      if (!keyword) return true;
      return (item.displayName ?? "").toLowerCase().includes(keyword)
        || item.platformUid.toLowerCase().includes(keyword)
        || platformLabel(item.platform).toLowerCase().includes(keyword);
    })
    .sort((a, b) => {
      // factor 是这一维度自己的方向：升序 1、降序 -1。次级条件跟着一起翻，
      // 否则「次数升序」里同次数的人会被另一套顺序排回去，看起来像没生效。
      const factor = sortDirections.value[sortBy.value] === "asc" ? 1 : -1;
      const byRecentAsc = timeOf(a.lastInteractedAt) - timeOf(b.lastInteractedAt);
      if (sortBy.value === "recent") {
        return byRecentAsc * factor || timeOf(a.knownSince) - timeOf(b.knownSince);
      }
      if (sortBy.value === "count") {
        return (a.interactionCount - b.interactionCount) * factor || byRecentAsc * -1;
      }
      if (sortBy.value === "known") {
        return (Date.parse(a.knownSince) - Date.parse(b.knownSince)) * factor;
      }
      return (closenessRank(a) - closenessRank(b)) * factor
        || (a.interactionCount - b.interactionCount) * factor
        || byRecentAsc * -1;
    });
});

/** 一页 12 个＝四列三行，正好铺满不剩半行。 */
const PAGE_SIZE = 12;
const page = ref(1);

const totalPages = computed(() => Math.max(1, Math.ceil(visibleFriends.value.length / PAGE_SIZE)));

const pagedFriends = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return visibleFriends.value.slice(start, start + PAGE_SIZE);
});

const rangeText = computed(() => {
  const total = visibleFriends.value.length;
  if (!total) return "0 人";
  const start = (page.value - 1) * PAGE_SIZE + 1;
  const end = Math.min(total, page.value * PAGE_SIZE);
  return `${start}–${end} / 共 ${total} 人`;
});

/** 页码最多摊七个位置，中间用 0 当省略号：1 … 4 5 6 … 20 */
const pageNumbers = computed(() => {
  const total = totalPages.value;
  const current = page.value;
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const picked = [...new Set([1, total, current - 1, current, current + 1])]
    .filter((value) => value >= 1 && value <= total)
    .sort((a, b) => a - b);
  const result: number[] = [];
  let previous = 0;
  for (const value of picked) {
    if (previous && value - previous > 1) result.push(0);
    result.push(value);
    previous = value;
  }
  return result;
});

/** 换了角色、筛了来源、改了关键词或排序，都回第一页 —— 停在第 5 页看新条件是空的会以为没数据。 */
watch([activeCharacterId, query, sourceFilter, sortBy, sortDirections], () => {
  page.value = 1;
}, { deep: true });

function goPage(target: number) {
  page.value = Math.min(totalPages.value, Math.max(1, target));
}

function countOfCharacter(characterId: string) {
  return friends.value.filter((item) => item.characterId === characterId).length;
}

async function loadFriends() {
  loading.value = true;
  try {
    const response = await $fetch<{ friends: Friend[]; characters: Character[] }>("/api/admin/identities");
    friends.value = response.friends;
    characters.value = response.characters;
    const stillValid = response.characters.some((item) => item.id === activeCharacterId.value);
    if (!stillValid) {
      // 默认落在「朋友最多的那个角色」上，而不是列表第一个 —— 空名单开局只会让人以为没数据。
      const ranked = [...response.characters].sort((a, b) => countOfCharacter(b.id) - countOfCharacter(a.id));
      activeCharacterId.value = ranked[0]?.id ?? "";
    }
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取朋友列表。"));
  } finally {
    loading.value = false;
  }
}

onMounted(loadFriends);
</script>

<template>
  <div class="page-wrap fr-a">
    <PageHeader
      eyebrow="角色 / 人际"
      title="她的朋友"
      description="她认识的人按角色分开记。私聊发来消息就算认识；群里只记她真的回了谁 —— 没被搭理的发言不会出现在这里。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadFriends"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
      </template>
    </PageHeader>

    <div
      v-if="loading && !friends.length"
      class="friend-grid"
    >
      <div
        v-for="i in 2"
        :key="'sk-' + i"
        class="friend-card is-skeleton"
      >
        <div
          v-for="n in 3"
          :key="n"
          class="sk"
          :style="{ height: n === 1 ? '32px' : '14px', width: n === 1 ? '58%' : '100%' }"
        />
      </div>
    </div>

    <div
      v-else-if="!characters.length"
      class="empty-block"
    >
      <span class="empty-icon"><el-icon><User /></el-icon></span>
      <h3>还没有角色</h3>
      <p>先建一个角色，她在平台上认识的人才会记到这里。</p>
    </div>

    <template v-else>
      <div class="toolbar">
        <div
          v-if="characters.length > 1"
          class="seg"
        >
          <button
            v-for="item in characters"
            :key="item.id"
            type="button"
            class="seg-btn"
            :class="{ 'is-on': activeCharacterId === item.id }"
            @click="activeCharacterId = item.id"
          >
            {{ item.name }}<span class="seg-n">{{ countOfCharacter(item.id) }}</span>
          </button>
        </div>
        <label class="fr-search">
          <el-icon><Search /></el-icon>
          <input
            v-model="query"
            type="search"
            placeholder="搜昵称或 UID"
          >
        </label>
        <span class="seg-label">来源</span>
        <div class="seg">
          <button
            v-for="option in sourceOptions"
            :key="option.value"
            type="button"
            class="seg-btn"
            :class="{ 'is-on': sourceFilter === option.value }"
            @click="sourceFilter = option.value"
          >
            {{ option.label }}<span class="seg-n">{{ option.count }}</span>
          </button>
        </div>
        <span class="seg-label">排序</span>
        <div class="seg seg-sort">
          <button
            v-for="option in SORT_OPTIONS"
            :key="option.value"
            type="button"
            class="seg-btn"
            :class="{ 'is-on': sortBy === option.value }"
            :title="sortBy === option.value ? '再点一次切换升降序' : `按「${option.label}」排序`"
            @click="pickSort(option.value)"
          >
            {{ option.label }}<span
              v-if="sortBy === option.value"
              class="seg-dir"
            >{{ sortDirections[option.value] === "asc" ? "↑" : "↓" }}</span>
          </button>
        </div>
      </div>

      <div
        v-if="characterFriends.length"
        class="band"
      >
        <div class="band-cell">
          <span class="band-k">{{ currentCharacter?.name ?? "她" }}认识的人</span>
          <span class="band-v">{{ characterFriends.length }}<small>个</small></span>
          <span class="band-f">有过一来一往的都算</span>
        </div>
        <div class="band-cell">
          <span class="band-k">聊过两次以上</span>
          <span class="band-v">{{ familiarCount }}<small>个</small></span>
          <span class="band-f">只回一句就消失的算路人</span>
        </div>
        <div class="band-cell">
          <span class="band-k">最近七天有来往</span>
          <span class="band-v">{{ recentCount }}<small>个</small></span>
          <span class="band-f">按最后一次互动算</span>
        </div>
      </div>

      <div
        v-if="!visibleFriends.length"
        class="empty-block"
      >
        <span class="empty-icon"><el-icon><User /></el-icon></span>
        <h3>{{ characterFriends.length ? "没有找到这个人" : "还没有朋友" }}</h3>
        <p v-if="characterFriends.length">
          换个关键词试试。
        </p>
        <p v-else>
          有人在 QQ 上私聊她，或者她在群里回了谁，这里就会出现那个人。
        </p>
      </div>

      <div
        v-else
        class="friend-grid"
      >
        <article
          v-for="friend in pagedFriends"
          :key="friend.scopeId"
          class="friend-card"
        >
          <div class="fr-head">
            <span class="fr-avatar">{{ initialOf(friend) }}</span>
            <div class="fr-id">
              <h3 class="fr-name">
                {{ friend.displayName || friend.platformUid }}
              </h3>
              <p class="fr-sub">
                {{ platformLabel(friend.platform) }}<span class="sep">·</span>{{ friend.platformUid }}
              </p>
            </div>
            <span class="pill pill-gray">{{ sourceLabel(friend.firstSource) }}</span>
          </div>

          <dl class="fr-kv">
            <div>
              <dt>聊过</dt>
              <dd>{{ friend.interactionCount }} 次</dd>
            </div>
            <div>
              <dt>最近一次</dt>
              <dd :class="{ 'is-muted': !friend.lastInteractedAt }">
                {{ formatDateTime(friend.lastInteractedAt) }}
              </dd>
            </div>
            <div>
              <dt>认识于</dt>
              <dd>{{ formatDateTime(friend.knownSince) }}</dd>
            </div>
          </dl>
        </article>
      </div>

      <div
        v-if="totalPages > 1"
        class="pager"
      >
        <span class="pager-info">{{ rangeText }}</span>
        <div class="pager-btns">
          <button
            type="button"
            class="pager-btn"
            :disabled="page === 1"
            @click="goPage(page - 1)"
          >
            上一页
          </button>
          <template
            v-for="(item, index) in pageNumbers"
            :key="index"
          >
            <span
              v-if="item === 0"
              class="pager-gap"
            >…</span>
            <button
              v-else
              type="button"
              class="pager-btn is-num"
              :class="{ 'is-on': item === page }"
              @click="goPage(item)"
            >
              {{ item }}
            </button>
          </template>
          <button
            type="button"
            class="pager-btn"
            :disabled="page === totalPages"
            @click="goPage(page + 1)"
          >
            下一页
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* A 套：白砖、零描边、零阴影。全部规则挂在 .fr-a 下（作用域 + 压过 main.css 单类规则）。 */
.fr-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.fr-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }

/* 工具栏：角色分段 + 搜索 + 来源分段 + 排序，一行排开，宽度不够自动换行 */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: var(--sp-4); }
/* 搜索框固定窄宽，剩下的空隙靠 margin-right: auto 撑开，把来源/排序推到右边 */
.fr-search { display: flex; height: 36px; flex: 0 0 200px; align-items: center; gap: 8px; margin-right: auto; border-radius: 8px; background: var(--surface); padding: 0 12px; color: var(--dim); }
.fr-search input { width: 100%; min-width: 0; border: 0; background: none; color: var(--text); font-size: 13px; outline: none; }
.fr-search input::placeholder { color: var(--faint); }
.seg { display: flex; gap: 2px; border-radius: 8px; background: var(--surface); padding: 3px; }
/* 两组分段挨着放，标一下哪组是筛来源、哪组是换排序 */
.seg-label { color: var(--dim); font-size: 12px; font-weight: 500; }
.seg-btn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.seg-btn:hover { background: var(--surface-2); }
.seg-btn.is-on { background: var(--surface-2); color: var(--text); }
.seg-n { color: var(--dim); font-variant-numeric: tabular-nums; font-weight: 500; }
/* 当前排序维度后面的箭头：点同一个按钮就翻转，每个维度各记各的方向 */
.seg-dir { color: var(--brand-strong); font-size: 12px; font-weight: 600; line-height: 1; }

/* 统计带：三格数字并进一张白砖，脚注静音 */
.band {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0 24px;
  margin-bottom: var(--sp-4);
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 20px 17px;
}
.band-cell { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.band-k { color: var(--dim); font-size: 12px; }
.band-v { color: var(--text); font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1.25; }
.band-v small { margin-left: 3px; color: var(--dim); font-size: 12px; font-weight: 500; letter-spacing: 0; }
.band-f { overflow: hidden; color: var(--dim); font-size: 12px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }

/* 一行四张；窄屏依次退到三列、两列、单列。
   阈值按视口算（左侧还有 240 的导航），1360 以下内容区不足 4×280，就退三列。 */
.friend-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-3); align-items: start; }
@media (max-width: 1360px) {
  .friend-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 1000px) {
  .friend-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
.friend-card {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--surface);
  padding: 14px 16px 13px;
}
.friend-card.is-skeleton { gap: 10px; padding-bottom: 18px; }

/* 分页：白砖一条，左边范围右边翻页 */
.pager { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: var(--sp-4); border-radius: 10px; background: var(--surface); padding: 8px 12px; }
.pager-info { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.pager-btns { display: flex; align-items: center; gap: 2px; }
.pager-btn {
  display: inline-flex;
  height: 30px;
  min-width: 30px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.pager-btn:hover:not(:disabled) { background: var(--surface-2); }
.pager-btn:disabled { color: var(--faint); cursor: default; }
.pager-btn.is-num.is-on { background: var(--brand-soft); color: var(--brand-strong); }
.pager-gap { padding: 0 2px; color: var(--faint); font-size: 12px; }

.fr-head { display: flex; align-items: flex-start; gap: 11px; }
.fr-avatar {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 16px;
  font-weight: 700;
}
.fr-id { min-width: 0; flex: 1; }
.fr-name { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.fr-sub { margin: 2px 0 0; color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.fr-sub .sep { margin: 0 5px; color: var(--faint); }

/* 释义行：label 定宽 56px，值紧跟在后 */
.fr-kv { display: flex; flex-direction: column; gap: 7px; margin: 14px 0 0; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.fr-kv > div { display: flex; gap: 10px; align-items: baseline; }
.fr-kv dt { flex: 0 0 56px; color: var(--dim); font-size: 12px; }
.fr-kv dd { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.fr-kv dd.is-muted { color: var(--dim); font-weight: 500; }

/* 空态：居中白砖 + 圆形图标，不用虚线框 */
.empty-block {
  display: flex;
  min-height: 260px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--surface);
  padding: 32px 24px;
  text-align: center;
}
.empty-icon {
  display: grid;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20px;
}
.empty-block h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.empty-block p { max-width: 440px; margin: 8px 0 0; color: var(--dim); font-size: 14px; line-height: 1.75; }

@media (max-width: 760px) {
  .friend-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  /* 搜索独占一行；两排分段各自横向滚动，不硬挤 */
  .fr-search { flex: 1 1 100%; }
  .seg { max-width: 100%; overflow-x: auto; }
}
@media (max-width: 560px) {
  .band { gap: 0 12px; padding: 14px 16px 15px; }
  .band-f { display: none; }
}
</style>
