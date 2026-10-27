<script setup lang="ts">
import { ArrowLeft, Calendar, Files, Refresh, Search, MagicStick } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { initialCharacters, type Character, type Snapshot, type SnapshotSourceMessage } from "~/utils/mock-data";

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const character = ref<Character>({ ...initialCharacters[0]!, id: "", name: "角色加载中" });
const items = ref<Snapshot[]>([]);
const loading = ref(true);
const query = ref("");
const statusFilter = ref("全部版本状态");
const detail = ref<Snapshot | null>(null);
const creating = ref(false);
const regeneratingId = ref<string | null>(null);
const aiRegeneratingId = ref<string | null>(null);

const filtered = computed(() => items.value.filter((item) => {
  const queryMatches = !query.value || `${item.summary} ${item.range} 第 ${item.number} 份`.toLowerCase().includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "全部版本状态" || item.status === statusFilter.value;
  return queryMatches && statusMatches;
}));
const totalMessages = computed(() => items.value.reduce((sum, item) => sum + item.messages, 0));
const hasFilters = computed(() => Boolean(query.value) || statusFilter.value !== "全部版本状态");

async function loadCharacter() {
  try {
    character.value = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`);
  } catch {
    character.value = { ...initialCharacters[0]!, id: id.value, name: "无法读取角色" };
    ElMessage.error("角色档案读取失败。");
  }
}

async function loadSnapshots(selectedId?: string) {
  loading.value = true;
  try {
    const result = await $fetch<Snapshot[]>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`);
    items.value = result;
    detail.value = (selectedId ? result.find((item) => item.id === selectedId) : undefined) || result[0] || null;
  } catch {
    items.value = [];
    detail.value = null;
    ElMessage.error("阶段总结加载失败，请确认本地数据库已迁移。");
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  query.value = "";
  statusFilter.value = "全部版本状态";
}
function statusTone(status: Snapshot["status"]) {
  return status === "当前版本" ? "pill-green" : "pill-gray";
}
function errorMessage(error: unknown) {
  return error && typeof error === "object" && "statusMessage" in error
    ? String(error.statusMessage)
    : "操作失败，请检查数据库连接。";
}
function evidenceLabel(ids: string[]) {
  return ids.map((sourceId) => {
    const source = detail.value?.sourceMessages?.find((message) => message.id === sourceId);
    return source ? source.id.slice(0, 8) + "（可在下方来源消息中查看）" : sourceId.slice(0, 8);
  }).join("、");
}
function sourceRoleLabel(source: SnapshotSourceMessage) {
  if (source.eventType !== "message") return "平台事件";
  return source.role === "USER" ? "用户" : source.role === "ASSISTANT" ? "角色" : source.role === "TOOL" ? "工具" : "系统";
}
function sourceTime(source: SnapshotSourceMessage) {
  const date = new Date(source.occurredAt);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : source.occurredAt;
}
function showSourceMessage(source: SnapshotSourceMessage) {
  const title = sourceRoleLabel(source) + " · " + sourceTime(source);
  return ElMessageBox.alert(
    source.content,
    title,
    { confirmButtonText: "关闭", type: "info", customClass: "source-message-dialog" },
  );
}
function memoryChangeLabel(action: string, result: string) {
  const actionLabel = action === "ADD" ? "新增" : action === "UPDATE" ? "更新" : action === "INVALIDATE" ? "标记失效" : action;
  const resultLabel = result === "CREATED" ? "已创建" : result === "REPLACED" ? "已替换旧记忆" : result === "INVALIDATED" ? "已失效" : result === "DUPLICATE_IGNORED" ? "忽略重复项" : result === "NOT_APPLIED_REGENERATION" ? "仅供审核（未应用）" : result;
  return actionLabel + " · " + resultLabel;
}

