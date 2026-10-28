<script setup lang="ts">
import { ChatDotRound, CopyDocument, Delete, Plus, Refresh, Setting, User } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

useHead({ title: "QQ 渠道 · 忆灵小窝" });

type ChannelBinding = { id: string; characterId: string; characterName: string; routingKey: string | null };
type QqConnection = {
  id: string; platform: string; displayName: string; appId: string | null; status: string;
  lastEventAt: string | null; createdAt: string; metadata: Record<string, unknown> | null;
  bindings: ChannelBinding[];
};

const characters = useCharacterList();
await useCharacterListData();

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

// SSR 阶段带上登录态；这个页面只管 OneBot 小号，B站 连接由值班台自己管。
const request = import.meta.server ? useRequestFetch() : $fetch;
const { data, pending, refresh, error } = await useAsyncData("qq-connections", async () => {
  const response = await request<{ connections: QqConnection[] }>("/api/admin/channels");
  return response.connections.filter((item) => item.platform === "qq-onebot");
});

const connections = computed(() => data.value ?? []);
const loading = computed(() => pending.value);

watch(error, (value) => {
  if (value) ElMessage.error(readErrorMessage(value, "无法读取渠道连接。"));
});

const statusMap: Record<string, { label: string; tone: string }> = {
  CONNECTED: { label: "已连接", tone: "pill-green" },
  DISCONNECTED: { label: "未连接", tone: "pill-amber" },
  ERROR: { label: "连接异常", tone: "pill-rose" },
  DISABLED: { label: "已停用", tone: "pill-gray" },
};

function formatDateTime(value: string | null) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "从未";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readMentionOnly(connection: QqConnection) {
  return connection.metadata?.replyOnlyWhenMentioned === true;
}

// ── 添加 / 编辑 ─────────────────────────────────────────────
const editVisible = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({
  qqNumber: "",
  displayName: "",
  wsUrl: "",
  httpUrl: "",
  accessToken: "",
  httpToken: "",
  replyOnlyWhenMentioned: true,
});

function resetForm() {
  form.qqNumber = "";
  form.displayName = "";
  form.wsUrl = "";
  form.httpUrl = "";
  form.accessToken = "";
  form.httpToken = "";
  form.replyOnlyWhenMentioned = true;
}

function openCreate() {
  editingId.value = null;
  resetForm();
  editVisible.value = true;
}

function openEdit(connection: QqConnection) {
  editingId.value = connection.id;
  resetForm();
  form.qqNumber = connection.appId || "";
  form.displayName = connection.appId ? connection.displayName : "";
  form.replyOnlyWhenMentioned = readMentionOnly(connection);
  editVisible.value = true;
}

