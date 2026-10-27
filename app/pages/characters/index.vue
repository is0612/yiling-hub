<script setup lang="ts">
import { ArrowRight, CirclePlus, MoreFilled, Plus, Search, MagicStick, Close, Delete, User, Collection } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character, CharacterStatus } from "~/utils/mock-data";

const characters = ref<Character[]>([]);
const loading = ref(true);
const query = ref("");
const statusFilter = ref<CharacterStatus | "全部状态">("全部状态");
const dialogOpen = ref(false);
const name = ref("");
const description = ref("");
const personality = ref("");

async function loadCharacters() {
  loading.value = true;
  try {
    characters.value = await $fetch<Character[]>("/api/characters");
  } catch {
    ElMessage.error("读取角色失败。请先完成本地数据库迁移与开发用户初始化。");
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => characters.value.filter((character) => {
  const textMatches = !query.value || `${character.name} ${character.description} ${character.alias}`.toLowerCase().includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "全部状态" || character.status === statusFilter.value;
  return textMatches && statusMatches;
}));
const runningCount = computed(() => characters.value.filter((item) => item.status === "运行中").length);
const totalMemories = computed(() => characters.value.reduce((sum, item) => sum + item.memoryCount, 0));
const hasFilters = computed(() => Boolean(query.value) || statusFilter.value !== "全部状态");

async function createCharacter() {
  const trimmed = name.value.trim();
  if (!trimmed) {
    ElMessage.warning("请先填写角色名称。");
    return;
  }

  try {
    const item = await $fetch<Character>("/api/characters", {
      method: "POST",
      body: {
        name: trimmed,
        description: description.value.trim(),
        personality: personality.value.trim(),
      },
    });
    characters.value.unshift(item);
    dialogOpen.value = false;
    name.value = "";
    description.value = "";
    personality.value = "";
    ElMessage.success("角色已保存到本地数据库。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "创建失败，请检查数据库连接和本地开发配置。";
    ElMessage.error(message);
  }
}

function resetFilters() { query.value = ""; statusFilter.value = "全部状态"; }
function statusTone(status: CharacterStatus) {
  return status === "运行中" ? "pill-green" : status === "已暂停" ? "pill-amber" : "pill-gray";
}

async function deleteCharacter(character: Character) {
  try {
    await ElMessageBox.confirm(
      `确定删除角色「${character.name}」吗？该角色下的所有会话、记忆、阶段总结都会被一并删除，且无法恢复。`,
      "删除角色",
      { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }
  try {
    await $fetch(`/api/characters/${character.id}`, { method: "DELETE" });
    characters.value = characters.value.filter((c) => c.id !== character.id);
    ElMessage.success("角色已删除。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "删除失败，请稍后重试。";
    ElMessage.error(message);
  }
}

onMounted(() => void loadCharacters());
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="工作空间 / 角色管理"
      title="你的角色档案"
      description="集中管理不同的人设、模型配置与记忆周期。每个角色都拥有独立的经历和记忆。"
    >
      <template #actions>
        <el-button
          type="primary"
          @click="dialogOpen = true"
        >
          <el-icon><Plus /></el-icon>创建角色
        </el-button>
      </template>
    </PageHeader>

    <!-- KPI：角色规模一眼看完 -->
    <div class="kpi-row is-three">
      <div class="kpi">
        <div class="k">
          <el-icon><User /></el-icon>全部角色
        </div>
        <div class="v">
          {{ characters.length }}<small>个</small>
        </div>
        <div class="foot">
          角色档案保存在本地数据库
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          <el-icon><MagicStick /></el-icon>正在运行
        </div>
        <div class="v">
          {{ runningCount }}<small>个</small>
        </div>
        <div class="foot">
          {{ characters.length - runningCount }} 个已暂停或未连接
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          <el-icon><Collection /></el-icon>已保存记忆
        </div>
        <div class="v">
          {{ totalMemories }}<small>条</small>
        </div>
        <div class="foot">
          所有角色加总的记忆条目
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <el-input
        v-model="query"
        class="filter-grow"
        placeholder="搜索角色名称、简介或标签……"
        clearable
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select
        v-model="statusFilter"
        aria-label="筛选角色状态"
        style="width:150px"
      >
        <el-option
          label="全部状态"
          value="全部状态"
        />
        <el-option
          label="运行中"
          value="运行中"
        />
        <el-option
          label="已暂停"
          value="已暂停"
        />
        <el-option
          label="未连接"
          value="未连接"
        />
      </el-select>
      <el-button
        v-if="hasFilters"
        @click="resetFilters"
      >
        <el-icon><Close /></el-icon>重置
      </el-button>
      <span class="filter-count">找到 <strong>{{ filtered.length }}</strong> / {{ characters.length }} 个</span>
    </div>

    <div
      v-if="loading"
      class="card-grid"
    >
      <div
        v-for="i in 3"
        :key="i"
        class="surface char-card"
      >
        <div
          class="sk"
          style="height:44px;width:44px;border-radius:8px;margin-bottom:14px"
        />
        <div
          class="sk"
          style="height:14px;width:56%;margin-bottom:10px"
        />
        <div
          class="sk"
          style="height:12px;width:88%;margin-bottom:10px"
        />
        <div
          class="sk"
          style="height:12px;width:64%"
        />
      </div>
    </div>
    <div
      v-else-if="filtered.length"
      class="card-grid"
    >
      <div
        v-for="character in filtered"
        :key="character.id"
        class="character-card-wrap"
      >
        <NuxtLink
          :to="'/characters/' + character.id"
          class="surface surface-hover char-card"
        >
          <div class="character-card-head">
            <div
              class="avatar character-avatar"
              :class="'avatar-' + character.avatarTone"
            >
              {{ character.avatar }}
            </div>
            <div class="character-info">
              <div class="character-name-row">
                <h2 class="character-name">
                  {{ character.name }}
                </h2><span
                  class="pill"
                  :class="statusTone(character.status)"
                >{{ character.status }}</span>
              </div>
              <div class="character-alias">
                {{ character.alias }}
              </div>
            </div>
          </div>
          <p
            class="character-description"
            :class="{ 'is-empty': !character.description }"
          >
            {{ character.description || "还没有写简介，点开档案补一句吧。" }}
          </p>
          <div class="meta-row">
            <span>{{ character.intervalDays }} 天归档周期</span>
            <span>{{ character.memoryCount }} 条记忆</span>
          </div>
          <div class="character-footer">
            <span class="muted-note">最近归档 <strong>{{ character.latestSnapshot }}</strong></span>
            <span class="card-cta">查看档案<el-icon><ArrowRight /></el-icon></span>
          </div>
        </NuxtLink>
        <el-dropdown
          class="card-more"
          trigger="click"
        >
          <el-button
            text
            circle
            aria-label="角色更多操作"
          >
            <el-icon><MoreFilled /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="navigateTo('/characters/' + character.id)">
                打开驾驶舱
              </el-dropdown-item>
              <el-dropdown-item @click="navigateTo('/characters/' + character.id + '/settings/memory')">
                记忆设置
              </el-dropdown-item>
              <el-dropdown-item
                divided
                @click="deleteCharacter(character)"
              >
                <el-icon><Delete /></el-icon>删除角色
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>
    <div
      v-else
      class="empty-block"
    >
      <div class="halo">
        <el-icon :size="22">
          <User />
        </el-icon>
      </div>
      <h4>{{ characters.length ? "没有符合条件的角色" : "还没有角色" }}</h4>
      <p>
        {{ characters.length
          ? "换个关键词或重置筛选条件再试一次。"
          : "创建第一个角色，开始积累它独立的记忆与经历。" }}
      </p>
      <button
        v-if="characters.length"
        class="btn"
        type="button"
        @click="resetFilters"
      >
        重置筛选
      </button>
      <button
        v-else
        class="btn primary"
        type="button"
        @click="dialogOpen = true"
      >
        <el-icon><Plus /></el-icon>创建角色
      </button>
    </div>

    <el-dialog
      v-model="dialogOpen"
      title="创建角色"
      width="min(560px, 94vw)"
      destroy-on-close
    >
      <el-form
        label-position="top"
        @submit.prevent="createCharacter"
      >
        <el-form-item
          label="角色名称"
          required
        >
          <el-input
            v-model="name"
            placeholder="例如：星海旅人"
            maxlength="40"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="角色简介">
          <el-input
            v-model="description"
            type="textarea"
            :rows="2"
            placeholder="用一句话描述角色的个性或定位。"
          />
        </el-form-item>
        <el-form-item label="基础人设">
          <el-input
            v-model="personality"
            type="textarea"
            :rows="3"
            placeholder="角色的性格、说话方式、行为规则……"
          />
        </el-form-item>
        <div class="info-callout">
          <el-icon><MagicStick /></el-icon><span>角色将保存到本地 PostgreSQL；请勿在未完成认证前将开发接口公开到网络。</span>
        </div>
        <div class="dialog-actions">
          <el-button @click="dialogOpen = false">
            取消
          </el-button><el-button
            type="primary"
            @click="createCharacter"
          >
            <el-icon><CirclePlus /></el-icon>创建角色
          </el-button>
        </div>
      </el-form>
    </el-dialog>
    <p class="footer-note">
      角色列表和档案创建已接入本地数据库；阶段总结、时间线和任务执行仍处于后续开发阶段。
    </p>
  </div>
</template>

<style scoped>
/* 概览：三格 KPI，把首屏让给角色列表 */
.kpi-row.is-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }

/* 筛选条：一行搞定，不做成卡片 */
.filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; }
.filter-bar .filter-grow { flex: 1; min-width: 220px; }
.filter-count { margin-left: auto; color: var(--dim); font-size: 12px; }
.filter-count strong { color: var(--text-2); }

.card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.character-card-wrap { position: relative; display: flex; }
.char-card { display: flex; width: 100%; flex-direction: column; padding: 16px 18px 14px; }
.char-card:hover .card-cta { color: var(--brand-strong); }
.card-more { position: absolute; top: 8px; right: 8px; z-index: 2; }
.card-more :deep(.el-button) { color: var(--faint); }
.card-more :deep(.el-button:hover) { background: var(--surface-3); color: var(--text-2); }
/* 卡片不再放独立按钮：整卡即入口，右下只留视觉提示 */
.card-cta { display: inline-flex; align-items: center; gap: 3px; color: var(--faint); font-size: 12px; font-weight: 600; transition: color .16s var(--ease); }
.character-description { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; min-height: 40px; }
.character-description.is-empty { color: var(--faint); }
.character-footer { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-top: 14px; border-top: 1px solid var(--line); padding-top: 11px; }
.character-footer .muted-note { display: inline-flex; align-items: baseline; gap: 4px; }
.character-footer strong { color: var(--text-2); font-size: 12px; font-weight: 600; }

.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
@media (max-width: 1100px) {
  .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .kpi-row.is-three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .card-grid { grid-template-columns: minmax(0, 1fr); }
  .kpi-row.is-three { grid-template-columns: minmax(0, 1fr); }
  .filter-count { margin-left: 0; }
}
</style>
