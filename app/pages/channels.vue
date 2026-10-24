<script setup lang="ts">
import { ChatDotRound, Delete, Link, Plus, Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type ChannelBinding = { id: string; characterId: string; characterName: string; routingKey: string | null };
type ChannelConnection = {
  id: string; platform: string; displayName: string; appId: string | null; status: string;
  lastEventAt: string | null; createdAt: string; bindings: ChannelBinding[];
};

const connections = ref<ChannelConnection[]>([]);
const loading = ref(false);
const saving = ref(false);
const createVisible = ref(false);
const createForm = reactive({ appId: "", appSecret: "", displayName: "" });

const bindVisible = ref(false);
const bindTarget = ref<ChannelConnection | null>(null);
const bindForm = reactive({ characterId: "", routingKey: "" });

const characters = useCharacterList();
await useCharacterListData();

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

const statusMap: Record<string, { label: string; type: "success" | "warning" | "danger" | "info" }> = {
  CONNECTED: { label: "已连接", type: "success" },
  DISCONNECTED: { label: "未连接", type: "warning" },
  ERROR: { label: "连接异常", type: "danger" },
  DISABLED: { label: "已停用", type: "info" },
};

function formatDateTime(value: string | null) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "从未";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadConnections() {
  loading.value = true;
  try {
    const response = await $fetch<{ connections: ChannelConnection[] }>("/api/admin/channels");
    connections.value = response.connections;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取渠道连接。"));
  } finally {
    loading.value = false;
  }
}

async function submitCreate() {
  if (saving.value) return;
  if (!createForm.appId.trim() || !createForm.appSecret.trim()) {
    ElMessage.warning("请填写 AppID 和 AppSecret。");
    return;
  }
  saving.value = true;
  try {
    await $fetch("/api/admin/channels", {
      method: "POST",
      body: { appId: createForm.appId.trim(), appSecret: createForm.appSecret, displayName: createForm.displayName.trim() },
    });
    ElMessage.success("渠道连接已保存，运行 `yarn channel:run` 即可接入。");
    createForm.appId = "";
    createForm.appSecret = "";
    createForm.displayName = "";
    createVisible.value = false;
    await loadConnections();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "保存失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}

async function removeConnection(connection: ChannelConnection) {
  const confirmed = await ElMessageBox.confirm(
    `删除后「${connection.displayName}」及其所有绑定都会移除，确定？`,
    "删除渠道连接",
    { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    ElMessage.success("渠道连接已删除。");
    await loadConnections();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "删除失败，请稍后重试。"));
  }
}

function openBind(connection: ChannelConnection) {
  bindTarget.value = connection;
  bindForm.characterId = "";
  bindForm.routingKey = "";
  bindVisible.value = true;
}

async function submitBind() {
  if (saving.value || !bindTarget.value) return;
  if (!bindForm.characterId) {
    ElMessage.warning("请选择要绑定的角色。");
    return;
  }
  saving.value = true;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(bindTarget.value.id)}/bindings`, {
      method: "POST",
      body: { characterId: bindForm.characterId, routingKey: bindForm.routingKey.trim() },
    });
    ElMessage.success("角色已绑定到该渠道。");
    bindVisible.value = false;
    await loadConnections();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "绑定失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}

async function unbind(connection: ChannelConnection, binding: ChannelBinding) {
  const confirmed = await ElMessageBox.confirm(
    `解除「${binding.characterName}」与「${connection.displayName}」的绑定？`,
    "解除绑定",
    { confirmButtonText: "解绑", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(connection.id)}/bindings/${encodeURIComponent(binding.id)}`, { method: "DELETE" });
    ElMessage.success("已解绑。");
    await loadConnections();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "解绑失败，请稍后重试。"));
  }
}

