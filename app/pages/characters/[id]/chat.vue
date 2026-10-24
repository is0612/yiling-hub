<script setup lang="ts">
import { ChatDotRound, Clock, CopyDocument, Download, Plus, Promotion, Refresh, Reading, Search, Setting, User } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type ChatCharacter = {
  id: string;
  name: string;
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
  chatApiBaseUrl: string;
  chatApiKeyConfigured: boolean;
  chatApiKeySource: "character" | "environment" | "missing";
};
type MemoryScopeOrigin = "character" | "private";
type ChatMemorySource = { id: string; category: string; content: string; scope?: MemoryScopeOrigin };
type ChatSnapshotSource = { id: string; summary: string; periodStart: string; periodEnd: string; version: number; scope?: MemoryScopeOrigin };
type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  occurredAt: string;
  sources?: { memories: ChatMemorySource[]; snapshots: ChatSnapshotSource[] };
};
type ConversationSummary = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
};
type ChatHistoryResponse = {
  character: ChatCharacter;
  modelConfigured: boolean;
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  messages: ChatMessage[];
};
type ChatExportPage = {
  conversationId: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  page: number;
  pageSize: number;
  total: number;
  messages: ChatMessage[];
};
type ChatSendResponse = {
  conversationId: string;
  title: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  model: { name: string; provider: string; promptTemplateVersion: string };
  retrieval: { memoriesAvailable: number; snapshotsAvailable: number; privateScopeActive?: boolean };
};

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const character = ref<ChatCharacter | null>(null);
const modelConfigured = ref(false);
const conversations = ref<ConversationSummary[]>([]);
const conversationView = ref<"ACTIVE" | "ARCHIVED">("ACTIVE");
const conversationSearchDraft = ref("");
const conversationSearch = ref("");
const conversationId = ref<string | null>(null);
const messages = ref<ChatMessage[]>([]);
const draft = ref("");
const loading = ref(false);
const sending = ref(false);
const exporting = ref(false);
const modelSettingsOpen = ref(false);
const modelSettingsSaving = ref(false);
const draftChatModel = ref("");
const draftChatTemperature = ref(0.7);
const draftChatMaxTokens = ref(1800);
const draftChatApiBaseUrl = ref("https://api.openai.com/v1");
const draftChatApiKey = ref("");
const clearSavedApiKey = ref(false);
const testingApi = ref(false);
const messagePanel = ref<HTMLElement | null>(null);
const activeConversation = computed(() => conversations.value.find((item) => item.id === conversationId.value) ?? null);

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) return String(error.statusMessage);
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "尚无消息";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function scrollToLatest() {
  await nextTick();
  if (messagePanel.value) messagePanel.value.scrollTop = messagePanel.value.scrollHeight;
}

async function loadCharacter() {
  character.value = await $fetch<ChatCharacter>("/api/characters/" + encodeURIComponent(id.value));
}

function openModelSettings() {
  draftChatModel.value = character.value?.chatModel ?? "";
  draftChatTemperature.value = character.value?.chatTemperature ?? 0.7;
  draftChatMaxTokens.value = character.value?.chatMaxTokens ?? 1800;
  draftChatApiBaseUrl.value = character.value?.chatApiBaseUrl ?? "https://api.openai.com/v1";
  draftChatApiKey.value = "";
  clearSavedApiKey.value = false;
  modelSettingsOpen.value = true;
}

async function saveModelSettings(keepOpen = false): Promise<boolean> {
  if (modelSettingsSaving.value || !character.value) return false;
  modelSettingsSaving.value = true;
  try {
    character.value = await $fetch<ChatCharacter>("/api/characters/" + encodeURIComponent(id.value), {
      method: "PATCH",
      body: {
        chatModel: draftChatModel.value.trim(),
        chatTemperature: draftChatTemperature.value,
        chatMaxTokens: draftChatMaxTokens.value,
        chatApiBaseUrl: draftChatApiBaseUrl.value.trim(),
        chatApiKey: draftChatApiKey.value,
        clearApiKey: clearSavedApiKey.value && !draftChatApiKey.value.trim(),
      },
    });
    draftChatApiKey.value = "";
    clearSavedApiKey.value = false;
    await loadHistory(conversationId.value);
    if (!keepOpen) {
      modelSettingsOpen.value = false;
      ElMessage.success("本角色 API 与模型参数已保存。API Key 已由服务端加密保存，不会回传到网页。");
    }
    return true;
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "保存 API 与模型参数失败。"));
    return false;
  } finally {
    modelSettingsSaving.value = false;
  }
}

