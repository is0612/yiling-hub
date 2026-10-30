<script setup lang="ts">
import { Delete, EditPen, MagicStick, Picture } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

/**
 * 表情包：她自己的图。
 *
 * 与 QQ 内置表情的区别要写在页面上 —— 「为什么我传了图，她还是发那个官方笑脸」
 * 是第一眼就会有的疑问，答案在这里：内置表情是 QQ 自带的那几十张脸，表情包才是她的图，
 * 有素材库时优先用素材库；两边共用同一个「表情」开关和同一个额度（N 分钟最多 N 张）。
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
/** 表情额度（跟「表情」开关一起配的）：多少分钟内最多几张。 */
const emojiWindowMinutes = ref(10);
const emojiPerWindow = ref(3);

// ── 排序 + 分页 ────────────────────────────────────────
// 攒到几十张以后一屏放不下，翻到后面就找不到「哪张一直没用过」。
// stickers 始终是全量，页面只渲染 pagedStickers 这一窗。
type SortKey = "recent" | "oldest" | "mostUsed" | "lastUsed" | "fresh";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "recent", label: "最近添加" },
  { value: "oldest", label: "最早添加" },
  { value: "mostUsed", label: "用过最多的" },
  { value: "lastUsed", label: "最近用过的" },
  { value: "fresh", label: "一直没用过的" },
];

const sortKey = ref<SortKey>("recent");
const page = ref(1);
const pageSize = ref(12);

/** null 的 lastUsedAt 当 0 处理，这样「最近用过的」自然把没用过的沉到最后。 */
const timeOf = (value: string | null) => (value ? new Date(value).getTime() : 0);

const sortedStickers = computed(() => {
  const rows = [...stickers.value];
  switch (sortKey.value) {
    case "oldest":
      return rows.sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
    case "mostUsed":
      return rows.sort((a, b) => b.useCount - a.useCount || timeOf(b.createdAt) - timeOf(a.createdAt));
    case "lastUsed":
      return rows.sort((a, b) => timeOf(b.lastUsedAt) - timeOf(a.lastUsedAt) || timeOf(b.createdAt) - timeOf(a.createdAt));
    case "fresh":
      // 一次都没用过的一律排前面 —— 这一档就是用来找「白占名额」的那几张。
      return rows.sort(
        (a, b) => Number(a.useCount > 0) - Number(b.useCount > 0) || timeOf(b.createdAt) - timeOf(a.createdAt),
      );
    default:
      return rows.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));
  }
});

const pagedStickers = computed(() => {
  const start = (page.value - 1) * pageSize.value;
  return sortedStickers.value.slice(start, start + pageSize.value);
});

const disabledCount = computed(() => stickers.value.filter((item) => !item.enabled).length);

/** 页码居中显示用：第 13–24 张，共 25 张。 */
const rangeLabel = computed(() => {
  if (!sortedStickers.value.length) return "";
  const start = (page.value - 1) * pageSize.value + 1;
  const end = Math.min(page.value * pageSize.value, sortedStickers.value.length);
  return `第 ${start}–${end} 张，共 ${sortedStickers.value.length} 张`;
});