onMounted(loadConnections);
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / 渠道管理"
      title="渠道接入"
      description="把角色接到 QQ 官方机器人，群聊 @ 机器人或私聊即可对话。连接保存后运行 `yarn channel:run` 启动适配器。"
    >
      <template #actions>
        <el-button
          :loading="loading"
          @click="loadConnections"
        >
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
        <el-button
          type="primary"
          @click="createVisible = true"
        >
          <el-icon><Plus /></el-icon>添加 QQ 机器人
        </el-button>
      </template>
    </PageHeader>

    <div
      class="info-callout"
      style="margin-bottom:20px"
    >
      <el-icon><ChatDotRound /></el-icon>
      <span>AppSecret 会加密保存在数据库，只有渠道适配器能解密。AppID / AppSecret 在 QQ 开放平台创建机器人后获取。</span>
    </div>

    <div
      v-loading="loading"
      class="channel-grid"
    >
      <div
        v-if="!connections.length"
        class="channel-empty"
      >
        还没有渠道连接，点击右上角「添加 QQ 机器人」开始。
      </div>
      <article
        v-for="connection in connections"
        :key="connection.id"
        class="surface channel-card"
      >
        <div class="channel-head">
          <div class="channel-icon">
            <el-icon><ChatDotRound /></el-icon>
          </div>
          <div class="character-info">
            <h2 class="character-name">
              {{ connection.displayName }}
            </h2>
            <p class="character-alias">
              {{ connection.appId }}
            </p>
          </div>
          <el-tag
            :type="statusMap[connection.status]?.type ?? 'info'"
            effect="light"
            size="small"
          >
            {{ statusMap[connection.status]?.label ?? connection.status }}
          </el-tag>
        </div>

        <div class="metric-row">
          <span>最近活动</span><span class="metric-value">{{ formatDateTime(connection.lastEventAt) }}</span>
        </div>
        <div class="metric-row">
          <span>创建时间</span><span class="metric-value">{{ formatDateTime(connection.createdAt) }}</span>
        </div>

        <div class="binding-title">
          已绑定角色
          <el-button
            text
            size="small"
            type="primary"
            @click="openBind(connection)"
          >
            <el-icon><Link /></el-icon>绑定
          </el-button>
        </div>
        <div
          v-if="!connection.bindings.length"
          class="binding-empty"
        >
          未绑定任何角色。
        </div>
        <div
          v-for="binding in connection.bindings"
          :key="binding.id"
          class="binding-row"
        >
          <div class="character-info">
            <div
              class="character-name"
              style="font-size:11px"
            >
              {{ binding.characterName }}
            </div>
            <div class="character-alias">
              {{ binding.routingKey ? "路由键：" + binding.routingKey : "默认（接收全部群消息）" }}
            </div>
          </div>
          <el-button
            text
            size="small"
            type="danger"
            @click="unbind(connection, binding)"
          >
            解绑
          </el-button>
        </div>

        <el-button
          style="width:100%;margin-top:14px"
          plain
          type="danger"
          @click="removeConnection(connection)"
        >
          <el-icon><Delete /></el-icon>删除连接
        </el-button>
      </article>
    </div>

    <el-dialog
      v-model="createVisible"
      title="添加 QQ 机器人"
      width="440px"
    >
      <el-form label-position="top">
        <el-form-item label="AppID">
          <el-input
            v-model="createForm.appId"
            placeholder="QQ 开放平台机器人 AppID"
          />
        </el-form-item>
        <el-form-item label="AppSecret">
          <el-input
            v-model="createForm.appSecret"
            type="password"
            show-password
            placeholder="QQ 开放平台机器人 AppSecret"
          />
        </el-form-item>
        <el-form-item label="显示名（可选）">
          <el-input
            v-model="createForm.displayName"
            placeholder="例如：我的 QQ 机器人"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="saving"
          @click="submitCreate"
        >
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="bindVisible"
      title="绑定角色"
      width="440px"
    >
      <el-form label-position="top">
        <el-form-item label="角色">
          <el-select
            v-model="bindForm.characterId"
            placeholder="选择要绑定的角色"
            style="width:100%"
          >
            <el-option
              v-for="character in characters"
              :key="character.id"
              :label="character.name"
              :value="character.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="路由键（可选）">
          <el-input
            v-model="bindForm.routingKey"
            placeholder="留空表示接收该机器人的全部群消息；填群 openid 则只响应那个群"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bindVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="saving"
          @click="submitBind"
        >
          绑定
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.channel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:15px}
.channel-card{padding:20px}
.channel-head{display:flex;align-items:flex-start;gap:11px;min-height:52px}
.channel-icon{display:flex;width:42px;height:42px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:13px;background:#f0eeff;color:#786be4;font-size:19px}
.channel-empty{grid-column:1/-1;padding:40px 0;color:#a3aabb;font-size:12px;text-align:center}
.binding-title{display:flex;align-items:center;justify-content:space-between;margin:16px 0 6px;color:#8b96ab;font-size:11px;font-weight:700}
.binding-empty{padding:10px 0;color:#b4bbc8;font-size:11px}
.binding-row{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #f0f2f7;padding:9px 0}
.binding-row:last-of-type{border-bottom:0}
@media(max-width:1000px){.channel-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.channel-grid{grid-template-columns:1fr}}
</style>
