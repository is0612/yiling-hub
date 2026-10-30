<script setup lang="ts">
import { Delete, EditPen, Picture } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

/**
 * 表情包：她自己的图。
 *
 * 与 QQ 内置表情的区别要写在页面上 —— 「为什么我传了图，她还是发那个官方笑脸」
 * 是第一眼就会有的疑问，答案在这里：内置表情是 QQ 自带的那几十张脸，表情包才是她的图，
 * 有素材库时优先用素材库；两边都受同一个「表情」开关和 10 分钟冷却管着。
 */
type StickerItem = {
  id: string;
  name: string;
  usage: string;
  enabled: boolean;
  mimeType: string;
  sizeBytes: number;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  source: string;
};

const route = useRoute();
const id = computed(() => String(route.params.id || ""));

const characterName = ref("");
const loading = ref(true);
const stickers = ref<StickerItem[]>([]);
const saving = ref(false);
/** 角色的「表情」开关。关着的时候传多少张她都不会贴——不写页面上就会有人白传一通。 */
const emojiEnabled = ref(false);

/** 待上传的图（浏览器里的原始文件，还没进表单）。 */
const pendingFile = ref<File | null>(null);
const draftName = ref("");
const draftUsage = ref("");

const MAX_BYTES = 2 * 1024 * 1024;

const imageUrl = (stickerId: string) =>
  `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(stickerId)}/image`;

const sizeLabel = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const canSubmit = computed(() => Boolean(pendingFile.value) && draftName.value.trim().length > 0);

function onFileChange(file: { raw?: File } | null) {
  const raw = file?.raw ?? null;
  if (!raw) {
    pendingFile.value = null;
    return;
  }
  if (raw.size > MAX_BYTES) {
    ElMessage.error(`图片不能超过 ${MAX_BYTES / 1024 / 1024}MB，这张有 ${sizeLabel(raw.size)}。`);
    pendingFile.value = null;
    return;
  }
  pendingFile.value = raw;
  // 没填名字时用文件名（去掉扩展名）兜底：十张图全叫「表情」，页面上根本分不清谁是谁。
  if (!draftName.value.trim()) {
    draftName.value = raw.name.replace(/\.[^.]+$/, "").slice(0, 60);
  }
}

async function load() {
  loading.value = true;
  try {
    const [character, rows] = await Promise.all([
      $fetch<{ name: string; emojiEnabled?: boolean }>(`/api/characters/${encodeURIComponent(id.value)}`),
      $fetch<StickerItem[]>(`/api/characters/${encodeURIComponent(id.value)}/stickers`),
    ]);
    characterName.value = character.name;
    emojiEnabled.value = character.emojiEnabled === true;
    stickers.value = rows;
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "读取表情包失败。");
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!pendingFile.value || !canSubmit.value) return;
  saving.value = true;
  try {
    const form = new FormData();
    form.append("file", pendingFile.value);
    form.append("filename", pendingFile.value.name);
    form.append("name", draftName.value.trim().slice(0, 60));
    form.append("usage", draftUsage.value.trim().slice(0, 200));
    const created = await $fetch<StickerItem>(`/api/characters/${encodeURIComponent(id.value)}/stickers`, {
      method: "POST",
      body: form,
    });
    stickers.value = [...stickers.value, created];
    pendingFile.value = null;
    draftName.value = "";
    draftUsage.value = "";
    ElMessage.success("已添加。她下一轮就有这张图了。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "上传失败。");
  } finally {
    saving.value = false;
  }
}