async function testApiConnection() {
  if (testingApi.value || modelSettingsSaving.value) return;
  testingApi.value = true;
  try {
    const saved = await saveModelSettings(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; model?: string; provider?: string; elapsedMs?: number }>(
      "/api/characters/" + encodeURIComponent(id.value) + "/chat/test-connection",
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? "（" + result.elapsedMs + " ms）" : ""));
    } else {
      ElMessage.error(result.message || "API 连通性测试失败。");
    }
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "API 连通性测试失败，请检查地址、Key 和模型名称。"));
  } finally {
    testingApi.value = false;
  }
}

async function renameConversation(item: ConversationSummary) {
  if (sending.value) return;
  let title: string;
  try {
    const result = await ElMessageBox.prompt("输入新的会话标题（最多 255 个字符）。", "重命名会话", {
      inputValue: item.title,
      inputValidator: (value) => {
        if (!value.trim()) return "标题不能为空。";
        if (value.trim().length > 255) return "标题不能超过 255 个字符。";
        return true;
      },
      confirmButtonText: "保存标题",
      cancelButtonText: "取消",
    });
    title = result.value.trim();
  } catch {
    return;
  }
  if (!title || title === item.title) return;
  try {
    const updated = await $fetch<{ id: string; title: string; status: "ACTIVE" | "ARCHIVED"; updatedAt: string }>(
      "/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(item.id),
      { method: "PATCH", body: { title } },
    );
    conversations.value = conversations.value.map((entry) => entry.id === updated.id
      ? { ...entry, title: updated.title, updatedAt: updated.updatedAt }
      : entry);
    ElMessage.success("会话标题已更新，并已记录审计日志。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "重命名会话失败。"));
  }
}

async function copyMessage(content: string) {
  try {
    await navigator.clipboard.writeText(content);
    ElMessage.success("回复已复制。");
  } catch {
    ElMessage.error("复制失败，请检查浏览器剪贴板权限。");
  }
}

async function loadHistory(requestedId?: string | null) {
  const params = new URLSearchParams({ status: conversationView.value });
  if (requestedId) params.set("conversationId", requestedId);
  if (conversationSearch.value) params.set("q", conversationSearch.value);
  const data = await $fetch<ChatHistoryResponse>("/api/characters/" + encodeURIComponent(id.value) + "/chat?" + params.toString());
  modelConfigured.value = data.modelConfigured;
  conversations.value = data.conversations;
  conversationId.value = data.selectedConversationId;
  messages.value = data.messages;
  await scrollToLatest();
}

async function reload() {
  loading.value = true;
  conversationView.value = route.query.view === "archived" ? "ARCHIVED" : "ACTIVE";
  conversationSearch.value = typeof route.query.q === "string" ? route.query.q.trim().slice(0, 120) : "";
  conversationSearchDraft.value = conversationSearch.value;
  try {
    await Promise.all([
      loadCharacter(),
      loadHistory(typeof route.query.conversationId === "string" ? route.query.conversationId : null),
    ]);
    const selectedId = conversationId.value;
    if (selectedId && route.query.conversationId !== selectedId) {
      await navigateTo({ path: route.path, query: { ...route.query, conversationId: selectedId } }, { replace: true });
    }
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "读取角色对话失败，请检查本地数据库和开发服务器。"));
  } finally {
    loading.value = false;
  }
}

async function openConversation(item: ConversationSummary) {
  if (sending.value || item.id === conversationId.value) return;
  loading.value = true;
  try {
    await loadHistory(item.id);
    await navigateTo({ path: route.path, query: { ...route.query, conversationId: item.id } });
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "读取会话失败。"));
  } finally {
    loading.value = false;
  }
}

async function startNewConversation() {
  if (sending.value) return;
  conversationView.value = "ACTIVE";
  conversationSearch.value = "";
  conversationSearchDraft.value = "";
  conversationId.value = null;
  messages.value = [];
  draft.value = "";
  const nextQuery = { ...route.query };
  delete nextQuery.conversationId;
  delete nextQuery.q;
  delete nextQuery.view;
  await navigateTo({ path: route.path, query: nextQuery });
  await loadHistory(null);
  conversationId.value = null;
  messages.value = [];
}

