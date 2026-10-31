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

const visibleFriends = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return characterFriends.value
    .filter((item) => {
      if (!keyword) return true;
      return (item.displayName ?? "").toLowerCase().includes(keyword)
        || item.platformUid.toLowerCase().includes(keyword)
        || platformLabel(item.platform).toLowerCase().includes(keyword);
    })
    .sort((a, b) => {
      const aTime = a.lastInteractedAt ? Date.parse(a.lastInteractedAt) : 0;
      const bTime = b.lastInteractedAt ? Date.parse(b.lastInteractedAt) : 0;
      if (aTime !== bTime) return bTime - aTime;
      return Date.parse(b.knownSince) - Date.parse(a.knownSince);
    });
});

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
          v-for="friend in visibleFriends"
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
              <dd>
                {{ friend.interactionCount }} 次
                <span
                  v-if="friend.conversationCount"
                  class="fr-meta"
                >· {{ friend.conversationCount }} 段单独对话</span>
              </dd>
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
    </template>
  </div>
</template>

<style scoped>
/* A 套：白砖、零描边、零阴影。全部规则挂在 .fr-a 下（作用域 + 压过 main.css 单类规则）。 */
.fr-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.fr-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }

/* 工具栏：左边角色分段（只有一个角色时不出现），右边搜索 */
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: var(--sp-4); }
.fr-search { display: flex; height: 36px; flex: 0 1 260px; align-items: center; gap: 8px; margin-left: auto; border-radius: 8px; background: var(--surface); padding: 0 12px; color: var(--dim); }
.fr-search input { width: 100%; min-width: 0; border: 0; background: none; color: var(--text); font-size: 13px; outline: none; }
.fr-search input::placeholder { color: var(--faint); }
.seg { display: flex; gap: 2px; border-radius: 8px; background: var(--surface); padding: 3px; }
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

/* 上限 620：只剩一张卡时不要被拉到整行宽 */
.friend-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 620px)); justify-content: start; gap: var(--sp-4); align-items: start; }
.friend-card {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 18px 14px;
}
.friend-card.is-skeleton { gap: 10px; padding-bottom: 18px; }

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
.fr-kv .fr-meta { margin-left: 6px; color: var(--dim); font-size: 12px; font-weight: 500; }

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

@media (max-width: 860px) {
  .friend-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  /* 角色分段和搜索各占一行：四个角色挤进一行会变成横向滚动条 */
  .toolbar { flex-wrap: wrap; }
  .seg { width: 100%; overflow-x: auto; }
  .fr-search { flex: 1 1 100%; margin-left: 0; }
}
@media (max-width: 560px) {
  .band { gap: 0 12px; padding: 14px 16px 15px; }
  .band-f { display: none; }
}
</style>