async function toggleEnabled(row: StickerItem, enabled: boolean) {
  try {
    const updated = await $fetch<StickerItem>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}`,
      { method: "PATCH", body: { enabled } },
    );
    row.enabled = updated.enabled;
  } catch (error) {
    row.enabled = !enabled;
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "更新失败。");
  }
}

// ── 编辑：名字 + 使用场景 ───────────────────────────────
// 自动打标（尤其「偷」来的图）经常判断不准，这里让她自己改回来。
// 只改这两个字段：图本身不换（换图等于换一张表情，应该删了重传）。
const editing = ref<StickerItem | null>(null);
const editName = ref("");
const editUsage = ref("");
const savingEdit = ref(false);

function openEdit(row: StickerItem) {
  editing.value = row;
  editName.value = row.name;
  editUsage.value = row.usage;
}

async function saveEdit() {
  const target = editing.value;
  if (!target) return;
  const name = editName.value.trim();
  if (!name) {
    ElMessage.error("名字不能为空。");
    return;
  }
  savingEdit.value = true;
  try {
    const updated = await $fetch<StickerItem>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(target.id)}`,
      { method: "PATCH", body: { name, usage: editUsage.value.trim() } },
    );
    // 就地更新这一行，不整页重拉：列表滚动位置和展开状态都还在。
    target.name = updated.name;
    target.usage = updated.usage;
    editing.value = null;
    ElMessage.success("已保存。她下一轮就按新的名字和场景来挑。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "保存失败。");
  } finally {
    savingEdit.value = false;
  }
}