async function changeConversationView(status: "ACTIVE" | "ARCHIVED") {
  if (sending.value) return;
  const nextQuery = { ...route.query };
  delete nextQuery.conversationId;
  if (status === "ARCHIVED") nextQuery.view = "archived";
  else delete nextQuery.view;
  await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
  await reload();
}

async function searchConversations() {
  if (sending.value) return;
  const term = conversationSearchDraft.value.trim().slice(0, 120);
  const nextQuery = { ...route.query };
  delete nextQuery.conversationId;
  if (term) nextQuery.q = term;
  else delete nextQuery.q;
  await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
  await reload();
}

async function toggleConversationStatus(item: ConversationSummary) {
  if (sending.value) return;
  const nextStatus = conversationView.value === "ACTIVE" ? "ARCHIVED" : "ACTIVE";
  if (nextStatus === "ARCHIVED") {
    try {
      await ElMessageBox.confirm(
        "归档不会删除对话内容；之后可以从归档列表恢复。",
        "归档会话",
        { confirmButtonText: "确认归档", cancelButtonText: "取消", type: "warning" },
      );
    } catch {
      return;
    }
  }

  try {
    await $fetch("/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(item.id), {
      method: "PATCH",
      body: { status: nextStatus },
    });
    ElMessage.success(nextStatus === "ARCHIVED" ? "会话已归档，消息和来源记录均已保留。" : "会话已恢复。");
    const nextQuery = { ...route.query };
    delete nextQuery.conversationId;
    await navigateTo({ path: route.path, query: nextQuery }, { replace: true });
    await reload();
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "更新会话状态失败。"));
  }
}

