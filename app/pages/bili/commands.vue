<script setup lang="ts">
import { Refresh, Search, VideoPlay, CopyDocument, Operation, MagicStick, ArrowRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

type BiliCatalogParam = {
  key: string;
  label: string;
  pos?: boolean;
  flag?: string;
  type?: "text" | "int" | "bool" | "select";
  default?: string;
  choices?: string[];
  ph?: string;
};

type BiliCatalogItem = {
  id: string;
  label: string;
  argv: string[];
  write?: boolean;
  kind?: string;
  params?: BiliCatalogParam[];
};

type BiliCatalogGroup = { group: string; items: BiliCatalogItem[] };

type BiliRunResult = {
  code: number | null;
  json: unknown;
  stdout: string;
  stderr: string;
  elapsed: number;
  argv: string[];
  timedOut: boolean;
};

const groups = ref<BiliCatalogGroup[]>([]);
const loading = ref(false);
const query = ref("");
const opened = ref<string[]>([]);
const activeItem = ref<BiliCatalogItem | null>(null);

const values = reactive<Record<string, any>>({});
const dryRun = ref(true);
const busy = ref(false);
const lastResult = ref<BiliRunResult | null>(null);
const runningArgv = ref<string[]>([]);

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

async function loadCatalog() {
  loading.value = true;
  try {
    const data = await $fetch<{ groups: BiliCatalogGroup[] }>("/api/admin/bili/catalog");
    groups.value = data.groups;
    if (!opened.value.length && data.groups.length) {
      opened.value = [data.groups[0]!.group];
    }
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取命令目录。"));
  } finally {
    loading.value = false;
  }
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q) ||
          i.argv.join(" ").toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.items.length > 0);
});

function toggle(group: string) {
  opened.value = opened.value.includes(group)
    ? opened.value.filter((x) => x !== group)
    : [...opened.value, group];
}

const isOpen = (group: string) => Boolean(query.value.trim()) || opened.value.includes(group);

function pick(item: BiliCatalogItem) {
  activeItem.value = item;
  lastResult.value = null;
  // 重置参数
  for (const key of Object.keys(values)) delete values[key];
  for (const p of item.params ?? []) {
    values[p.key] = p.type === "bool" ? false : (p.default ?? "");
  }
  dryRun.value = true;
}

const params = computed(() => activeItem.value?.params ?? []);
const inputs = computed(() => params.value.filter((p) => p.type !== "bool"));
const toggles = computed(() => params.value.filter((p) => p.type === "bool"));

const argv = computed(() => {
  if (!activeItem.value) return [];
  const out = [...activeItem.value.argv];
  for (const p of params.value) {
    const v = values[p.key];
    if (p.type === "bool") {
      if (v && p.flag) out.push(p.flag);
      continue;
    }
    const text = String(v ?? "").trim();
    if (!text) continue;
    if (p.pos) out.push(text);
    else if (p.flag) out.push(p.flag, text);
  }
  if (activeItem.value.write && dryRun.value) out.push("--dry-run");
  return out;
});

const preview = computed(
  () => "bili " + argv.value.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
);

const missing = computed(() =>
  inputs.value
    .filter((p) => p.pos && !String(values[p.key] ?? "").trim())
    .map((p) => p.label),
);

async function run() {
  if (busy.value || !activeItem.value) return;
  if (missing.value.length) {
    ElMessage.warning(`还差：${missing.value.join("、")}`);
    return;
  }
  busy.value = true;
  runningArgv.value = argv.value;
  lastResult.value = null;
  try {
    const result = await $fetch<BiliRunResult>("/api/admin/bili/run", {
      method: "POST",
      body: { argv: argv.value, itemId: activeItem.value.id, allowWrite: !dryRun.value },
    });
    lastResult.value = result;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "命令执行失败。"));
  } finally {
    busy.value = false;
  }
}

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(preview.value);
    ElMessage.success("命令已复制。");
  } catch {
    ElMessage.warning("剪贴板不可用。");
  }
}

/** 格式化结果 JSON 为可读文本。 */
function formatResult(): string {
  const r = lastResult.value;
  if (!r) return "";
  if (r.json !== null && r.json !== undefined) {
    return JSON.stringify(r.json, null, 2);
  }
  if (r.stdout) return r.stdout;
  if (r.stderr) return r.stderr;
  return "（无输出）";
}