// 删到最后一页只剩一两张时页码会越界，落回最后一页。
watch([() => sortedStickers.value.length, pageSize], () => {
  const maxPage = Math.max(1, Math.ceil(sortedStickers.value.length / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

const pageDescription = computed(
  () =>
    `她自己的表情图：QQ 内置表情是客户端自带的那几十张脸，谁发都一样；这里传的图会作为图片单独发一条。有表情包时优先用表情包，两者共用同一个「表情」开关，额度是每 ${emojiWindowMinutes.value} 分钟最多 ${emojiPerWindow.value} 张。`,
);

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
      $fetch<{ name: string; emojiEnabled?: boolean; emojiWindowMinutes?: number; emojiPerWindow?: number }>(
        `/api/characters/${encodeURIComponent(id.value)}`,
      ),
      $fetch<StickerItem[]>(`/api/characters/${encodeURIComponent(id.value)}/stickers`),
    ]);
    characterName.value = character.name;
    emojiEnabled.value = character.emojiEnabled === true;
    if (typeof character.emojiWindowMinutes === "number") emojiWindowMinutes.value = character.emojiWindowMinutes;
    if (typeof character.emojiPerWindow === "number") emojiPerWindow.value = character.emojiPerWindow;
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
    // 新加的这张在任何排序下都不一定落在第一页，直接翻到它那一页，省得人以为没传上。
    const index = sortedStickers.value.findIndex((item) => item.id === created.id);
    if (index >= 0) page.value = Math.floor(index / pageSize.value) + 1;
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

// ── 重新识别：让模型再看一次这张图 ──────────────────────
// 第一次打标常常不准（动图只看到一帧、抽象梗图、带字的图），用户宁可让她再看一次，
// 也不想手打一遍。识别结果直接写库并就地更新这一行 —— 不满意还有「编辑」兜底。
const relabelingId = ref("");

async function relabel(row: StickerItem) {
  if (relabelingId.value) return;
  relabelingId.value = row.id;
  try {
    const result = await $fetch<{ skipped: boolean; message?: string; sticker?: StickerItem }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(row.id)}/relabel`,
      { method: "POST" },
    );
    if (result.skipped) {
      ElMessage.warning(result.message || "模型判断这张不像表情包，名字没有改。");
      return;
    }
    if (!result.sticker) return;
    row.name = result.sticker.name;
    row.usage = result.sticker.usage;
    ElMessage.success(
      result.sticker.usage
        ? `重新识别完成：${result.sticker.name} · ${result.sticker.usage}`
        : `重新识别完成：${result.sticker.name}`,
    );
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "重新识别失败。");
  } finally {
    relabelingId.value = "";
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
  generatedFrom.value = "";
}

// ── 弹窗里的「AI 生成」：只补「什么时候用」这一栏 ──────────────
// 用户常常知道这张图是什么（名字起得出来），但写不出「什么时候用」那句话；
// 而挑图的模型真正比对的是那一句，空着等于这张图永远轮不上。
// 只把建议填进输入框、不进库 —— 用户可能还要改，落库仍走「保存」。
const generatingUsage = ref(false);
const generatedFrom = ref<"" | "vision" | "name">("");

async function generateUsage() {
  const target = editing.value;
  if (!target || generatingUsage.value) return;
  // 传的是**输入框里当前的名字**：用户往往先改了名字才想起来点这个按钮。
  const name = editName.value.trim();
  if (!name) {
    ElMessage.error("先在「名字」里写个词，AI 才知道该按什么写场景。");
    return;
  }
  generatingUsage.value = true;
  try {
    const result = await $fetch<{ usage: string; source: "vision" | "name" }>(
      `/api/characters/${encodeURIComponent(id.value)}/stickers/${encodeURIComponent(target.id)}/usage-suggestion`,
      { method: "POST", body: { name } },
    );
    editUsage.value = result.usage;
    generatedFrom.value = result.source;
    ElMessage.success(result.source === "vision" ? "按「名字 + 画面」生成了一句，可以再改。" : "按名字生成了一句，可以再改。");
  } catch (error) {
    ElMessage.error((error as { statusMessage?: string })?.statusMessage || "生成失败。");
  } finally {
    generatingUsage.value = false;
  }
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
      :description="pageDescription"
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
          <p class="sticker-hint">
            宽于 200px 的图会自动等比缩小（高度跟着变），比 200 窄的原样保留 ——
            QQ 按图片原始像素显示，不缩的话一张 1500px 的图在聊天窗里会占满一屏。
          </p>

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
                <span
                  v-if="disabledCount"
                  class="title-aside"
                >停用 {{ disabledCount }} 张</span>
              </div><p class="section-description">
                停用的图不会被她用到，但保留在列表里。用过几次、最近一次什么时候用，都记在这里。
              </p>
            </div>
          </div>

          <div
            v-if="stickers.length"
            class="sticker-toolbar"
          >
            <span class="form-label">排序</span>
            <el-select
              v-model="sortKey"
              style="width: 150px"
            >
              <el-option
                v-for="option in SORT_OPTIONS"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
            <span class="sticker-range">{{ rangeLabel }}</span>
          </div>

          <div
            v-if="stickers.length"
            class="sticker-list"
          >
            <div
              v-for="sticker in pagedStickers"
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
                <p
                  class="sticker-usage"
                  :class="{ 'is-empty': !sticker.usage }"
                >
                  {{ sticker.usage || "还没写什么时候用，她只能凭名字猜" }}
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
                  :loading="relabelingId === sticker.id"
                  :disabled="Boolean(relabelingId) && relabelingId !== sticker.id"
                  title="让 AI 重新看一次这张图，重写名字和使用场景"
                  @click="relabel(sticker)"
                >
                  <el-icon><MagicStick /></el-icon>重新识别
                </el-button>
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

          <div
            v-if="sortedStickers.length > pageSize"
            class="sticker-pager"
          >
            <el-pagination
              v-model:current-page="page"
              v-model:page-size="pageSize"
              :total="sortedStickers.length"
              :page-sizes="[12, 24, 48]"
              :pager-count="5"
              layout="sizes, prev, pager, next"
              size="small"
              background
            />
          </div>

          <p
            v-else-if="!stickers.length"
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
        <div class="sticker-field">
          <div class="form-label-row">
            <span class="form-label">什么时候用</span>
            <el-button
              link
              type="primary"
              size="small"
              :loading="generatingUsage"
              title="按名字生成一句使用场景；开了「看图」会顺带参考画面"
              @click="generateUsage"
            >
              <el-icon><MagicStick /></el-icon>AI 生成
            </el-button>
          </div>
          <el-input
            v-model="editUsage"
            maxlength="200"
            placeholder="被冤枉、想撒娇的时候用"
          />
        </div>
        <p
          v-if="generatedFrom"
          class="edit-hint"
        >
          {{ generatedFrom === "vision" ? "这句是按「名字 + 画面」生成的。" : "这句只按名字生成，她没看到图。" }}不满意可以直接改。
        </p>
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

.sticker-hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: #8a90a6;
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

/* 标签右侧挂一个「AI 生成」：贴着它服务的那一栏，比放到弹窗底部更不容易找错。 */
.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.form-label-row .el-button {
  font-size: 12px;
  padding: 0;
  height: auto;
}

.sticker-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sticker-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.sticker-range {
  margin-left: auto;
  font-size: 12px;
  color: #8a90a6;
}

.sticker-pager {
  display: flex;
  justify-content: center;
  margin-top: 14px;
}

.title-aside {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: #8a90a6;
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

/* 没写场景的单独标出来：她挑图时看的就是名字 + 场景，缺一项就容易挑错。 */
.sticker-usage.is-empty {
  color: #a8701a;
}

.sticker-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  /* 四个操作（开关 / 重新识别 / 编辑 / 删除）在窄窗口里会挤，允许换行并右对齐。 */
  flex-wrap: wrap;
  justify-content: flex-end;
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