async function createSnapshot() {
  try {
    await ElMessageBox.confirm(
      "生成一份手动归档，保存当前时间范围内的消息来源与长期记忆。手动归档不会调用模型；自动周期任务会在配置模型后执行 AI 提炼。是否继续？",
      "生成阶段总结",
      { confirmButtonText: "确认归档", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  creating.value = true;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, { method: "POST" });
    await loadSnapshots(result.id);
    ElMessage.success("手动已归档到 PostgreSQL，并关联周期内可用的消息来源。");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function regenerateWithAi(snapshot: Snapshot) {
  try {
    await ElMessageBox.confirm(
      "系统会对这份自动归档覆盖的历史周期重新调用模型，并创建同一阶段总结档案的新版本。旧版本会保留；为避免历史重放改写当前长期记忆，本次提出的长期记忆变化只展示供审核，不会自动应用。",
      "AI 重新提炼",
      { confirmButtonText: "排入重新提炼任务", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  aiRegeneratingId.value = snapshot.id;
  try {
    const result = await $fetch<{ jobId: string; status: string; duplicate: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/snapshots`,
      { method: "POST", body: { snapshotId: snapshot.id, mode: "ai" } },
    );
    ElMessage.success(
      result.duplicate
        ? "这份阶段总结已有等待中的 AI 重新提炼任务，无需重复排队。"
        : "AI 重新提炼任务已排队。请到“后台任务”运行 Worker，并查看新生成的总结版本。",
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    aiRegeneratingId.value = null;
  }
}
async function regenerate(snapshot: Snapshot) {
  try {
    await ElMessageBox.confirm(
      "为第 " + snapshot.number + " 份阶段总结创建新版本？旧版本会保留，并标记为已被替代。",
      "重新生成阶段总结",
      { confirmButtonText: "创建新版本", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  regeneratingId.value = snapshot.id;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, {
      method: "POST",
      body: { snapshotId: snapshot.id },
    });
    await loadSnapshots(result.id);
    ElMessage.success("新版本已写入数据库，旧版本仍保留。");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    regeneratingId.value = null;
  }
}

onMounted(() => {
  void loadCharacter();
  void loadSnapshots();
});
watch(id, () => {
  items.value = [];
  detail.value = null;
  void loadCharacter();
  void loadSnapshots();
});
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="`角色管理 / ${character.name} / 阶段总结`"
      title="阶段总结档案"
      description="自动归档会调用配置的 AI 模型提炼对话、事实与偏好变化；手动归档保留当下记录。每份自动记忆变化都应能追溯到原始消息。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          @click="navigateTo('/characters/' + character.id)"
        >
          <el-icon><ArrowLeft /></el-icon>返回驾驶舱
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="creating"
          @click="createSnapshot"
        >
          <el-icon><MagicStick /></el-icon>{{ creating ? "生成中…" : "生成阶段总结" }}
        </button>
      </template>
    </PageHeader>

    <div class="kpi-row is-three">
      <div class="kpi">
        <div class="k">
          历史归档
        </div>
        <div class="v">
          {{ items.length }}<small>份</small>
        </div>
        <div class="foot">
          历史版本保存在数据库，不会被自动覆盖
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          覆盖消息
        </div>
        <div class="v">
          {{ totalMessages }}<small>条</small>
        </div>
        <div class="foot">
          来自已归档周期的原始对话
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          最近生成
        </div>
        <div class="v">
          {{ items[0] ? items[0].date.slice(5, 10) : "—" }}
        </div>
        <div class="foot">
          {{ items[0] ? items[0].date.slice(0, 4) + " 年归档" : "还没有归档过" }}
        </div>
      </div>
    </div>

    <div class="card filter-card">
      <div class="filter-row">
        <div class="filter-grow">
          <el-input
            v-model="query"
            clearable
            placeholder="搜索阶段总结、时间段或编号……"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
        </div>
        <el-select
          v-model="statusFilter"
          style="width:170px"
        >
          <el-option
            label="全部版本状态"
            value="全部版本状态"
          /><el-option
            label="当前版本"
            value="当前版本"
          /><el-option
            label="已被替代"
            value="已被替代"
          />
        </el-select>
        <button
          v-if="hasFilters"
          type="button"
          class="btn sm"
          @click="resetFilters"
        >
          重置筛选
        </button>
      </div>
    </div>

    <div class="snapshot-grid">
      <div>
        <div class="sec-h">
          <h2>归档时间线</h2>
          <span class="sub">{{ filtered.length }}/{{ items.length }} 份</span>
        </div>
        <div class="card snap-list">
          <button
            v-for="snapshot in filtered"
            :key="snapshot.id"
            class="snapshot-item"
            :class="{ selected: detail?.id === snapshot.id }"
            @click="detail = snapshot"
          >
            <div class="snapshot-title">
              <span>第 {{ snapshot.number }} 份阶段总结 <span class="snapshot-version">· v{{ snapshot.version }}</span></span><span
                class="pill"
                :class="statusTone(snapshot.status)"
              >{{ snapshot.status }}</span>
            </div>
            <div class="snapshot-summary">
              {{ snapshot.summary }}
            </div>
            <div class="snapshot-meta">
              <span><el-icon><Calendar /></el-icon>{{ snapshot.date }}</span><span>覆盖 {{ snapshot.messages }} 条消息</span><span>{{ snapshot.events }} 个事件</span>
            </div>
          </button>
          <div
            v-if="loading"
            class="snap-skeleton"
          >
            <div
              v-for="n in 3"
              :key="n"
              class="sk"
              style="height:74px"
            />
          </div>
          <div
            v-else-if="!filtered.length"
            class="card-empty"
          >
            <el-icon><Files /></el-icon>
            <span>{{ hasFilters ? "没有符合条件的阶段总结" : "还没有归档记录" }}</span>
            <span>{{ hasFilters ? "换个搜索词或把状态筛选切回全部" : "点右上角「生成阶段总结」手动归档当前周期" }}</span>
          </div>
        </div>
      </div>

      <div>
        <div class="sec-h">
          <h2>阶段总结详情</h2>
          <span class="sub">{{ detail ? "v" + detail.version : "未选择" }}</span>
        </div>
        <div class="card detail-card">
          <template v-if="detail">
            <div class="detail-heading">
              <div>
                <div class="mini-label">
                  阶段总结详情
                </div><h2 class="detail-title">
                  第 {{ detail.number }} 份阶段总结
                </h2>
              </div><span
                class="pill"
                :class="statusTone(detail.status)"
              >{{ detail.status }}</span>
            </div>
            <p class="detail-summary">
              {{ detail.summary }}
            </p>
            <div class="metric-row">
              <span>覆盖时间段</span><span class="metric-value">{{ detail.range }}</span>
            </div>
            <div class="metric-row">
              <span>生成时间</span><span class="metric-value">{{ detail.date }}</span>
            </div>
            <div class="metric-row">
              <span>来源消息</span><span class="metric-value">{{ detail.messages }} 条</span>
            </div>
            <div class="metric-row">
              <span>提炼事件</span><span class="metric-value">{{ detail.events }} 项</span>
            </div>
            <section class="source-section">
              <div class="analysis-heading">
                <div>
                  <div class="mini-label">
                    SOURCE TRACEABILITY
                  </div>
                  <h3 class="block-title">
                    来源消息与原文
                  </h3>
                </div>
                <span class="pill pill-blue">{{ detail.sourceMessages?.length || 0 }} 条</span>
              </div>
              <p class="source-hint">
                下面这些消息是实际关联到本份阶段总结的原始记录；AI 分析条目里的「来源消息」编号可以和它们对应。
              </p>
              <div
                v-if="detail.sourceMessages?.length"
                class="source-list"
              >
                <article
                  v-for="source in detail.sourceMessages"
                  :key="source.id"
                  class="source-item"
                >
                  <div class="source-item-top">
                    <span
                      class="pill"
                      :class="source.role === 'USER' ? 'pill-green' : source.role === 'ASSISTANT' ? 'pill-blue' : 'pill-gray'"
                    >{{ sourceRoleLabel(source) }}</span>
                    <span class="source-time">{{ sourceTime(source) }}</span>
                  </div>
                  <div class="source-conversation">
                    {{ source.conversationTitle || "未命名会话" }} · #{{ source.id.slice(0, 8) }}
                  </div>
                  <p class="source-preview">
                    {{ source.content }}
                  </p>
                  <button
                    type="button"
                    class="card-link"
                    @click="showSourceMessage(source)"
                  >
                    查看完整原文
                  </button>
                </article>
              </div>
              <div
                v-else
                class="card-empty"
              >
                <el-icon><Files /></el-icon>
                <span>没有可追溯的原始消息</span>
                <span>可能是旧版本、纯记忆归档，或来源消息已被清理</span>
              </div>
            </section>
            <div
              v-if="detail.analysis"
              class="analysis-sections"
            >
              <div class="analysis-heading">
                <div>
                  <div class="mini-label">
                    AI EXTRACTED
                  </div>
                  <h3 class="block-title">
                    AI 提炼结果
                  </h3>
                </div>
                <span
                  v-if="detail.model?.name"
                  class="pill pill-purple"
                >{{ detail.model.name }}</span>
              </div>
              <section
                v-if="detail.analysis.importantEvents.length"
                class="analysis-block"
              >
                <h3>重要事件</h3>
                <article
                  v-for="(item, index) in detail.analysis.importantEvents"
                  :key="'event-' + index"
                  class="analysis-item"
                >
                  <strong>{{ item.title }}</strong><p>{{ item.detail }}</p>
                  <small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
                </article>
              </section>
              <section
                v-if="detail.analysis.factAndPreferenceChanges.length"
                class="analysis-block"
              >
                <h3>事实与偏好变化</h3>
                <article
                  v-for="(item, index) in detail.analysis.factAndPreferenceChanges"
                  :key="'fact-' + index"
                  class="analysis-item"
                >
                  <strong>{{ item.changeType }}</strong><p>{{ item.description }}</p>
                  <small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
                </article>
              </section>
              <section
                v-if="detail.analysis.relationshipChanges.length"
                class="analysis-block"
              >
                <h3>关系变化</h3>
                <article
                  v-for="(item, index) in detail.analysis.relationshipChanges"
                  :key="'relation-' + index"
                  class="analysis-item"
                >
                  <p>{{ item.description }}</p><small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
                </article>
              </section>
              <section
                v-if="detail.analysis.goalsAndCommitments.length"
                class="analysis-block"
              >
                <h3>目标与承诺</h3>
                <article
                  v-for="(item, index) in detail.analysis.goalsAndCommitments"
                  :key="'goal-' + index"
                  class="analysis-item"
                >
                  <strong>{{ item.status }}</strong><p>{{ item.description }}</p>
                  <small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
                </article>
              </section>
              <section
                v-if="detail.analysis.unresolvedTopics.length"
                class="analysis-block"
              >
                <h3>待跟进话题</h3>
                <article
                  v-for="(item, index) in detail.analysis.unresolvedTopics"
                  :key="'topic-' + index"
                  class="analysis-item"
                >
                  <p>{{ item.description }}</p><small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
                </article>
              </section>
              <section
                v-if="detail.analysis.differencesFromPrevious.length"
                class="analysis-block"
              >
                <h3>相较上一份总结</h3>
                <ul>
                  <li
                    v-for="(item, index) in detail.analysis.differencesFromPrevious"
                    :key="'diff-' + index"
                  >
                    {{ item }}
                  </li>
                </ul>
              </section>
              <section
                v-if="detail.analysis.memoryChangesApplied.length"
                class="analysis-block"
              >
                <h3>长期记忆变化与审核建议</h3>
                <article
                  v-for="(item, index) in detail.analysis.memoryChangesApplied"
                  :key="'change-' + index"
                  class="analysis-item"
                >
                  <strong>{{ memoryChangeLabel(item.action, item.result) }}</strong>
                  <p>{{ item.content || '关联记忆 ' + (item.memoryItemId || item.supersededMemoryId || '—') }}</p>
                  <small v-if="item.evidenceMessageIds?.length">依据消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
                </article>
              </section>
            </div>
            <div
              v-else
              class="info-callout detail-callout"
            >
              <el-icon><Files /></el-icon><span>这是一份手动或旧版总结，当前保存的是结构化记录；自动归档的 AI 分析会显示在这里。</span>
            </div>
            <div
              v-if="detail.kind === 'AUTOMATIC'"
              class="info-callout detail-callout"
            >
              <span>AI 重新提炼会对同一历史周期创建新版本，旧版本继续保留。本次提出的长期记忆变化仅供审核，不会自动覆盖当前记忆。</span>
            </div>
            <button
              v-if="detail.kind === 'AUTOMATIC'"
              type="button"
              class="btn detail-action"
              :disabled="aiRegeneratingId === detail.id || regeneratingId === detail.id"
              @click="regenerateWithAi(detail)"
            >
              <el-icon><Refresh /></el-icon>{{ aiRegeneratingId === detail.id ? "重新提炼中…" : "AI 重新提炼此版本" }}
            </button>
            <button
              v-else
              type="button"
              class="btn detail-action"
              :disabled="regeneratingId === detail.id || aiRegeneratingId === detail.id"
              @click="regenerate(detail)"
            >
              <el-icon><Refresh /></el-icon>{{ regeneratingId === detail.id ? "重新生成中…" : "重新生成此版本" }}
            </button>
          </template>
          <div
            v-else-if="loading"
            class="detail-skeleton"
          >
            <div
              v-for="n in 5"
              :key="n"
              class="sk"
              :style="{ height: n === 1 ? '22px' : '56px', width: n === 1 ? '46%' : '100%' }"
            />
          </div>
          <div
            v-else
            class="card-empty"
          >
            <el-icon><Files /></el-icon>
            <span>还没有选中的总结</span>
            <span>从左侧时间线点一份阶段总结，这里会展开总结、来源消息与 AI 提炼结果</span>
          </div>
        </div>
      </div>
    </div>
    <p class="footer-note">
      自动归档由独立 Worker 调用模型生成；模型输出中的消息来源会先校验再采纳。手动归档与旧版总结不代表 AI 总结。
    </p>
  </div>
</template>

<style scoped>
/* 筛选工具条 */
.filter-card{padding:13px 16px;margin-bottom:18px}

/* 两栏：列表窄、详情宽（详情要读长文本） */
.snapshot-grid{display:grid;grid-template-columns:minmax(0,.82fr) minmax(0,1.18fr);gap:18px;align-items:start}

/* ── 归档时间线：卡片内的行式列表 ───────────────────── */
.snap-list{padding:5px 0}
.snapshot-item{border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;padding:13px 18px}
.snapshot-item + .snapshot-item{margin-top:0}
.snapshot-item:last-child{border-bottom:0}
.snapshot-item:hover{background:var(--surface-2)}
.snapshot-item.selected{background:var(--brand-soft);box-shadow:inset 2px 0 0 var(--brand)}
.snapshot-version{color:var(--dim);font-weight:500}
.snapshot-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:10px;color:var(--faint);font-size:12px}
.snapshot-meta span{display:flex;align-items:center;gap:5px}
.snap-skeleton{display:flex;flex-direction:column;gap:8px;padding:14px 18px}

/* ── 阶段总结详情 ──────────────────────────────────────── */
.detail-card{padding:16px 20px 18px}
.mini-label{color:var(--faint);font:400 12px/1 Consolas,monospace;letter-spacing:.03em}
.detail-title{margin:6px 0 0;color:var(--text);font-size:16px;font-weight:700;line-height:1.35}
.detail-summary{margin:12px 0 4px;color:var(--text-2);font-size:14px;line-height:1.8}
.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.block-title{margin:6px 0 0;color:var(--text);font-size:14px;font-weight:700}
.analysis-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
.detail-callout{margin-top:14px}
.detail-action{width:100%;margin-top:14px}
.detail-skeleton{display:flex;flex-direction:column;gap:10px;padding:2px}

/* ── AI 提炼结果 ───────────────────────────────────── */
.analysis-sections{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
.analysis-block{margin-top:16px}
.analysis-block h3{margin:0 0 8px;color:var(--text-2);font-size:12px;font-weight:700}
.analysis-item{margin-top:7px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);padding:10px 12px}
.analysis-item strong{color:var(--text-2);font-size:12px}
.analysis-item p{margin:5px 0 0;color:var(--dim);font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.analysis-item small{display:block;margin-top:6px;color:var(--faint);font-size:12px}
.analysis-block ul{margin:0;padding-left:18px;color:var(--dim);font-size:12px;line-height:1.9}

/* ── 来源消息 ──────────────────────────────────────── */
.source-section{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
.source-hint{margin:0 0 10px;color:var(--dim);font-size:12px;line-height:1.8}
.source-list{display:flex;flex-direction:column;gap:8px}
.source-item{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);padding:11px 12px}
.source-item-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.source-time,.source-conversation{color:var(--faint);font-size:12px}
.source-conversation{margin-top:7px}
.source-preview{display:-webkit-box;overflow:hidden;margin:7px 0 6px;color:var(--text-2);font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:3}

@media(max-width:1150px){.snapshot-grid{grid-template-columns:minmax(0,1fr)}}
</style>