onMounted(loadCatalog);
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / B站命令"
      title="B站命令工作台"
      description="手动执行 bili-cli 的命令：看视频、发评论、回私信、查数据……对应 bili-desk 的「命令执行器」。写操作默认加 --dry-run 安全预览。"
    >
      <template #actions>
        <el-button
          :loading="loading"
          @click="loadCatalog"
        >
          <el-icon><Refresh /></el-icon>刷新目录
        </el-button>
      </template>
    </PageHeader>

    <div class="cmd-workspace">
      <!-- 左栏：命令目录 -->
      <aside class="cmd-side">
        <el-input
          v-model="query"
          placeholder="搜索命令"
          clearable
          style="margin-bottom:12px"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>

        <div
          v-loading="loading"
          class="cmd-tree"
        >
          <div
            v-if="!filtered.length"
            class="cmd-empty"
          >
            没有匹配的命令
          </div>
          <div
            v-for="g in filtered"
            :key="g.group"
            class="cmd-group"
            :class="{ open: isOpen(g.group) }"
          >
            <button
              class="cmd-group-head"
              @click="toggle(g.group)"
            >
              <el-icon class="cmd-group-chev"><ArrowRight /></el-icon>
              <span class="cmd-group-name">{{ g.group }}</span>
              <span class="cmd-group-count">{{ g.items.length }}</span>
            </button>
            <div
              v-if="isOpen(g.group)"
              class="cmd-group-items"
            >
              <button
                v-for="it in g.items"
                :key="it.id"
                class="cmd-item"
                :class="{ on: activeItem?.id === it.id }"
                @click="pick(it)"
              >
                <span class="cmd-item-label">{{ it.label }}</span>
                <span
                  v-if="it.write"
                  class="cmd-item-write"
                >写</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      <!-- 右栏：执行面板 + 结果 -->
      <section class="cmd-main">
        <template v-if="activeItem">
          <div class="cmd-head">
            <div class="cmd-head-icon">
              <el-icon><Operation v-if="activeItem.write" /><MagicStick v-else /></el-icon>
            </div>
            <div>
              <h2 class="cmd-title">
                {{ activeItem.label }}
                <span
                  v-if="activeItem.write"
                  class="cmd-tag-write"
                >写操作</span>
              </h2>
              <code class="cmd-sub">bili {{ activeItem.argv.join(' ') }}</code>
            </div>
          </div>

          <div class="cmd-panel">
            <div
              v-if="params.length"
              class="cmd-fields"
            >
              <div
                v-for="p in inputs"
                :key="p.key"
                class="cmd-field"
              >
                <label class="cmd-field-label">
                  {{ p.label }}<i v-if="p.pos">*</i>
                </label>
                <el-select
                  v-if="p.type === 'select'"
                  v-model="values[p.key]"
                  style="width:100%"
                >
                  <el-option
                    v-for="c in p.choices"
                    :key="c"
                    :label="c"
                    :value="c"
                  />
                </el-select>
                <el-input
                  v-else
                  v-model="values[p.key]"
                  :type="p.type === 'int' ? 'number' : 'text'"
                  :placeholder="p.ph"
                  clearable
                />
              </div>
              <div
                v-for="p in toggles"
                :key="p.key"
                class="cmd-field"
              >
                <label class="cmd-field-label">{{ p.label }}</label>
                <el-switch v-model="values[p.key]" />
              </div>
            </div>
            <p
              v-else
              class="cmd-muted"
            >
              这条命令没有参数，直接运行。
            </p>

            <div class="cmd-runbar">
              <code class="cmd-preview">{{ preview }}</code>
              <el-button
                link
                size="small"
                @click="copyCmd"
              >
                <el-icon><CopyDocument /></el-icon>
              </el-button>
              <el-checkbox
                v-if="activeItem.write"
                v-model="dryRun"
                size="small"
              >
                安全预览（--dry-run）
              </el-checkbox>
              <el-button
                type="primary"
                :loading="busy"
                :disabled="missing.length > 0"
                @click="run"
              >
                <el-icon
                  v-if="!busy"
                  style="margin-right:5px"
                ><VideoPlay /></el-icon>
                {{ busy ? '执行中' : '运行' }}
              </el-button>
            </div>
            <p
              v-if="missing.length"
              class="cmd-muted"
              style="margin-top:8px"
            >
              还差：{{ missing.join('、') }}
            </p>
          </div>

          <div
            v-if="lastResult"
            class="cmd-result"
          >
            <div class="cmd-result-head">
              <span>执行结果</span>
              <span class="cmd-result-meta">
                {{ lastResult.code === 0 ? '成功' : lastResult.code === null ? '—' : '退出码 ' + lastResult.code }}
                · {{ lastResult.elapsed }}s
                <template v-if="lastResult.timedOut"> · 超时</template>
              </span>
            </div>
            <pre class="cmd-result-body">{{ formatResult() }}</pre>
          </div>
        </template>

        <div
          v-else
          class="cmd-empty-main"
        >
          <el-icon><MagicStick /></el-icon>
          <p>从左侧选一条命令开始</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cmd-workspace {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: 16px;
  align-items: start;
}
.cmd-side {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #eef0f3);
  border-radius: 12px;
  padding: 14px;
  max-height: calc(100vh - 160px);
  overflow-y: auto;
  position: sticky;
  top: 12px;
}
.cmd-tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cmd-empty {
  font-size: 13px;
  color: var(--text-secondary, #8a919f);
  padding: 20px;
  text-align: center;
}
.cmd-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 6px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #1f2329);
  border-radius: 6px;
  text-align: left;
}
.cmd-group-head:hover {
  background: var(--surface-subtle, #f5f6f8);
}
.cmd-group-chev {
  font-size: 12px;
  transition: transform 0.15s;
}
.cmd-group.open .cmd-group-chev {
  transform: rotate(90deg);
}
.cmd-group-name {
  flex: 1;
}
.cmd-group-count {
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
}
.cmd-group-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 14px;
  margin-bottom: 4px;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary, #1f2329);
  border-radius: 6px;
  text-align: left;
}
.cmd-item:hover {
  background: var(--surface-subtle, #f5f6f8);
}
.cmd-item.on {
  background: #eef4ff;
  color: #3b82f6;
}
.cmd-item-label {
  flex: 1;
}
.cmd-item-write {
  font-size: 11px;
  color: #f43f5e;
  background: #ffeef0;
  padding: 1px 5px;
  border-radius: 3px;
}
.cmd-main {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #eef0f3);
  border-radius: 12px;
  padding: 20px;
  min-height: 400px;
}
.cmd-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.cmd-head-icon {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  background: #eef4ff;
  color: #3b82f6;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.cmd-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cmd-tag-write {
  font-size: 11px;
  color: #f43f5e;
  background: #ffeef0;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 500;
}
.cmd-sub {
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
  font-family: monospace;
}
.cmd-panel {
  border: 1px solid var(--border, #eef0f3);
  border-radius: 10px;
  padding: 16px;
}
.cmd-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cmd-field-label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
  margin-bottom: 4px;
}
.cmd-field-label i {
  color: #f43f5e;
  font-style: normal;
}
.cmd-muted {
  font-size: 13px;
  color: var(--text-secondary, #8a919f);
  margin: 0;
}
.cmd-runbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border, #eef0f3);
  flex-wrap: wrap;
}
.cmd-preview {
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  font-family: monospace;
  color: var(--text-secondary, #8a919f);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmd-result {
  margin-top: 16px;
  border: 1px solid var(--border, #eef0f3);
  border-radius: 10px;
  overflow: hidden;
}
.cmd-result-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  background: var(--surface-subtle, #fafbfc);
  border-bottom: 1px solid var(--border, #eef0f3);
}
.cmd-result-meta {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary, #8a919f);
}
.cmd-result-body {
  margin: 0;
  padding: 14px;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
  background: #fafbfc;
}
.cmd-empty-main {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 400px;
  color: var(--text-secondary, #8a919f);
}
.cmd-empty-main .el-icon {
  font-size: 40px;
}
.cmd-empty-main p {
  margin: 0;
  font-size: 14px;
}
@media (max-width: 900px) {
  .cmd-workspace {
    grid-template-columns: 1fr;
  }
  .cmd-side {
    position: static;
    max-height: none;
  }
}
</style>
