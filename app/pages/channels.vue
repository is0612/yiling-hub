<script setup lang="ts">
import { ChatDotRound, Delete, MoreFilled, Plus, Refresh, VideoPlay } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type ChannelBinding = { id: string; characterId: string; characterName: string; routingKey: string | null };
type ChannelConnection = {
  id: string; platform: string; displayName: string; appId: string | null; status: string;
  lastEventAt: string | null; createdAt: string; metadata: Record<string, unknown> | null;
  bindings: ChannelBinding[];
};

const connections = ref<ChannelConnection[]>([]);
const loading = ref(true);
const saving = ref(false);
const createVisible = ref(false);
const createPlatform = ref<"qq" | "qq-onebot" | "bili">("qq");

const createForm = reactive({ appId: "", appSecret: "", displayName: "" });
const onebotForm = reactive({
  qqNumber: "",
  wsUrl: "",
  httpUrl: "",
  accessToken: "",
  httpToken: "",
  replyOnlyWhenMentioned: false,
});
const biliForm = reactive({
  dataHome: "",
  biliBin: "",
  perDay: 5,
  peakValley: true,
  noon: true,
  night: true,
  keywordsText: "",
  zone: "all",
  dmMode: "only",
  autoComment: false,
  commentPerRound: 1,
  mentionName: "",
});

const ZONES = ["all", "anime", "music", "dance", "game", "knowledge", "tech", "sports", "car", "life", "food", "animal", "kichiku", "fashion", "ent", "film", "original", "rookie"];

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

const statusMap: Record<string, { label: string; tone: string }> = {
  CONNECTED: { label: "已连接", tone: "pill-green" },
  DISCONNECTED: { label: "未连接", tone: "pill-amber" },
  ERROR: { label: "连接异常", tone: "pill-rose" },
  DISABLED: { label: "已停用", tone: "pill-gray" },
};

function platformLabel(platform: string) {
  if (platform === "bili") return "B站";
  if (platform === "qq") return "QQ";
  if (platform === "qq-onebot") return "QQ 小号";
  return platform;
}

function platformHint(platform: string) {
  if (platform === "bili") return "yarn bili:run";
  if (platform === "qq-onebot") return "yarn onebot:run";
  return "yarn channel:run";
}