async function remove(row: StickerItem) {
  try {
    await ElMessageBox.confirm(`删除「${row.name}」？删掉就找不回来了。`, "删除表情包", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}`, {
      method: "DELETE",
    });
    stickers.value = stickers.value.filter((item) => item.id !== row.id);
    ElMessage.success("已删除。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "删除失败。");
  }
}

onMounted(load);
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="'角色管理 / ' + (characterName || '角色') + ' / 表情包'"
      title="表情包"
      description="她自己的表情图：QQ 内置表情是客户端自带的那几十张脸，谁发都一样；这里传的图会作为图片单独发一条。有表情包时优先用表情包，两者共用同一个「表情」开关和冷却。"
      :back-to="'/characters?c=' + id"
      back-label="返回角色列表"
    />

    <div
      v-if="!loading && !emojiEnabled"
      class="sticker-warn"
    >
      角色的「表情」开关现在是关的 —— 开了她才会贴图（在「模型设置 → 表情」里打开）。
    </div>

    <div class="settings-grid">
      <div>
        <section
          v-loading="loading"
          class="surface form-section"
        >
          <div class="settings-section-head">
            <div>
              <div class="form-title">
                添加一张
              </div><p class="section-description">
                名字是她看到的（写「委屈」「得意」这类情绪词最好），使用场景再补一句，帮她在十几张里挑对。
              </p>
            </div>
          </div>

          <div class="sticker-form">
            <el-upload
              accept="image/png,image/jpeg,image/gif,image/webp"
              :auto-upload="false"
              :show-file-list="false"
              :limit="1"
              @change="onFileChange($event as unknown as { raw?: File })"
            >
              <template #trigger>
                <el-button>
                  <el-icon><Picture /></el-icon>选择图片
                </el-button>
              </template>
            </el-upload>
            <span class="form-help">
              {{ pendingFile ? `已选：${pendingFile.name}（${sizeLabel(pendingFile.size)}）` : "PNG / JPG / GIF / WebP，最大 2MB" }}
            </span>
          </div>

          <div class="sticker-form-fields">
            <label class="sticker-field">
              <span class="form-label">名字</span>
              <el-input
                v-model="draftName"
                maxlength="60"
                placeholder="委屈 / 得意 / 拍桌笑"
              />
            </label>
            <label class="sticker-field sticker-field-wide">
              <span class="form-label">什么时候用</span>
              <el-input
                v-model="draftUsage"
                maxlength="200"
                placeholder="被冤枉、想撒娇的时候用"
              />
            </label>
          </div>

          <div class="form-actions">
            <el-button
              type="primary"
              :disabled="!canSubmit"
              :loading="saving"
              @click="submit"
            >
              添加
            </el-button>
          </div>
        </section>
      </div>

      <div>
        <section class="surface form-section">
          <div class="settings-section-head">
            <div>
              <div class="form-title">
                已有 {{ stickers.length }} 张
              </div><p class="section-description">
                停用的图不会被她用到，但保留在列表里。用过几次、最近一次什么时候用，都记在这里。
              </p>
            </div>
          </div>

          <div
            v-if="stickers.length"
            class="sticker-list"
          >
            <div
              v-for="sticker in stickers"
              :key="sticker.id"
              class="sticker-card"
              :class="{ 'is-off': !sticker.enabled }"
            >
              <img
                class="sticker-thumb"
                :src="imageUrl(sticker.id)"
                :alt="sticker.name"
              >
              <div class="sticker-body">
                <div class="sticker-name">
                  {{ sticker.name }}
                  <span class="sticker-count">用过 {{ sticker.useCount }} 次</span>
                  <span
                    v-if="sticker.source === 'collected'"
                    class="sticker-source"
                  >从群里收的</span>
                </div>
                <p class="sticker-usage">
                  {{ sticker.usage || "还没写什么时候用" }}
                </p>
              </div>
              <div class="sticker-ops">
                <el-switch
                  :model-value="sticker.enabled"
                  @update:model-value="(value) => toggleEnabled(sticker, Boolean(value))"
                />
                <el-button
                  link
                  type="primary"
                  @click="openEdit(sticker)"
                >
                  <el-icon><EditPen /></el-icon>编辑
                </el-button>
                <el-button
                  link
                  type="danger"
                  @click="remove(sticker)"
                >
                  <el-icon><Delete /></el-icon>删除
                </el-button>
              </div>
            </div>
          </div>

          <p
            v-else
            class="section-description"
          >
            还没有表情包。传一张，她回复时就能贴自己的图了。
          </p>
        </section>
      </div>
    </div>

    <el-dialog
      :model-value="Boolean(editing)"
      title="编辑表情包"
      width="440px"
      @update:model-value="(value: boolean) => { if (!value) editing = null; }"
    >
      <div
        v-if="editing"
        class="edit-body"
      >
        <img
          class="edit-thumb"
          :src="imageUrl(editing.id)"
          :alt="editing.name"
        >
        <label class="sticker-field">
          <span class="form-label">名字</span>
          <el-input
            v-model="editName"
            maxlength="60"
            placeholder="委屈 / 得意 / 拍桌笑"
          />
        </label>
        <label class="sticker-field">
          <span class="form-label">什么时候用</span>
          <el-input
            v-model="editUsage"
            maxlength="200"
            placeholder="被冤枉、想撒娇的时候用"
          />
        </label>
        <p class="edit-hint">
          她挑图时看的就是这两项。名字写情绪词、场景写具体一点，比「表情1」「好笑的图」好挑得多。
        </p>
      </div>
      <template #footer>
        <el-button @click="editing = null">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="savingEdit"
          @click="saveEdit"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sticker-warn {
  margin-bottom: 14px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #f3d7a4;
  background: #fff8ec;
  color: #8a5a12;
  font-size: 13px;
}

.sticker-form {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.sticker-form-fields {
  display: flex;
  gap: 12px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.sticker-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 180px;
}

.sticker-field-wide {
  flex: 1;
  min-width: 240px;
}

.form-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2, #4a4f63);
}

.sticker-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sticker-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e6e8f0;
  border-radius: 10px;
  background: #fff;
}

.sticker-card.is-off {
  opacity: 0.55;
}

.sticker-body {
  flex: 1;
  min-width: 0;
}

.sticker-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
}

.sticker-count {
  font-size: 12px;
  font-weight: 400;
  color: #8a90a6;
}

.sticker-source {
  font-size: 12px;
  font-weight: 500;
  color: #7c5cd6;
  background: #f0ebff;
  padding: 1px 8px;
  border-radius: 10px;
}

.sticker-usage {
  margin: 2px 0 0;
  font-size: 12px;
  color: #6b7186;
}

.sticker-ops {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sticker-thumb {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border-radius: 8px;
  background: #f2f3f7;
}

.edit-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.edit-thumb {
  width: 96px;
  height: 96px;
  object-fit: contain;
  border-radius: 10px;
  background: #f2f3f7;
  align-self: flex-start;
}

.edit-hint {
  margin: 0;
  font-size: 12px;
  color: #8a90a6;
  line-height: 1.6;
}

.form-actions {
  margin-top: 16px;
}
</style>
