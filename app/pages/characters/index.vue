<script setup lang="ts">
import { ArrowRight, CirclePlus, MoreFilled, Plus, MagicStick, Delete, User, CopyDocument, VideoPause, VideoPlay, Edit } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character, CharacterStatus } from "~/utils/mock-data";

const characters = ref<Character[]>([]);
const loading = ref(true);
const dialogOpen = ref(false);
const name = ref("");
const description = ref("");
const personality = ref("");

const editDialogOpen = ref(false);
const editTarget = ref<Character | null>(null);
const editName = ref("");
const editDescription = ref("");
const editPersonality = ref("");

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

function statusTone(status: CharacterStatus) {
  return status === "运行中" ? "pill-green" : status === "已暂停" ? "pill-amber" : "pill-gray";
}

function readError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function openEdit(character: Character) {
  editTarget.value = character;
  editName.value = character.name;
  editDescription.value = character.description;
  editPersonality.value = character.personality;
  editDialogOpen.value = true;
}

async function saveEdit() {
  const target = editTarget.value;
  if (!target) return;
  const trimmed = editName.value.trim();
  if (!trimmed) {
    ElMessage.warning("请先填写角色名称。");
    return;
  }
  try {
    const updated = await $fetch<Character>(`/api/characters/${target.id}`, {
      method: "PATCH",
      body: {
        name: trimmed,
        description: editDescription.value.trim(),
        personality: editPersonality.value.trim(),
      },
    });
    const index = characters.value.findIndex((item) => item.id === target.id);
    if (index >= 0) characters.value.splice(index, 1, updated);
    editDialogOpen.value = false;
    ElMessage.success("角色资料已更新。");
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  }
}

/**
 * 复制角色：只复制人设/简介/标签，不带记忆、会话、阶段总结与渠道绑定。
 * 复制出来的角色是个「同名新生体」——记忆从零开始，避免两套记忆互相污染。
 */
async function duplicateCharacter(character: Character) {
  try {
    const copy = await $fetch<Character>("/api/characters", {
      method: "POST",
      body: {
        name: character.name + " 副本",
        alias: character.alias,
        description: character.description,
        personality: character.personality,
        avatarTone: character.avatarTone,
      },
    });
    characters.value.unshift(copy);
    ElMessage.success(`已复制「${character.name}」。人设沿用，记忆从零开始。`);
  } catch (error) {
    ElMessage.error(readError(error, "复制失败，请稍后重试。"));
  }
}