function channelSubtitle(connection: ChannelConnection) {
  return connection.appId
    ? `${platformLabel(connection.platform)} · ${connection.appId}`
    : platformLabel(connection.platform);
}

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
  if (createPlatform.value === "qq") {
    if (!createForm.appId.trim() || !createForm.appSecret.trim()) {
      ElMessage.warning("请填写 AppID 和 AppSecret。");
      return;
    }
  } else if (createPlatform.value === "qq-onebot") {
    if (!onebotForm.qqNumber.trim()) {
      ElMessage.warning("请填写 QQ 号。");
      return;
    }
  }
  saving.value = true;
  try {
    const body = createPlatform.value === "qq"
      ? { platform: "qq", appId: createForm.appId.trim(), appSecret: createForm.appSecret, displayName: createForm.displayName.trim() }
      : createPlatform.value === "qq-onebot"
        ? {
            platform: "qq-onebot",
            qqNumber: onebotForm.qqNumber.trim(),
            wsUrl: onebotForm.wsUrl.trim(),
            httpUrl: onebotForm.httpUrl.trim(),
            accessToken: onebotForm.accessToken,
            httpToken: onebotForm.httpToken,
            replyOnlyWhenMentioned: onebotForm.replyOnlyWhenMentioned,
            displayName: createForm.displayName.trim(),
          }
        : {
            platform: "bili",
            displayName: createForm.displayName.trim(),
            dataHome: biliForm.dataHome.trim(),
            biliBin: biliForm.biliBin.trim(),
            duty: {
              perDay: biliForm.perDay,
              peakValley: biliForm.peakValley,
              noon: biliForm.noon,
              night: biliForm.night,
              keywords: biliForm.keywordsText.split(/[,，\n]/).map((k) => k.trim()).filter(Boolean),
              zone: biliForm.zone,
              dmMode: biliForm.dmMode,
              autoComment: biliForm.autoComment,
              commentPerRound: biliForm.commentPerRound,
              mentionName: biliForm.mentionName.trim(),
            },
          };
    await $fetch("/api/admin/channels", { method: "POST", body });
    ElMessage.success(
      createPlatform.value === "qq"
        ? "QQ 渠道已保存，运行 `yarn channel:run` 接入。"
        : createPlatform.value === "qq-onebot"
          ? "QQ 小号渠道已保存，运行 `yarn onebot:run` 接入。"
          : "B站渠道已保存，运行 `yarn bili:run` 接入。",
    );
    createForm.appId = "";
    createForm.appSecret = "";
    createForm.displayName = "";
    onebotForm.qqNumber = "";
    onebotForm.wsUrl = "";
    onebotForm.httpUrl = "";
    onebotForm.accessToken = "";
    onebotForm.httpToken = "";
    onebotForm.replyOnlyWhenMentioned = false;
    biliForm.dataHome = "";
    biliForm.biliBin = "";
    biliForm.keywordsText = "";
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
      description="把角色接到 QQ 官方机器人、QQ 小号（OneBot）或 B站。QQ 机器人走群聊 @/私聊对话；QQ 小号走 OneBot 协议挂个人号；B站 走自动值班刷视频 + 私信/评论回复。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadConnections"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
        <button
          type="button"
          class="btn primary"
          @click="createVisible = true"
        >
          <el-icon><Plus /></el-icon>添加渠道
        </button>
      </template>
    </PageHeader>

    <div class="notice info">
      <el-icon><ChatDotRound /></el-icon>
      <span>AppSecret 与 OneBot 凭据均加密入库，B站 沿用本机 credential.json。保存连接后运行对应适配器脚本即可上线。</span>
    </div>

    <div
      v-if="loading && !connections.length"
      class="channel-grid"
    >
      <div
        v-for="i in 3"
        :key="'sk-' + i"
        class="card channel-card"
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
      <h4>还没有渠道连接</h4>
      <p>把角色接到 QQ 机器人、QQ 小号或 B站，这个页面就会出现连接卡片与绑定关系。</p>
      <button
        type="button"
        class="btn primary"
        @click="createVisible = true"
      >
        <el-icon><Plus /></el-icon>添加渠道
      </button>
    </div>
    <div
      v-else
      class="channel-grid"
    >
      <article
        v-for="connection in connections"
        :key="connection.id"
        class="card channel-card"
      >
        <div class="channel-head">
          <div
            class="channel-icon"
            :class="{ 'channel-icon-bili': connection.platform === 'bili' }"
          >
            <el-icon>
              <VideoPlay v-if="connection.platform === 'bili'" />
              <ChatDotRound v-else />
            </el-icon>
          </div>
          <div class="channel-info">
            <h2 class="channel-name">
              {{ connection.displayName }}
            </h2>
            <p class="channel-subtitle">
              {{ channelSubtitle(connection) }}
            </p>
          </div>
          <span
            class="pill"
            :class="statusMap[connection.status]?.tone ?? 'pill-gray'"
          >{{ statusMap[connection.status]?.label ?? connection.status }}</span>
          <el-dropdown
            trigger="click"
            class="channel-more"
            @command="removeConnection(connection)"
          >
            <button
              class="more-trigger"
              type="button"
              aria-label="更多操作"
            >
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="delete">
                  <el-icon><Delete /></el-icon>删除连接
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <div class="metric-row">
          <span>最近活动</span><span class="metric-value">{{ formatDateTime(connection.lastEventAt) }}</span>
        </div>
        <div class="metric-row">
          <span>适配器</span><span class="metric-value">{{ platformHint(connection.platform) }}</span>
        </div>

        <div class="binding-title">
          <span>已绑定角色<em v-if="connection.bindings.length"> · {{ connection.bindings.length }}</em></span>
          <button
            type="button"
            class="card-link"
            @click="openBind(connection)"
          >
            绑定角色
          </button>
        </div>
        <div
          v-if="!connection.bindings.length"
          class="binding-empty"
        >
          未绑定任何角色，这个渠道暂时不会产生对话。
        </div>
        <div
          v-for="binding in connection.bindings"
          :key="binding.id"
          class="binding-row"
        >
          <div class="channel-info">
            <div class="binding-name">
              {{ binding.characterName }}
            </div>
            <div class="channel-subtitle">
              {{ binding.routingKey ? "路由键：" + binding.routingKey : "默认（接收全部群消息）" }}
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
      v-model="createVisible"
      title="添加渠道"
      width="500px"
    >
      <el-radio-group
        v-model="createPlatform"
        style="margin-bottom:16px"
      >
        <el-radio-button value="qq">
          QQ 机器人
        </el-radio-button>
        <el-radio-button value="qq-onebot">
          QQ 小号
        </el-radio-button>
        <el-radio-button value="bili">
          B站 值班
        </el-radio-button>
      </el-radio-group>

      <el-form
        v-if="createPlatform === 'qq'"
        label-position="top"
      >
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

      <el-form
        v-else-if="createPlatform === 'qq-onebot'"
        label-position="top"
        class="dialog-scroll"
      >
        <el-form-item label="QQ 号（必填）">
          <el-input
            v-model="onebotForm.qqNumber"
            placeholder="例如：123456789"
          />
        </el-form-item>
        <el-form-item label="OneBot WebSocket 地址（可选）">
          <el-input
            v-model="onebotForm.wsUrl"
            placeholder="默认 ws://127.0.0.1:3001"
          />
        </el-form-item>
        <el-form-item label="OneBot HTTP API 地址（可选）">
          <el-input
            v-model="onebotForm.httpUrl"
            placeholder="默认 http://127.0.0.1:3000"
          />
        </el-form-item>
        <el-form-item label="WS Token（可选）">
          <el-input
            v-model="onebotForm.accessToken"
            type="password"
            show-password
            placeholder="SnowLuma 的 WS token"
          />
        </el-form-item>
        <el-form-item label="HTTP Token（可选）">
          <el-input
            v-model="onebotForm.httpToken"
            type="password"
            show-password
            placeholder="SnowLuma 的 HTTP token（与 WS token 不同）"
          />
        </el-form-item>
        <el-form-item label="显示名（可选）">
          <el-input
            v-model="createForm.displayName"
            placeholder="例如：我的 QQ 小号"
          />
        </el-form-item>
        <el-form-item>
          <el-checkbox v-model="onebotForm.replyOnlyWhenMentioned">
            群聊中仅在被 @ 时才回复
          </el-checkbox>
        </el-form-item>
      </el-form>

      <el-form
        v-else
        label-position="top"
        class="dialog-scroll"
      >
        <el-form-item label="显示名（可选）">
          <el-input
            v-model="createForm.displayName"
            placeholder="例如：我的 B站 账号"
          />
        </el-form-item>
        <el-form-item label="数据目录（可选，对应 bili-desk 的 DATA_HOME）">
          <el-input
            v-model="biliForm.dataHome"
            placeholder="留空则用 bili-cli 默认目录"
          />
        </el-form-item>
        <el-form-item label="bili 可执行文件路径（可选）">
          <el-input
            v-model="biliForm.biliBin"
            placeholder="留空则从 BILI_BIN 或 PATH 里找"
          />
        </el-form-item>
        <el-form-item label="每天挑几条（0-50）">
          <el-input-number
            v-model="biliForm.perDay"
            :min="0"
            :max="50"
          />
        </el-form-item>
        <el-form-item label="谷时窗口">
          <el-checkbox v-model="biliForm.peakValley">
            只在谷时窗口刷
          </el-checkbox>
          <div style="display:flex;gap:16px;margin-top:8px">
            <el-checkbox v-model="biliForm.noon">
              中午 12-14 点
            </el-checkbox>
            <el-checkbox v-model="biliForm.night">
              夜间 18-次日 9 点
            </el-checkbox>
          </div>
        </el-form-item>
        <el-form-item label="关注关键词（每行一个，可留空）">
          <el-input
            v-model="biliForm.keywordsText"
            type="textarea"
            :rows="2"
            placeholder="例如：DeepSeek&#10;AI 绘画"
          />
        </el-form-item>
        <el-form-item label="热门分区">
          <el-select
            v-model="biliForm.zone"
            style="width:100%"
          >
            <el-option
              v-for="zone in ZONES"
              :key="zone"
              :label="zone === 'all' ? '全站' : zone"
              :value="zone"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="私信投递">
          <el-radio-group v-model="biliForm.dmMode">
            <el-radio-button value="only">
              只私信
            </el-radio-button>
            <el-radio-button value="both">
              私信 + 评论
            </el-radio-button>
            <el-radio-button value="off">
              都不发
            </el-radio-button>
          </el-radio-group>
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
.channel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;align-items:start}
.channel-card{display:flex;flex-direction:column;padding:16px 18px}
.channel-head{display:flex;align-items:flex-start;gap:11px}
.channel-icon{display:flex;width:36px;height:36px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--brand-soft);color:var(--brand);font-size:17px}
.channel-icon-bili{background:var(--accent-soft)}
.channel-info{min-width:0;flex:1}
.channel-name{margin:0;color:var(--text);font-size:14px;font-weight:700;letter-spacing:-.01em}
.channel-subtitle{margin:3px 0 0;color:var(--faint);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.channel-more{flex:0 0 auto;margin-left:-2px}
/* 删除是低频破坏性操作，收进卡片头的菜单 */
.more-trigger{display:flex;width:24px;height:24px;align-items:center;justify-content:center;border:0;border-radius:var(--radius-xs);background:transparent;color:var(--faint);cursor:pointer;transition:color .15s,background .15s}
.more-trigger:hover{color:var(--text-2);background:var(--surface-2)}

.binding-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:12px 0 2px;color:var(--dim);font-size:12px;font-weight:600}
.binding-title em{font-style:normal;color:var(--faint);font-weight:500}
.binding-empty{padding:8px 0;color:var(--faint);font-size:12px;line-height:1.7}
.binding-row{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:9px 0}
.binding-row:last-of-type{border-bottom:0}
.binding-name{color:var(--text-2);font-size:12px;font-weight:600}
.card-link.is-danger{color:var(--red)}
.card-link.is-danger:hover{color:#b02338}

.dialog-scroll{max-height:56vh;overflow-y:auto;padding-right:4px}
@media(max-width:1000px){.channel-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.channel-grid{grid-template-columns:1fr}}
</style>