async function exportConversation() {
  const exportConversationId = conversationId.value;
  if (!exportConversationId || !messages.value.length || exporting.value) return;
  exporting.value = true;
  try {
    const exportMessages: ChatMessage[] = [];
    let expectedTotal = 0;
    for (let page = 1; ; page += 1) {
      const result = await $fetch<ChatExportPage>(
        "/api/characters/" + encodeURIComponent(id.value) + "/chat/" + encodeURIComponent(exportConversationId) +
          "?page=" + page + "&pageSize=200",
      );
      if (page === 1) expectedTotal = result.total;
      exportMessages.push(...result.messages);
      if (exportMessages.length >= expectedTotal || result.messages.length === 0) break;
      if (page > Math.ceil(expectedTotal / 200) + 1) throw new Error("导出分页没有正常结束，请刷新后重试。");
    }
    if (!exportMessages.length) {
      ElMessage.info("当前会话没有可导出的消息。");
      return;
    }

    const title = activeConversation.value?.title || "对话记录";
    const lines = [
      "# " + title,
      "",
      "- 角色：" + (character.value?.name || "未知角色"),
      "- 导出时间：" + new Date().toISOString(),
      "- 消息数量：" + exportMessages.length,
      "",
      "---",
      "",
    ];

    for (const message of exportMessages) {
      lines.push("## " + (message.role === "USER" ? "用户" : (character.value?.name || "角色")));
      lines.push("");
      lines.push("发生时间：" + message.occurredAt);
      lines.push("");
      lines.push(message.content);
      lines.push("");
      const sources = messageSources(message);
      if (sources.memories.length || sources.snapshots.length) {
        lines.push("引用来源：");
        for (const memory of sources.memories) {
          const scopeLabel = memory.scope === "private" ? "私人记忆" : "角色全局记忆";
          lines.push("- " + scopeLabel + "（" + memory.category + "）：" + memory.content + " [ID: " + memory.id + "]");
        }
        for (const snapshot of sources.snapshots) {
          const scopeLabel = snapshot.scope === "private" ? "私人记忆" : "角色全局记忆";
          lines.push("- " + scopeLabel + "快照 v" + snapshot.version + "（" + snapshot.periodStart + " — " + snapshot.periodEnd + "）：" + snapshot.summary + " [ID: " + snapshot.id + "]");
        }
        lines.push("");
      }
    }

    const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "对话记录";
    const objectUrl = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = safeName + ".md";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    ElMessage.success("已导出完整对话，共 " + exportMessages.length + " 条消息，包含可追溯的记忆来源。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "导出对话失败，请稍后重试。"));
  } finally {
    exporting.value = false;
  }
}
function messageSources(message: ChatMessage) {
  return message.role === "ASSISTANT"
    ? { memories: message.sources?.memories ?? [], snapshots: message.sources?.snapshots ?? [] }
    : { memories: [], snapshots: [] };
}

async function sendMessage() {
  const content = draft.value.trim();
  if (!content || sending.value) return;
  if (conversationView.value === "ARCHIVED") {
    ElMessage.info("归档会话为只读状态，请先恢复会话再继续发送消息。");
    return;
  }
  if (!modelConfigured.value) {
    ElMessage.warning("请先点击右上角“模型参数”，填写并保存 API 地址、API Key 和模型名称。");
    return;
  }

  sending.value = true;
  draft.value = "";
  try {
    const result = await $fetch<ChatSendResponse>("/api/characters/" + encodeURIComponent(id.value) + "/chat", {
      method: "POST",
      body: { message: content, ...(conversationId.value ? { conversationId: conversationId.value } : {}) },
    });

    conversationId.value = result.conversationId;
    messages.value.push(result.userMessage, result.assistantMessage);
    const lastMessageAt = result.assistantMessage.occurredAt;
    const oldIndex = conversations.value.findIndex((item) => item.id === result.conversationId);
    const oldMessageCount = oldIndex >= 0 ? conversations.value[oldIndex]!.messageCount : 0;
    const summary: ConversationSummary = {
      id: result.conversationId,
      title: result.title,
      lastMessageAt,
      updatedAt: lastMessageAt,
      messageCount: oldMessageCount + 2,
    };
    conversations.value = [summary, ...conversations.value.filter((item) => item.id !== summary.id)].slice(0, 20);

    await navigateTo({ path: route.path, query: { ...route.query, conversationId: result.conversationId } }, { replace: true });
    await scrollToLatest();
  } catch (error) {
    draft.value = content;
    ElMessage.error(getErrorMessage(error, "模型回复失败，请检查模型配置或服务端日志。"));
  } finally {
    sending.value = false;
  }
}

onMounted(() => void reload());
</script>

<template>
  <div class="page-wrap chat-page">
    <PageHeader eyebrow="工作空间 / AI 对话" :title="character ? character.name + ' · AI 对话' : 'AI 对话'" description="基于当前角色设定、最近对话和相关长期记忆生成回复。会话与消息会保存到 PostgreSQL。">
      <template #actions>
        <el-button :disabled="loading || sending" @click="void reload()"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button :disabled="loading || sending || !character" @click="openModelSettings"><el-icon><Setting /></el-icon>模型参数</el-button>
        <el-button type="primary" plain :disabled="sending" @click="void startNewConversation()"><el-icon><Plus /></el-icon>新建对话</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="!modelConfigured"
      title="模型尚未配置"
      description="在右上角“模型参数”中填写兼容 OpenAI Chat Completions 的 API 地址、Key 和模型名称。配置保存在当前角色中，Key 由服务端加密保存。"
      type="warning"
      :closable="false"
      show-icon
      class="chat-alert"
    />

    <div class="chat-layout" v-loading="loading">
      <aside class="surface conversation-sidebar">
        <div class="sidebar-heading">
          <span>{{ conversationView === "ACTIVE" ? "历史会话" : "归档会话" }}</span>
          <el-tag type="info" effect="plain" size="small">{{ conversations.length }}</el-tag>
        </div>
        <div class="conversation-filters">
          <el-select v-model="conversationView" size="small" aria-label="会话状态" @change="changeConversationView">
            <el-option label="正常会话" value="ACTIVE" />
            <el-option label="归档会话" value="ARCHIVED" />
          </el-select>
          <el-input
            v-model="conversationSearchDraft"
            size="small"
            clearable
            maxlength="120"
            placeholder="搜索标题或消息内容"
            aria-label="搜索历史会话"
            @keyup.enter="void searchConversations()"
          >
            <template #append>
              <el-button aria-label="搜索会话" @click="void searchConversations()"><el-icon><Search /></el-icon></el-button>
            </template>
          </el-input>
        </div>
        <div v-for="item in conversations" :key="item.id" class="conversation-entry">
          <button
            class="conversation-item"
            :class="{ selected: item.id === conversationId }"
            type="button"
            @click="void openConversation(item)"
          >
            <span class="conversation-icon"><el-icon><ChatDotRound /></el-icon></span>
            <span class="conversation-copy">
              <strong>{{ item.title }}</strong>
              <small>{{ formatTime(item.lastMessageAt) }} · {{ item.messageCount }} 条消息</small>
            </span>
          </button>
          <el-button text size="small" :disabled="sending" @click.stop="void renameConversation(item)">改名</el-button>
          <el-button text size="small" :disabled="sending" @click.stop="void toggleConversationStatus(item)">
            {{ conversationView === "ACTIVE" ? "归档" : "恢复" }}
          </el-button>
        </div>
        <el-empty v-if="!conversations.length" description="还没有会话" :image-size="64" />
        <p class="sidebar-note">对话会保存到本地数据库；不同角色使用各自独立的记忆范围。</p>
      </aside>

      <section class="surface conversation-panel">
        <div class="conversation-toolbar">
          <div>
            <strong>{{ activeConversation?.title || "新对话" }}</strong>
            <span>角色：{{ character?.name || "读取中" }}</span>
          </div>
          <div class="conversation-toolbar-actions">
            <el-button size="small" :loading="exporting" :disabled="!conversationId || !messages.length" @click="void exportConversation()"><el-icon><Download /></el-icon>导出 Markdown</el-button>
            <el-tag :type="modelConfigured ? 'success' : 'warning'" effect="plain">{{ modelConfigured ? "模型已配置" : "等待配置" }}</el-tag>
          </div>
        </div>

        <div ref="messagePanel" class="message-list">
          <div v-if="!messages.length" class="chat-welcome">
            <div class="welcome-mark"><el-icon><Reading /></el-icon></div>
            <h2>开始一段新对话</h2>
            <p>发送一条消息，角色会参考自己的设定，并按当前话题检索相关记忆和历史快照。</p>
          </div>
          <article
            v-for="message in messages"
            :key="message.id"
            class="message-row"
            :class="message.role === 'USER' ? 'from-user' : 'from-assistant'"
          >
            <div class="message-avatar">
              <el-icon v-if="message.role === 'USER'"><User /></el-icon>
              <el-icon v-else><ChatDotRound /></el-icon>
            </div>
            <div class="message-main">
              <div class="message-meta">
                <strong>{{ message.role === "USER" ? "你" : character?.name || "角色" }}</strong>
                <time>{{ formatTime(message.occurredAt) }}</time>
                <el-button v-if="message.role === 'ASSISTANT'" text size="small" @click="void copyMessage(message.content)">
                  <el-icon><CopyDocument /></el-icon>复制
                </el-button>
              </div>
              <div class="message-bubble">{{ message.content }}</div>
              <div v-if="message.role === 'ASSISTANT' && (messageSources(message).memories.length || messageSources(message).snapshots.length)" class="sources-panel">
                <div class="sources-title"><el-icon><Reading /></el-icon>本次回复引用的记忆来源</div>
                <div v-for="source in messageSources(message).memories" :key="source.id" class="source-item">
                  <el-tag size="small" effect="plain">{{ source.category }}</el-tag>
                  <el-tag v-if="source.scope === 'private'" size="small" type="warning" effect="plain">私人</el-tag>
                  <span>{{ source.content }}</span>
                </div>
                <div v-for="source in messageSources(message).snapshots" :key="source.id" class="source-item">
                  <el-tag size="small" type="success" effect="plain">快照 v{{ source.version }}</el-tag>
                  <el-tag v-if="source.scope === 'private'" size="small" type="warning" effect="plain">私人</el-tag>
                  <span>{{ source.summary }}</span>
                </div>
              </div>
            </div>
          </article>
          <div v-if="sending" class="thinking-row"><span class="thinking-dot" /><span>角色正在结合相关记忆思考……</span></div>
        </div>

        <el-alert
          v-if="conversationView === 'ARCHIVED'"
          title="当前是归档会话，只能查看和导出"
          description="恢复该会话后才能继续发送消息。归档不会删除历史记录。"
          type="info"
          :closable="false"
          show-icon
        />
        <div class="composer">
          <el-input
            :disabled="conversationView === 'ARCHIVED' || sending"
            v-model="draft"
            type="textarea"
            :rows="3"
            :maxlength="8000"
            resize="none"
            placeholder="输入你想和角色说的话……（Ctrl + Enter 发送）"
            @keydown.ctrl.enter.prevent="void sendMessage()"
          />
          <div class="composer-footer">
            <span><el-icon><Clock /></el-icon> {{ conversationView === "ARCHIVED" ? "归档会话为只读；恢复后可以继续聊天。" : "只使用匹配的角色全局记忆、你自己的私人记忆和快照；其他人的私人记忆不会进入上下文。" }}</span>
            <el-button type="primary" :loading="sending" :disabled="!draft.trim() || !modelConfigured || conversationView === 'ARCHIVED'" @click="void sendMessage()">
              <el-icon><Promotion /></el-icon>发送消息
            </el-button>
          </div>
        </div>
      </section>
    </div>

    <el-dialog v-model="modelSettingsOpen" title="本角色 API 设置" width="560px" destroy-on-close>
      <el-form label-position="top">
        <el-form-item label="API Base URL" required>
          <el-input v-model="draftChatApiBaseUrl" maxlength="500" placeholder="https://api.deepseek.com/v1" />
          <p class="model-settings-hint">填写 API 根地址，不要追加 /chat/completions。必须使用 HTTPS；HTTP 仅允许本机地址。</p>
        </el-form-item>
        <el-form-item label="API Key">
          <el-input
            v-model="draftChatApiKey"
            type="password"
            show-password
            autocomplete="new-password"
            maxlength="8192"
            :placeholder="character?.chatApiKeySource === 'character' ? '已加密保存；留空表示保持不变' : character?.chatApiKeySource === 'environment' ? '当前使用服务端默认 Key；填写可覆盖' : '请填写 API Key'"
          />
          <p class="model-settings-hint">
            {{ character?.chatApiKeySource === "character" ? "此角色已保存 API Key。留空可保持现有 Key，不会在网页中显示原文。" : character?.chatApiKeySource === "environment" ? "当前使用服务端默认 Key。输入新 Key 后会为本角色单独保存。" : "Key 只会提交到本机服务端，并使用 AES-256-GCM 加密后保存；不会回传给网页。" }}
          </p>
          <el-checkbox v-if="character?.chatApiKeySource === 'character'" v-model="clearSavedApiKey">移除此角色单独保存的 API Key</el-checkbox>
        </el-form-item>
        <el-form-item label="模型名称" required>
          <el-input v-model="draftChatModel" maxlength="120" show-word-limit placeholder="例如 deepseek-chat、gpt-4o-mini" />
        </el-form-item>
        <el-form-item label="温度（Temperature）">
          <el-slider v-model="draftChatTemperature" :min="0" :max="2" :step="0.1" show-input />
        </el-form-item>
        <el-form-item label="最大输出 Token">
          <el-input-number v-model="draftChatMaxTokens" :min="256" :max="8192" :step="256" />
          <p class="model-settings-hint">数值越大，回复可能越长，也会增加单次请求的消耗。</p>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="modelSettingsOpen = false">取消</el-button>
        <el-button :loading="testingApi" :disabled="modelSettingsSaving || testingApi" @click="void testApiConnection()">保存并测试 API</el-button>
        <el-button type="primary" :loading="modelSettingsSaving" :disabled="testingApi" @click="void saveModelSettings()">保存设置</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.chat-alert{margin:-7px 0 18px}
.model-settings-hint{margin:6px 0 0;color:#9098aa;font-size:11px;line-height:1.7}
.chat-layout{display:grid;grid-template-columns:minmax(230px,290px) minmax(0,1fr);gap:16px;min-height:620px}
.conversation-sidebar{padding:16px;align-self:stretch;min-width:0}
.sidebar-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;color:#46516b;font-size:12px;font-weight:800}
.conversation-filters{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.conversation-entry{display:flex;align-items:center;gap:3px;min-width:0}
.conversation-item{display:flex;align-items:flex-start;gap:10px;flex:1;min-width:0;width:100%;padding:11px 7px;border:1px solid transparent;border-radius:11px;background:transparent;text-align:left;cursor:pointer;color:#53617b}
.conversation-toolbar-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.conversation-item:hover{background:#fafaff}
.conversation-item.selected{border-color:#e5e1ff;background:#f5f3ff}
.conversation-icon{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:#f0eeff;color:#7466e6;flex:0 0 auto}
.conversation-copy{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}
.conversation-copy strong{font-size:11px;line-height:1.5;overflow-wrap:anywhere}
.conversation-copy small{color:#98a1b4;font-size:10px}
.sidebar-note{margin:12px 2px 0;border-top:1px solid #eff1f6;padding-top:12px;color:#99a1b4;font-size:10px;line-height:1.8}
.conversation-panel{display:flex;flex-direction:column;min-width:0;overflow:hidden}
.conversation-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:17px 20px;border-bottom:1px solid #edf0f6}
.conversation-toolbar>div{display:flex;flex-direction:column;gap:5px;min-width:0}
.conversation-toolbar strong{font-size:12px;color:#3d4862;overflow-wrap:anywhere}
.conversation-toolbar span{font-size:10px;color:#99a1b4}
.message-list{display:flex;flex:1;flex-direction:column;gap:20px;min-height:280px;max-height:calc(100vh - 390px);overflow:auto;padding:22px 20px;background:linear-gradient(180deg,#fcfcff,#fff)}
.chat-welcome{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;min-height:300px;padding:26px;text-align:center}
.welcome-mark{display:flex;align-items:center;justify-content:center;width:54px;height:54px;border-radius:17px;background:#f0eeff;color:#7568e8;font-size:25px}
.chat-welcome h2{margin:17px 0 7px;color:#38435c;font-size:17px}
.chat-welcome p{max-width:390px;color:#97a0b3;font-size:11px;line-height:1.9}
.message-row{display:flex;align-items:flex-start;gap:10px;max-width:880px}
.message-row.from-user{align-self:flex-end;flex-direction:row-reverse}
.message-avatar{display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex:0 0 auto;border:1px solid #e9ecf4;border-radius:11px;background:#fff;color:#7769e5}
.from-user .message-avatar{background:#f0eeff;border-color:#e3ddff}
.message-main{min-width:0;max-width:min(680px,calc(100% - 44px))}
.message-meta{display:flex;align-items:center;gap:10px;margin-bottom:6px;color:#52607a;font-size:10px}
.message-meta time{color:#a1a9b9;font-size:9px}
.from-user .message-meta{justify-content:flex-end}
.message-bubble{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #eceff6;border-radius:4px 14px 14px 14px;background:#fff;padding:12px 14px;color:#4d5872;font-size:12px;line-height:1.9;box-shadow:0 4px 16px rgba(40,52,93,.025)}
.from-user .message-bubble{border-color:#e2deff;border-radius:14px 4px 14px 14px;background:#f4f2ff;color:#51459f}
.sources-panel{display:flex;flex-direction:column;gap:7px;margin-top:9px;padding:10px 11px;border:1px solid #e8f1ec;border-radius:11px;background:#fbfefc}
.sources-title{display:flex;align-items:center;gap:5px;color:#47836b;font-size:10px;font-weight:750;margin-bottom:2px}
.source-item{display:flex;align-items:flex-start;gap:7px;color:#758296;font-size:10px;line-height:1.7}
.source-item span{min-width:0;overflow-wrap:anywhere}
.thinking-row{display:flex;align-items:center;gap:9px;color:#8e98ad;font-size:11px}
.thinking-dot{width:7px;height:7px;border-radius:50%;background:#8d80ef;box-shadow:0 0 0 4px #f0eeff}
.composer{border-top:1px solid #edf0f6;padding:16px 18px 18px;background:#fff}
.composer-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:10px}
.composer-footer span{display:flex;align-items:center;gap:5px;color:#9ca4b5;font-size:10px;line-height:1.7}
@media(max-width:1000px){.chat-layout{grid-template-columns:220px minmax(0,1fr)}.message-list{max-height:none;min-height:380px}}
@media(max-width:720px){.chat-layout{grid-template-columns:1fr}.conversation-sidebar{order:2}.message-list{max-height:none;padding:16px}.composer-footer{align-items:flex-start;flex-direction:column}.conversation-toolbar{align-items:flex-start;flex-direction:column}.conversation-toolbar-actions{width:100%;justify-content:space-between}.page-wrap{padding:20px 15px 32px}}
</style>