/** 停用 / 启用：停用后角色不再回复 AI 对话、渠道消息和 B站 值班。 */
async function toggleCharacterStatus(character: Character) {
  const pausing = character.status !== "已暂停";
  if (pausing) {
    const confirmed = await ElMessageBox.confirm(
      `停用「${character.name}」后，它不再回复 AI 对话、渠道消息，也不跑 B站 值班。已有记忆和阶段总结不受影响，自动归档仍按记忆设置单独控制。`,
      "停用角色",
      { confirmButtonText: "停用", cancelButtonText: "取消", type: "warning" },
    ).catch(() => false);
    if (!confirmed) return;
  }
  try {
    const updated = await $fetch<Character>(`/api/characters/${character.id}`, {
      method: "PATCH",
      body: { status: pausing ? "已暂停" : "运行中" },
    });
    const index = characters.value.findIndex((item) => item.id === character.id);
    if (index >= 0) characters.value.splice(index, 1, updated);
    ElMessage.success(pausing ? "角色已停用。" : "角色已启用。");
  } catch (error) {
    ElMessage.error(readError(error, pausing ? "停用失败，请稍后重试。" : "启用失败，请稍后重试。"));
  }
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
  <div class="page-wrap chars-a">
    <PageHeader
      eyebrow="工作空间 / AI 角色管理"
      title="你的 AI 角色"
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
      v-else-if="characters.length"
      class="card-grid"
    >
      <div
        v-for="character in characters"
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
            {{ character.description || "还没有写简介" }}
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
              <el-dropdown-item @click="openEdit(character)">
                <el-icon><Edit /></el-icon>编辑角色
              </el-dropdown-item>
              <el-dropdown-item @click="navigateTo('/characters/' + character.id)">
                打开驾驶舱
              </el-dropdown-item>
              <el-dropdown-item @click="navigateTo('/characters/' + character.id + '/settings/memory')">
                记忆设置
              </el-dropdown-item>
              <el-dropdown-item @click="duplicateCharacter(character)">
                <el-icon><CopyDocument /></el-icon>复制角色
              </el-dropdown-item>
              <el-dropdown-item @click="toggleCharacterStatus(character)">
                <el-icon>
                  <VideoPause v-if="character.status !== '已暂停'" />
                  <VideoPlay v-else />
                </el-icon>{{ character.status === "已暂停" ? "启用角色" : "停用角色" }}
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
      <h4>还没有角色</h4>
      <p>创建第一个角色，开始积累它独立的记忆与经历。</p>
      <button
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
          <el-icon><MagicStick /></el-icon><span>创建后可在角色设置里补模型 API 和归档周期，配好就能开始对话。</span>
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

    <el-dialog
      v-model="editDialogOpen"
      title="编辑角色"
      width="min(560px, 94vw)"
      destroy-on-close
    >
      <el-form
        label-position="top"
        @submit.prevent="saveEdit"
      >
        <el-form-item
          label="角色名称"
          required
        >
          <el-input
            v-model="editName"
            placeholder="例如：星海旅人"
            maxlength="40"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="角色简介">
          <el-input
            v-model="editDescription"
            type="textarea"
            :rows="2"
            placeholder="用一句话描述角色的个性或定位。"
          />
        </el-form-item>
        <el-form-item label="基础人设">
          <el-input
            v-model="editPersonality"
            type="textarea"
            :rows="3"
            placeholder="角色的性格、说话方式、行为规则……"
          />
        </el-form-item>
        <div class="dialog-actions">
          <el-button @click="editDialogOpen = false">
            取消
          </el-button><el-button
            type="primary"
            @click="saveEdit"
          >
            保存修改
          </el-button>
        </div>
      </el-form>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览页 A 套「色块平铺」：一张白台面，零描边零阴影，
   层次只靠明度差 + 间距，颜色只给状态。
   L0 画布（--bg）→ L1 白砖 #fff → L2 卡内分节靠留白 → L3 状态药丸上色
   统一写 `.chars-a .xxx`：锁住本页，同时靠 (0,3,0) 压过
   main.css 里 .card / .kpi / .pill / .btn / .surface 的 (0,1,0)。
   ══════════════════════════════════════════════════════════════ */

/* 卡片网格：16px 缝，跟画布留出呼吸。
   角色基本只有 1 个，会看到一张卡靠左 —— 那是内容少，不是布局错，别为此拉宽成横条 */
.chars-a .card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.chars-a .character-card-wrap { position: relative; display: flex; }

/* 白砖：零描边零阴影。整卡即入口，hover 只让文字回应，不给整卡铺底
   （白卡在 #f4f6f9 画布上，铺 --surface-2 反而更亮，会看成"往上飘"） */
.chars-a .surface,
.chars-a .char-card {
  border: 0;
  box-shadow: none;
  background: var(--surface);
  border-radius: 10px;
}
.chars-a .char-card {
  display: flex;
  width: 100%;
  flex-direction: column;
  padding: 18px 18px 15px;
}
.chars-a .char-card:hover .character-name,
.chars-a .char-card:hover .card-cta { color: var(--brand-strong); }

.chars-a .card-more { position: absolute; top: 8px; right: 8px; z-index: 2; }
.chars-a .card-more :deep(.el-button) { color: var(--faint); }
.chars-a .card-more :deep(.el-button:hover) { background: var(--surface-3); color: var(--text-2); }

/* 卡头：头像 48px 刚好压住「名称 16 + 别名 12」两行 */
.chars-a .character-avatar { width: 48px; height: 48px; font-size: 17px; }
.chars-a .character-name { color: var(--text); font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
/* 别名是身份信息，不能落在 --faint（2.52:1）上 */
.chars-a .character-alias { margin-top: 3px; color: var(--dim); font-size: 12px; }

/* 描述：最多两行，不锁最小高度。main.css 给这个类写了 min-height:40px，
   会把一行占位文案撑成两行高，在描述和元信息之间留出一段假空隙、把一组信息拆成两块 */
.chars-a .character-description {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  min-height: 0;
  margin-top: 12px;
  color: var(--dim);
  font-size: 14px;
  line-height: 1.6;
}
.chars-a .character-description.is-empty { color: var(--dim); }

/* 元信息成一组：描述→meta 16，meta→底栏 6 —— 组间距必须明显大于组内 */
.chars-a .meta-row { gap: 10px; margin-top: 16px; color: var(--dim); font-size: 12px; }
.chars-a .character-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
  border-top: 0;
  padding-top: 0;
}
.chars-a .character-footer .muted-note { display: inline-flex; align-items: baseline; gap: 4px; color: var(--dim); }
.chars-a .character-footer strong { color: var(--text-2); font-size: 12px; font-weight: 600; }
.chars-a .card-cta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  transition: color .16s var(--ease);
}

/* 状态药丸：无描边；正常态软底深字，文字按浅底实测加深 */
.chars-a .pill { border: 0; }
.chars-a .pill-green { color: #0b7a54; }
.chars-a .pill-amber { color: #8f5c05; }
.chars-a .pill-gray { color: var(--text-2); }

/* 空态：虚线框和渐变光晕都去掉，跟总览的引导块同一块白砖 */
.chars-a .empty-block {
  min-height: 260px;
  border: 0;
  border-radius: 10px;
  background: var(--surface);
  padding: 34px 24px 30px;
}
.chars-a .empty-block .halo {
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  border-radius: 50%;
  background: var(--brand-soft);
  box-shadow: none;
  color: var(--brand);
  font-size: 20px;
}
.chars-a .empty-block h4 { margin: 0 0 7px; color: var(--text); font-size: 16px; font-weight: 600; }
.chars-a .empty-block p { max-width: 460px; margin: 0 0 16px; color: var(--dim); font-size: 14px; line-height: 1.7; }

.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

@media (max-width: 1100px) {
  .chars-a .card-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 700px) {
  .chars-a .card-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
