<script setup lang="ts">
import { ArrowRight, CirclePlus, MoreFilled, Plus, Search, MagicStick, Close } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import type { Character, CharacterStatus } from "~/utils/mock-data";

const characters = ref<Character[]>([]);
const loading = ref(false);
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

onMounted(() => void loadCharacters());
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="工作空间 / 角色管理" title="你的角色档案" description="集中管理不同的人设、模型配置与记忆周期。每个角色都拥有独立的经历和记忆。">
      <template #actions><el-button type="primary" @click="dialogOpen = true"><el-icon><Plus /></el-icon>创建角色</el-button></template>
    </PageHeader>

    <div class="stat-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <StatCard label="全部角色" :value="String(characters.length).padStart(2, '0')" note="包含已暂停角色" symbol="♙" tone="purple" />
      <StatCard label="正在运行" :value="String(characters.filter(x => x.status === '运行中').length).padStart(2, '0')" note="已配置活动渠道" symbol="✦" tone="green" />
      <StatCard label="已保存记忆" :value="String(characters.reduce((sum, x) => sum + x.memoryCount, 0))" note="示例条目统计" symbol="◈" tone="blue" />
    </div>

    <section class="surface panel" style="margin-top:20px">
      <div class="filter-row">
        <div class="filter-grow">
          <el-input v-model="query" placeholder="搜索角色名称、简介或标签……" clearable>
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </div>
        <el-select v-model="statusFilter" aria-label="筛选角色状态" style="width:160px">
          <el-option label="全部状态" value="全部状态" />
          <el-option label="运行中" value="运行中" />
          <el-option label="已暂停" value="已暂停" />
          <el-option label="未连接" value="未连接" />
        </el-select>
        <el-button @click="resetFilters"><el-icon><Close /></el-icon>重置筛选</el-button>
      </div>
      <div class="filter-summary"><span>找到 <strong>{{ filtered.length }}</strong> 个角色</span><span>角色已保存到本地数据库</span></div>
    </section>

    <div v-if="filtered.length" class="character-grid">
      <article v-for="character in filtered" :key="character.id" class="surface surface-hover character-card">
        <div class="character-card-head">
          <div class="avatar character-avatar" :class="'avatar-' + character.avatarTone">{{ character.avatar }}</div>
          <div class="character-info">
            <div class="character-name-row"><h2 class="character-name">{{ character.name }}</h2><span class="pill" :class="statusTone(character.status)">{{ character.status }}</span></div>
            <div class="character-alias">{{ character.alias }}</div>
          </div>
          <el-dropdown trigger="click">
            <el-button text circle aria-label="角色更多操作"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="navigateTo('/characters/' + character.id)">打开驾驶舱</el-dropdown-item>
                <el-dropdown-item @click="navigateTo('/characters/' + character.id + '/settings/memory')">记忆设置</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <p class="character-description">{{ character.description }}</p>
        <div class="meta-row">
          <span>◷ {{ character.intervalDays }} 天快照周期</span>
          <span>◈ {{ character.memoryCount }} 条记忆</span>
        </div>
        <div class="card-divider" />
        <div class="character-footer">
          <div><div class="muted-note">最近快照</div><strong>{{ character.latestSnapshot }}</strong></div>
          <el-button type="primary" plain @click="navigateTo('/characters/' + character.id)">查看档案<el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
        </div>
      </article>
    </div>
    <div v-else class="surface empty-state">没有找到符合条件的角色，请调整搜索或筛选条件。</div>

    <el-dialog v-model="dialogOpen" title="创建角色" width="min(560px, 94vw)" destroy-on-close>
      <el-form label-position="top" @submit.prevent="createCharacter">
        <el-form-item label="角色名称" required><el-input v-model="name" placeholder="例如：星海旅人" maxlength="40" show-word-limit /></el-form-item>
        <el-form-item label="角色简介"><el-input v-model="description" type="textarea" :rows="2" placeholder="用一句话描述角色的个性或定位。" /></el-form-item>
        <el-form-item label="基础人设"><el-input v-model="personality" type="textarea" :rows="3" placeholder="角色的性格、说话方式、行为规则……" /></el-form-item>
        <div class="info-callout"><el-icon><MagicStick /></el-icon><span>角色将保存到本地 PostgreSQL；请勿在未完成认证前将开发接口公开到网络。</span></div>
        <div class="dialog-actions"><el-button @click="dialogOpen = false">取消</el-button><el-button type="primary" @click="createCharacter"><el-icon><CirclePlus /></el-icon>创建角色</el-button></div>
      </el-form>
    </el-dialog>
    <p class="footer-note">角色列表和档案创建已接入本地数据库；快照、时间线和任务执行仍处于后续开发阶段。</p>
  </div>
</template>

<style scoped>
.character-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px;margin-top:16px}
.filter-summary{display:flex;justify-content:space-between;gap:12px;margin-top:16px;color:#9ca4b6;font-size:10px}.filter-summary strong{color:#5d6881}
.card-divider{height:1px;margin:17px 0;background:#f0f2f7}
.character-footer{display:flex;align-items:center;justify-content:space-between;gap:10px}.character-footer strong{display:block;margin-top:5px;color:#59647c;font-size:11px}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
@media(max-width:1100px){.character-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.character-grid{grid-template-columns:1fr}.stat-grid[style]{grid-template-columns:1fr!important}.filter-summary{flex-direction:column}}
</style>