async function submitConnection() {
  if (saving.value) return;
  if (!form.qqNumber.trim()) {
    ElMessage.warning("请填写 QQ 号。");
    return;
  }
  saving.value = true;
  try {
    await $fetch("/api/admin/channels", {
      method: "POST",
      body: {
        platform: "qq-onebot",
        qqNumber: form.qqNumber.trim(),
        displayName: form.displayName.trim(),
        wsUrl: form.wsUrl.trim(),
        httpUrl: form.httpUrl.trim(),
        accessToken: form.accessToken,
        httpToken: form.httpToken,
        replyOnlyWhenMentioned: form.replyOnlyWhenMentioned,
      },
    });
    ElMessage.success(editingId.value ? "已保存，重启 yarn onebot:run 生效。" : "已添加，下一步绑定角色并运行 yarn onebot:run。");
    editVisible.value = false;
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "保存失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}

// ── 绑定角色 ───────────────────────────────────────────────
const bindVisible = ref(false);
const bindSaving = ref(false);
const bindTarget = ref<QqConnection | null>(null);
const bindForm = reactive({ characterId: "", routingKey: "" });

function openBind(connection: QqConnection) {
  bindTarget.value = connection;
  bindForm.characterId = "";
  bindForm.routingKey = "";
  bindVisible.value = true;
}

async function submitBind() {
  if (bindSaving.value || !bindTarget.value) return;
  if (!bindForm.characterId) {
    ElMessage.warning("请选择要绑定的角色。");
    return;
  }
  bindSaving.value = true;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(bindTarget.value.id)}/bindings`, {
      method: "POST",
      body: { characterId: bindForm.characterId, routingKey: bindForm.routingKey.trim() },
    });
    ElMessage.success("角色已绑定。");
    bindVisible.value = false;
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "绑定失败，请稍后重试。"));
  } finally {
    bindSaving.value = false;
  }
}

async function unbind(connection: QqConnection, binding: ChannelBinding) {
  const confirmed = await ElMessageBox.confirm(
    `解除「${binding.characterName}」与「${connection.displayName}」的绑定？`,
    "解除绑定",
    { confirmButtonText: "解绑", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(
      `/api/admin/channels/${encodeURIComponent(connection.id)}/bindings/${encodeURIComponent(binding.id)}`,
      { method: "DELETE" },
    );
    ElMessage.success("已解绑。");
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "解绑失败，请稍后重试。"));
  }
}

async function removeConnection(connection: QqConnection) {
  const confirmed = await ElMessageBox.confirm(
    `删除后「${connection.displayName}」及其绑定都会移除，确定？`,
    "删除连接",
    { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    ElMessage.success("已删除。");
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "删除失败，请稍后重试。"));
  }
}

async function copyCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    ElMessage.success("命令已复制。");
  } catch {
    ElMessage.warning("复制失败，请手动选中。");
  }
}


</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / QQ 渠道"
      title="QQ 渠道"
      description="用个人 QQ 小号挂 AI：NapCat 把 QQ 消息翻译成 OneBot v11 推给这里，角色带着记忆回复。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="refresh()"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
        <button
          type="button"
          class="btn primary"
          @click="openCreate"
        >
          <el-icon><Plus /></el-icon>添加 QQ 小号
        </button>
      </template>
    </PageHeader>

    <div class="notice info">
      <el-icon><ChatDotRound /></el-icon>
      <span>WS / HTTP 地址与 Token 加密入库，只保存在本机数据库里；重新保存时这些字段留空 = 沿用已保存的值。</span>
    </div>

    <!-- 接入引导：从零到能收发的四步 -->
    <div class="qq-steps-card">
      <div class="qq-steps-head">
        <h2>怎么接进来</h2>
        <span class="qq-steps-note">四步，第一次大约十分钟</span>
      </div>
      <ol class="qq-steps">
        <li>
          <span class="qq-step-no">1</span>
          <div class="qq-step-body">
            <h3>装 NapCat 并登录小号</h3>
            <p>
              下 <code>NapCatQQ</code> 的 Windows 一键安装包，装好后用<strong>QQ 小号</strong>扫码登录。
              它挂在 QQNT 客户端里跑，那个 QQ 窗口不能关。
            </p>
          </div>
        </li>
        <li>
          <span class="qq-step-no">2</span>
          <div class="qq-step-body">
            <h3>打开两个 OneBot 端口</h3>
            <p>
              浏览器进 <code>http://127.0.0.1:6099/webui/</code>（用终端里显示的 token 登录），在「网络配置」里开启
              <strong>正向 WebSocket（3001）</strong> 与 <strong>HTTP API（3000）</strong>，设一个 Access Token 并记下来。
            </p>
          </div>
        </li>
        <li>
          <span class="qq-step-no">3</span>
          <div class="qq-step-body">
            <h3>在这里填连接并绑定角色</h3>
            <p>
              点右上「添加 QQ 小号」，填 QQ 号、两个地址（默认就是 3001 / 3000）和刚才的 Token，
              保存后在这张卡片上「绑定角色」——不绑角色，消息进来没人回。
            </p>
          </div>
        </li>
        <li>
          <span class="qq-step-no">4</span>
          <div class="qq-step-body">
            <h3>跑适配器</h3>
            <p>
              项目根目录执行下面这条，看到 <code>onebot-connected</code> 就通了。进程要一直开着，关掉就不回消息。
            </p>
            <button
              type="button"
              class="qq-cmd"
              title="点击复制"
              @click="copyCommand('yarn onebot:run')"
            >
              <code>yarn onebot:run</code>
              <el-icon><CopyDocument /></el-icon>
            </button>
          </div>
        </li>
      </ol>
      <div class="qq-steps-foot">
        <span><strong>连不上？</strong>先确认 NapCat 已登录、3001/3000 在监听、适配器在跑。</span>
        <span><strong>连上不回？</strong>多半是没绑角色，或角色还没配模型 API Key。</span>
        <span><strong>群里太吵？</strong>把「仅被 @ 时回复」勾上。</span>
        <span><strong>想让她发表情？</strong>去「角色 → 模型设置」打开「QQ 渠道发表情」。</span>
      </div>
    </div>

    <div
      v-if="loading && !connections.length"
      class="qq-grid"
    >
      <div
        v-for="i in 2"
        :key="'sk-' + i"
        class="card qq-card"
      >
        <div
          v-for="n in 4"
          :key="n"
          class="sk"
          :style="{ height: n === 1 ? '40px' : '14px', width: n === 1 ? '64%' : '100%' }"
        />
      </div>
    </div>
    <div
      v-else-if="!connections.length"
      class="empty-block"
    >
      <span class="halo"><el-icon><ChatDotRound /></el-icon></span>
      <h4>还没有 QQ 小号</h4>
      <p>按上面四步做完 NapCat 那两步，再回这里添加连接，QQ 上的对话才会接到角色身上。</p>
      <button
        type="button"
        class="btn primary"
        @click="openCreate"
      >
        <el-icon><Plus /></el-icon>添加 QQ 小号
      </button>
    </div>
    <div
      v-else
      class="qq-grid"
    >
      <article
        v-for="connection in connections"
        :key="connection.id"
        class="card qq-card"
      >
        <div class="qq-head">
          <div class="qq-icon">
            <el-icon><ChatDotRound /></el-icon>
          </div>
          <div class="qq-info">
            <h2 class="qq-name">
              {{ connection.displayName }}
            </h2>
            <p class="qq-sub">
              QQ 小号 · {{ connection.appId || "未填 QQ 号" }}
            </p>
          </div>
          <span
            class="pill"
            :class="statusMap[connection.status]?.tone ?? 'pill-gray'"
          >{{ statusMap[connection.status]?.label ?? connection.status }}</span>
        </div>

        <div class="metric-row">
          <span>最近活动</span><span class="metric-value">{{ formatDateTime(connection.lastEventAt) }}</span>
        </div>
        <div class="metric-row">
          <span>群聊</span><span class="metric-value">{{ readMentionOnly(connection) ? "仅被 @ 时回复" : "所有消息都回复" }}</span>
        </div>
        <div class="metric-row">
          <span>适配器</span><span class="metric-value"><code>yarn onebot:run</code></span>
        </div>

        <div class="qq-actions">
          <button
            type="button"
            class="btn sm"
            @click="openEdit(connection)"
          >
            <el-icon><Setting /></el-icon>连接设置
          </button>
          <button
            type="button"
            class="btn sm"
            @click="openBind(connection)"
          >
            <el-icon><User /></el-icon>绑定角色
          </button>
          <button
            type="button"
            class="btn sm danger-ghost"
            @click="removeConnection(connection)"
          >
            <el-icon><Delete /></el-icon>删除
          </button>
        </div>

        <div class="qq-binding-title">
          <span>已绑定角色<em v-if="connection.bindings.length"> · {{ connection.bindings.length }}</em></span>
        </div>
        <div
          v-if="!connection.bindings.length"
          class="qq-binding-empty"
        >
          还没绑定角色，这个号现在不会回复任何消息。
        </div>
        <div
          v-for="binding in connection.bindings"
          :key="binding.id"
          class="qq-binding-row"
        >
          <div class="qq-info">
            <div class="qq-binding-name">
              {{ binding.characterName }}
            </div>
            <div class="qq-sub">
              {{ binding.routingKey ? "只响应群 " + binding.routingKey : "私聊 + 所有群" }}
            </div>
          </div>
          <button
            type="button"
            class="card-link is-danger"
            @click="unbind(connection, binding)"
          >
            解绑
          </button>
        </div>
      </article>
    </div>

    <el-dialog
      v-model="editVisible"
      :title="editingId ? '连接设置' : '添加 QQ 小号'"
      width="520px"
      :close-on-click-modal="false"
    >
      <el-form
        label-position="top"
        class="qq-dialog"
      >
        <el-form-item label="QQ 号（必填）">
          <el-input
            v-model="form.qqNumber"
            :disabled="!!editingId"
            placeholder="小号的数字 QQ 号，例如 123456789"
          />
        </el-form-item>
        <el-form-item label="显示名（可选）">
          <el-input
            v-model="form.displayName"
            placeholder="例如：我的 QQ 小号"
          />
        </el-form-item>
        <el-form-item label="OneBot WebSocket 地址">
          <el-input
            v-model="form.wsUrl"
            :placeholder="editingId ? '留空 = 沿用已保存的地址' : '默认 ws://127.0.0.1:3001'"
          />
        </el-form-item>
        <el-form-item label="OneBot HTTP API 地址">
          <el-input
            v-model="form.httpUrl"
            :placeholder="editingId ? '留空 = 沿用已保存的地址' : '默认 http://127.0.0.1:3000'"
          />
        </el-form-item>
        <el-form-item label="WS Token">
          <el-input
            v-model="form.accessToken"
            type="password"
            show-password
            :placeholder="editingId ? '留空 = 沿用已保存的 Token' : 'NapCat 里设的 Access Token，没设就留空'"
          />
        </el-form-item>
        <el-form-item label="HTTP Token">
          <el-input
            v-model="form.httpToken"
            type="password"
            show-password
            :placeholder="editingId ? '留空 = 沿用已保存的 Token' : 'NapCat 里设的 Access Token，没设就留空'"
          />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="form.replyOnlyWhenMentioned">
            群聊中仅在被 @ 时才回复（私聊总是回复）
          </el-checkbox>
        </el-form-item>
      </el-form>
      <p class="qq-form-tip">
        同一个 QQ 号再保存一次就是更新这条连接，不会重复创建。改完记得重启 <code>yarn onebot:run</code>。
      </p>
      <template #footer>
        <el-button @click="editVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="saving"
          @click="submitConnection"
        >
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="bindVisible"
      title="绑定角色"
      width="440px"
      :close-on-click-modal="false"
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
        <el-form-item label="路由键（可选，填 QQ 群号）">
          <el-input
            v-model="bindForm.routingKey"
            placeholder="留空 = 私聊 + 所有群都响应；填群号 = 只响应那个群"
          />
        </el-form-item>
      </el-form>
      <p class="qq-form-tip">
        想同时监听多个群，就给同一个角色分别绑几条，每条填一个群号。
      </p>
      <template #footer>
        <el-button @click="bindVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="bindSaving"
          @click="submitBind"
        >
          绑定
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.qq-steps-card{margin:14px 0 16px;border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--surface);padding:16px 18px}
.qq-steps-head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
.qq-steps-head h2{margin:0;color:var(--text);font-size:14px;font-weight:700}
.qq-steps-note{color:var(--faint);font-size:12px}
.qq-steps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;margin:12px 0 0;padding:0;list-style:none}
.qq-steps li{display:flex;gap:10px}
.qq-step-no{display:flex;width:20px;height:20px;flex:0 0 auto;align-items:center;justify-content:center;margin-top:1px;border-radius:50%;background:var(--brand-soft);color:var(--brand-strong);font-size:12px;font-weight:700}
.qq-step-body{min-width:0}
.qq-step-body h3{margin:0 0 4px;color:var(--text-2);font-size:13px;font-weight:600}
.qq-step-body p{margin:0;color:var(--dim);font-size:12px;line-height:1.75}
.qq-step-body code,.qq-steps-foot code{border-radius:4px;background:var(--surface-3);padding:1px 4px;color:var(--text-2);font-family:var(--font-mono,ui-monospace,monospace);font-size:12px}
.qq-cmd{display:inline-flex;align-items:center;gap:7px;margin-top:7px;border:1px solid var(--line);border-radius:var(--radius-xs);background:var(--surface-2);padding:5px 9px;color:var(--text-2);cursor:pointer;transition:border-color .15s,background .15s}
.qq-cmd:hover{border-color:var(--brand);background:var(--brand-soft)}
.qq-cmd code{background:none;padding:0;color:inherit}
.qq-cmd .el-icon{color:var(--faint);font-size:13px}
.qq-steps-foot{display:flex;flex-wrap:wrap;gap:8px 20px;margin-top:14px;border-top:1px solid var(--line);padding-top:11px}
.qq-steps-foot span{color:var(--faint);font-size:12px;line-height:1.7}
.qq-steps-foot strong{margin-right:4px;color:var(--text-2);font-weight:600}

.qq-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.qq-card{display:flex;flex-direction:column;padding:16px 18px}
.qq-head{display:flex;align-items:flex-start;gap:11px}
.qq-icon{display:flex;width:36px;height:36px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--brand-soft);color:var(--brand);font-size:17px}
.qq-info{min-width:0;flex:1}
.qq-name{margin:0;color:var(--text);font-size:14px;font-weight:700;letter-spacing:-.01em}
.qq-sub{margin:3px 0 0;color:var(--faint);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.qq-actions{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0 2px}
.danger-ghost{color:var(--red)}
.danger-ghost:hover{border-color:#e3a5af;background:#fdf2f4;color:var(--red)}
.qq-binding-title{display:flex;align-items:center;gap:10px;margin:12px 0 2px;color:var(--dim);font-size:12px;font-weight:600}
.qq-binding-title em{font-style:normal;color:var(--faint);font-weight:500}
.qq-binding-empty{padding:8px 0;color:var(--faint);font-size:12px;line-height:1.7}
.qq-binding-row{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:9px 0}
.qq-binding-row:last-of-type{border-bottom:0}
.qq-binding-name{color:var(--text-2);font-size:12px;font-weight:600}
.card-link.is-danger{color:var(--red)}
.card-link.is-danger:hover{color:#b02338}
.qq-dialog{max-height:56vh;overflow-y:auto;padding-right:4px}
.qq-form-tip{margin:0;color:var(--faint);font-size:12px;line-height:1.7}
.qq-form-tip code{border-radius:4px;background:var(--surface-3);padding:1px 4px;font-family:var(--font-mono,ui-monospace,monospace)}
@media(max-width:1100px){.qq-steps{grid-template-columns:1fr}.qq-grid{grid-template-columns:1fr}}
</style>
