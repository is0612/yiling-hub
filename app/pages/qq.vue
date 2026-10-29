<script setup lang="ts">
/**
 * QQ 渠道（OneBot 小号）。
 *
 * 内容排序：① 号通不通（连接卡）② 怎么接进来（教程，只在第一次读）③ 凭据细节。
 * 页面只有两个视觉层：画布 --bg 上铺白砖，砖内用 --surface-2/3 分块，异常才上色。
 * 一个主操作（添加 QQ 小号），卡片上的按钮一律降成文字按钮。
 */
import {
  ChatDotRound,
  Connection,
  CopyDocument,
  Delete,
  Download,
  MagicStick,
  Monitor,
  Plus,
  Refresh,
  Right,
  Setting,
  User,
  Warning,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

useHead({ title: "QQ 渠道 · 忆灵小窝" });

type ChannelBinding = { id: string; characterId: string; characterName: string; routingKey: string | null };
/** 接口回显的明文凭据（管理员页可见）；解不开时为 null。 */
type QqCredentials = { wsUrl?: string; httpUrl?: string; accessToken?: string; httpToken?: string };
type QqConnection = {
  id: string; platform: string; displayName: string; appId: string | null; status: string;
  lastEventAt: string | null; createdAt: string; metadata: Record<string, unknown> | null;
  credentials?: QqCredentials | null;
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
const hasConnections = computed(() => connections.value.length > 0);

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

/**
 * 协议端二选一：SnowLuma 与 NapCat 都是 OneBot v11，填的地址一样，差别只在「怎么装、开几个 token」。
 * 默认选 SnowLuma —— NapCat 自己的 README 就推荐它做 GUI 替代，且自带 WebUI 省一步。
 */
type ProxyKind = "snowluma" | "napcat";

type ProxyPreset = {
  key: ProxyKind;
  name: string;
  tagline: string;
  repo: string;
  /** 配置 OneBot 的那个页面地址，不是面板首页。 */
  panel: string;
  /** 一步一步点哪儿：每条一个动作，值直接写死在句子里。 */
  steps: string[];
  /** 最容易踩的那一处，单独高亮。 */
  warn: string;
};

const PROXY_PRESETS: ProxyPreset[] = [
  {
    key: "snowluma",
    name: "SnowLuma",
    tagline: "自带网页面板，装完直接点。第一次弄建议用它。",
    repo: "https://github.com/SnowLuma/SnowLuma/releases",
    panel: "http://127.0.0.1:5099/config",
    steps: [
      "打开上面的地址，登录面板。首次的账号密码打印在协议端的启动日志里，只出现一次 —— 登录后先把密码改掉。",
      "左栏选中你的 QQ 小号那一栏。",
      "右边「节点配置分类」切到「WS 服务端」：列表里已有端口 3001 的节点（比如 ws-default）就直接点它，别再新建 —— 两个节点抢同一个端口，后启动的那个起不来；列表是空的才点「新建」，弹窗里的默认值（端口 3001、数组、Universal）不用改，直接按「创建节点」。",
      "再切到「HTTP API」：已有节点就把端口从默认的 3000 改成 3002 —— 3000 是本站 dev server 的端口，撞上就一条消息都发不出去；列表是空的才「新建」一个端口 3002 的。",
      "复制这两个节点的令牌（弹窗里授权 Token 旁的复制图标，之后点开节点也能复制）：WS 的填进下面「WS Token」，HTTP 的填「HTTP Token」。",
      "保存，重启协议端。",
    ],
    warn: "⚠️ 端口和令牌都在 /config 页，不在 /settings（那里只有备份、存储、外观，翻不到任何 OneBot 项）。两个令牌是不一样的，填反了握手直接 401。",
  },
  {
    key: "napcat",
    name: "NapCatQQ",
    tagline: "用的人最多、教程最多；面板里要多点几步。",
    repo: "https://github.com/NapNeko/NapCatQQ/releases",
    panel: "http://127.0.0.1:6099/webui/",
    steps: [
      "打开上面的地址，用启动终端里显示的 token 登录。",
      "「网络配置」→「新建」→ 类型选「HTTP 服务器」：端口填 3002（默认的 3000 会撞本站 dev server）。",
      "再「新建」→ 类型选「WebSocket 服务器」：端口填 3001。",
      "两个都设同一个 Access Token，记下来。",
      "保存，重启 NapCat。",
    ],
    warn: "NapCat 通常只有一个 Access Token，下面两个框填同一个值即可。",
  },
];

const proxyKind = ref<ProxyKind>("snowluma");
const proxy = computed(() => PROXY_PRESETS.find((item) => item.key === proxyKind.value) ?? PROXY_PRESETS[0]!);

// ── 添加 / 编辑 ─────────────────────────────────────────────
const editVisible = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);
/** 点开「连接设置」后要单独取一次明文凭据，取回来之前别让人往空框里打字（会被回填覆盖）。 */
const credLoading = ref(false);
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
  credLoading.value = false;
  resetForm();
  editVisible.value = true;
}

function fillDefaultUrls() {
  if (!form.wsUrl.trim()) form.wsUrl = "ws://127.0.0.1:3001";
  if (!form.httpUrl.trim()) form.httpUrl = "http://127.0.0.1:3002";
}

/**
 * 打开「连接设置」。必须 async —— 里面要单独取一次明文凭据（列表不带着下发）。
 * 之前漏了 async，`await` 在非 async 函数里是语法错误，整个 SFC 编译失败，页面直接打不开。
 */
async function openEdit(connection: QqConnection) {
  editingId.value = connection.id;
  resetForm();
  form.qqNumber = connection.appId || "";
  form.displayName = connection.appId ? connection.displayName : "";
  form.replyOnlyWhenMentioned = readMentionOnly(connection);
  editVisible.value = true;

  /**
   * 明文凭据不跟着列表下发（SSR 会把它写进页面 HTML），打开弹窗时才单独取一次。
   * 取失败就保持空 —— 留空保存 = 沿用原值，不会把 token 清掉。
   */
  credLoading.value = true;
  try {
    const detail = await request<{ connections: QqConnection[] }>("/api/admin/channels?withCredentials=1");
    const found = detail.connections.find((item) => item.id === connection.id);
    form.wsUrl = found?.credentials?.wsUrl ?? "";
    form.httpUrl = found?.credentials?.httpUrl ?? "";
    form.accessToken = found?.credentials?.accessToken ?? "";
    form.httpToken = found?.credentials?.httpToken ?? "";
  } catch {
    // 忽略：列表还在，表单留空也能保存。
  } finally {
    credLoading.value = false;
  }
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
  <div class="page-wrap qq-a">
    <PageHeader
      eyebrow="系统管理 / QQ 渠道"
      title="QQ 渠道"
      description="用个人 QQ 小号挂 AI：协议端把 QQ 消息翻译成 OneBot v11 推过来，角色带着记忆回复。"
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
        <!-- 还没有号的时候，主操作让给空态那一行 —— 同一个动作在屏幕上出现两次会分散注意力 -->
        <button
          v-if="hasConnections"
          type="button"
          class="btn primary"
          @click="openCreate"
        >
          <el-icon><Plus /></el-icon>添加 QQ 小号
        </button>
      </template>
    </PageHeader>

    <!-- 有连接时把卡片提到教程前面：日常要管的是号，教程只在第一次读 -->
    <div
      class="qq-body"
      :class="{ 'has-list': hasConnections }"
    >
      <section class="conns">
        <div class="sec-label">
          <h2>已接入的号</h2>
          <span class="count">{{ connections.length }}</span>
          <span class="note">地址与 Token 加密存库，仅此处回显明文</span>
        </div>

        <div
          v-if="loading && !connections.length"
          class="conn-grid"
        >
          <div
            v-for="i in 2"
            :key="'sk-' + i"
            class="conn-card is-skeleton"
          >
            <div
              v-for="n in 4"
              :key="n"
              class="sk"
              :style="{ height: n === 1 ? '36px' : '14px', width: n === 1 ? '60%' : '100%' }"
            />
          </div>
        </div>

        <div
          v-else-if="!connections.length"
          class="qq-empty"
        >
          <span class="empty-icon"><el-icon><ChatDotRound /></el-icon></span>
          <div class="empty-copy">
            <h3>还没有 QQ 小号</h3>
            <p>按下面四步把协议端跑起来，再回来添加 —— QQ 上的对话才会接到角色身上。</p>
          </div>
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
          class="conn-grid"
        >
          <article
            v-for="connection in connections"
            :key="connection.id"
            class="conn-card"
          >
            <div class="conn-head">
              <span class="conn-icon"><el-icon><ChatDotRound /></el-icon></span>
              <div class="conn-id">
                <h3 class="conn-name">
                  {{ connection.displayName }}
                </h3>
                <p class="conn-sub">
                  QQ 小号 · {{ connection.appId || "未填 QQ 号" }}
                </p>
              </div>
              <span
                class="pill"
                :class="statusMap[connection.status]?.tone ?? 'pill-gray'"
              >{{ statusMap[connection.status]?.label ?? connection.status }}</span>
            </div>

            <dl class="conn-facts">
              <div>
                <dt>最近活动</dt>
                <dd>{{ formatDateTime(connection.lastEventAt) }}</dd>
              </div>
              <div>
                <dt>群聊</dt>
                <dd>{{ readMentionOnly(connection) ? "仅被 @ 时回复" : "所有消息都回复" }}</dd>
              </div>
              <div>
                <dt>适配器</dt>
                <dd><code>yarn onebot:run</code></dd>
              </div>
            </dl>

            <div class="conn-bind">
              <div class="bind-h">
                <span>已绑定角色</span>
                <span class="n">{{ connection.bindings.length }}</span>
              </div>
              <p
                v-if="!connection.bindings.length"
                class="bind-empty"
              >
                还没绑定角色 —— 这个号现在不会回复任何消息。
              </p>
              <ul
                v-else
                class="bind-list"
              >
                <li
                  v-for="binding in connection.bindings"
                  :key="binding.id"
                  class="bind-row"
                >
                  <div class="bind-id">
                    <b>{{ binding.characterName }}</b>
                    <span>{{ binding.routingKey ? "只响应群 " + binding.routingKey : "私聊 + 所有群" }}</span>
                  </div>
                  <button
                    type="button"
                    class="tlink is-danger"
                    @click="unbind(connection, binding)"
                  >
                    解绑
                  </button>
                </li>
              </ul>
            </div>

            <div class="conn-foot">
              <button
                type="button"
                class="tlink is-danger"
                @click="removeConnection(connection)"
              >
                <el-icon><Delete /></el-icon>删除连接
              </button>
              <span class="grow" />
              <button
                type="button"
                class="abtn"
                @click="openEdit(connection)"
              >
                <el-icon><Setting /></el-icon>连接设置
              </button>
              <button
                type="button"
                class="abtn"
                @click="openBind(connection)"
              >
                <el-icon><User /></el-icon>绑定角色
              </button>
            </div>
          </article>
        </div>
      </section>

      <div class="guide">
        <!-- ① 先讲清楚消息怎么走：小白最缺的是这张图，不是操作步骤 -->
        <section class="brick flow-card">
          <div class="card-h">
            <h2>消息怎么走</h2>
            <span class="card-sub">看懂这条线，第 3 步填什么心里就有数</span>
          </div>
          <figure class="flow-fig">
            <div class="flow">
              <div class="flow-node">
                <span class="flow-icon"><el-icon><ChatDotRound /></el-icon></span>
                <span class="flow-name">你的 QQ 小号</span>
                <span class="flow-desc">官方客户端登录着，窗口不能关</span>
              </div>
              <div
                class="flow-arrow"
                aria-hidden="true"
              >
                <el-icon><Right /></el-icon>
              </div>
              <div class="flow-node">
                <span class="flow-icon"><el-icon><Connection /></el-icon></span>
                <span class="flow-name">协议端</span>
                <span class="flow-desc">SnowLuma 或 NapCat，把 QQ 消息翻译出来</span>
              </div>
              <div
                class="flow-arrow"
                aria-hidden="true"
              >
                <el-icon><Right /></el-icon>
              </div>
              <div class="flow-node">
                <span class="flow-icon"><el-icon><Monitor /></el-icon></span>
                <span class="flow-name">本站适配器</span>
                <span class="flow-desc"><code>yarn onebot:run</code>，接住消息</span>
              </div>
              <div
                class="flow-arrow"
                aria-hidden="true"
              >
                <el-icon><Right /></el-icon>
              </div>
              <div class="flow-node is-end">
                <span class="flow-icon"><el-icon><MagicStick /></el-icon></span>
                <span class="flow-name">角色</span>
                <span class="flow-desc">带着记忆回复，再原路发回 QQ</span>
              </div>
            </div>
            <figcaption class="flow-foot">
              中间那段走的是 <code>OneBot v11</code> —— 所以不管装哪个协议端，第 3 步填的地址都一样。
              前三个都在你自己电脑上跑，只有最后一步发生在这里。
            </figcaption>
          </figure>
        </section>

        <!-- ② 四步：一句话一件事，细节收进折叠 -->
        <section class="brick steps-card">
          <div class="card-h">
            <h2>四步接通</h2>
            <span class="card-sub">第一次大约十分钟</span>
          </div>
          <ol class="steps">
            <li class="step">
              <span class="step-no">1</span>
              <div class="step-body">
                <h3>装一个协议端，把 QQ 挂上去</h3>
                <p>
                  协议端是个小软件，作用是替你把 QQ 的消息翻译成程序能读的格式。两个选一个装就行 ——
                  它们说的是同一套协议，填的地址也一样。
                </p>
                <div class="pick">
                  <button
                    v-for="preset in PROXY_PRESETS"
                    :key="preset.key"
                    type="button"
                    class="pick-option"
                    :class="{ active: proxyKind === preset.key }"
                    @click="proxyKind = preset.key"
                  >
                    <span class="pick-name">
                      {{ preset.name }}
                      <span
                        v-if="preset.key === 'snowluma'"
                        class="pick-badge"
                      >推荐</span>
                    </span>
                    <span class="pick-desc">{{ preset.tagline }}</span>
                  </button>
                </div>
                <p class="step-line">
                  <a
                    :href="proxy.repo"
                    target="_blank"
                    rel="noopener noreferrer"
                  ><el-icon><Download /></el-icon>{{ proxy.name }} 下载页</a>
                  <span class="sep">·</span>装好后用<strong>官方 QQ 客户端</strong>登录小号，那个窗口全程别关 —— 协议端是挂在这个已登录的窗口上收发消息的，不是自己扫码。
                </p>
                <p class="step-note">
                  怎么确认挂上了：看协议端自己的日志，出现 <code>login detected … UIN=你的小号</code> 才算数。
                </p>
              </div>
            </li>

            <li class="step">
              <span class="step-no">2</span>
              <div class="step-body">
                <h3>在协议端里开两个口子</h3>
                <p>
                  一个收消息（WebSocket，端口 3001），一个发消息（HTTP，端口 3002）。
                  面板地址：<a
                    :href="proxy.panel"
                    target="_blank"
                    rel="noopener noreferrer"
                  ><code>{{ proxy.panel }}</code></a>，粘到浏览器地址栏就能打开。
                </p>
                <details class="step-more">
                  <summary>
                    <span class="caret"><el-icon><Right /></el-icon></span>
                    面板里具体点哪儿（{{ proxy.steps.length }} 步）
                  </summary>
                  <ol class="mini">
                    <li
                      v-for="(step, index) in proxy.steps"
                      :key="index"
                    >
                      {{ step }}
                    </li>
                  </ol>
                  <p class="warn">
                    {{ proxy.warn }}
                  </p>
                </details>
              </div>
            </li>

            <li class="step">
              <span class="step-no">3</span>
              <div class="step-body">
                <h3>回到这里填连接，再绑一个角色</h3>
                <p>
                  把 QQ 号、两个地址、两个 Token 填进「添加 QQ 小号」。地址按上一步的端口来：WS 是
                  <code>ws://127.0.0.1:3001</code>，HTTP 是 <code>http://127.0.0.1:3002</code>。
                </p>
                <p>
                  保存后在这张卡上点「绑定角色」—— 不绑角色，消息进来了也没人回。
                </p>
                <button
                  type="button"
                  class="abtn is-lead"
                  @click="openCreate"
                >
                  <el-icon><Plus /></el-icon>添加 QQ 小号
                </button>
              </div>
            </li>

            <li class="step">
              <span class="step-no">4</span>
              <div class="step-body">
                <h3>启动适配器</h3>
                <p>
                  项目根目录执行下面这条，看到 <code>onebot-connected</code> 就通了。
                  这个窗口要一直开着，关掉就不回消息。
                </p>
                <button
                  type="button"
                  class="cmd"
                  title="点击复制"
                  @click="copyCommand('yarn onebot:run')"
                >
                  <code>yarn onebot:run</code>
                  <el-icon><CopyDocument /></el-icon>
                </button>
              </div>
            </li>
          </ol>
        </section>

        <!-- ③ 排查：症状在前、原因在后，比一长串「如果…」好扫 -->
        <section class="brick fix-card">
          <div class="card-h">
            <h2>连不上，按这个顺序查</h2>
            <span class="card-sub">八成是前三样</span>
          </div>
          <dl class="fix-list">
            <div class="fix-row">
              <dt>协议端日志里没有 <code>UIN=小号</code></dt>
              <dd>小号还没在官方 QQ 客户端里登上，或者那个窗口被关了。</dd>
            </div>
            <div class="fix-row">
              <dt>适配器报连不上 3001</dt>
              <dd>协议端里 WS 节点没开，或端口不是 3001 —— 回第 2 步核对。</dd>
            </div>
            <div class="fix-row">
              <dt>能连上，但一条都不回</dt>
              <dd>没绑角色，或者角色还没配模型 API Key。</dd>
            </div>
            <div class="fix-row">
              <dt>发不出去 / 握手 401</dt>
              <dd>两个 Token 填反了（WS 和 HTTP 是两把不同的钥匙），或者 HTTP 端口和面板里不一致。</dd>
            </div>
            <div class="fix-row">
              <dt>群里太吵</dt>
              <dd>到「连接设置」的「群聊里怎么回」勾上「只有被 @ 时才回复」。</dd>
            </div>
            <div class="fix-row">
              <dt>想让她发表情</dt>
              <dd>去「角色 → 模型设置」打开「QQ 渠道发表情」。</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>

    <!-- ── 连接设置 / 添加 ───────────────────────────────── -->
    <el-dialog
      v-model="editVisible"
      :title="editingId ? '连接设置' : '添加 QQ 小号'"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form
        label-position="top"
        class="cq-form"
        autocomplete="off"
        @submit.prevent="submitConnection"
      >
        <div class="cq-sec is-first">
          <div class="cq-sec-h">
            <span>身份</span>
          </div>
          <div class="cq-id">
            <el-form-item
              label="QQ 号"
              required
            >
              <el-input
                v-model="form.qqNumber"
                :disabled="!!editingId"
                placeholder="小号的数字 QQ 号"
              />
            </el-form-item>
            <el-form-item label="显示名（可留空）">
              <el-input
                v-model="form.displayName"
                placeholder="例如：我的 QQ 小号"
              />
            </el-form-item>
          </div>
        </div>

        <div class="cq-sec">
          <div class="cq-sec-h">
            <span>协议端地址与 Token</span>
            <button
              v-if="!editingId"
              type="button"
              class="cq-fill"
              @click="fillDefaultUrls"
            >
              填入默认地址
            </button>
          </div>
          <p class="cq-hint">
            端口要和协议端面板里一致：收消息 3001，发消息 3002。<strong>别用 3000</strong>，那是本站 dev server 的端口。
            <em v-if="credLoading">正在读取已保存的值…</em>
          </p>
          <div class="cq-pair">
            <el-form-item label="WS 地址（收消息）">
              <el-input
                v-model="form.wsUrl"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用已保存的地址' : 'ws://127.0.0.1:3001'"
              />
            </el-form-item>
            <el-form-item label="WS Token">
              <el-input
                v-model="form.accessToken"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用原值' : '没设就留空'"
              />
            </el-form-item>
          </div>
          <div class="cq-pair">
            <el-form-item label="HTTP 地址（发消息）">
              <el-input
                v-model="form.httpUrl"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用已保存的地址' : 'http://127.0.0.1:3002'"
              />
            </el-form-item>
            <el-form-item label="HTTP Token">
              <el-input
                v-model="form.httpToken"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用原值' : 'NapCat 与上面填同一个'"
              />
            </el-form-item>
          </div>
          <p class="cq-warn">
            <el-icon><Warning /></el-icon>
            <span>
              Token 是密码框，浏览器可能自动填上你登录本站的账号密码 —— 那不是协议端令牌，保存前先清空再粘。
              <template v-if="!editingId">两个都要有：少了 WS 收不到，少了 HTTP 发不出去。</template>
            </span>
          </p>
        </div>

        <div class="cq-sec">
          <div class="cq-sec-h">
            <span>群聊里怎么回</span>
          </div>
          <el-form-item class="cq-check">
            <el-checkbox v-model="form.replyOnlyWhenMentioned">
              只有被 @ 时才回复
            </el-checkbox>
          </el-form-item>
          <p class="cq-hint">
            不勾就是群里每条都回 —— 人多的群会很吵。私聊不受这条影响，永远是回的。
          </p>
        </div>
      </el-form>

      <template #footer>
        <div class="cq-foot">
          <span class="cq-foot-note">
            {{ editingId ? "改完记得重启 yarn onebot:run" : "同一个 QQ 号再存一次是更新，不会重复创建" }}
          </span>
          <span class="cq-foot-actions">
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
          </span>
        </div>
      </template>
    </el-dialog>

    <!-- ── 绑定角色 ─────────────────────────────────────── -->
    <el-dialog
      v-model="bindVisible"
      title="绑定角色"
      width="460px"
      :close-on-click-modal="false"
    >
      <el-form
        label-position="top"
        class="cq-form"
      >
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
        <el-form-item label="群号（可留空）">
          <el-input
            v-model="bindForm.routingKey"
            placeholder="留空 = 私聊 + 所有群都回复"
          />
        </el-form-item>
        <p class="cq-hint">
          填了群号就只在这个群里回复。想同时听多个群，给同一个角色多绑几条，每条填一个群号。
        </p>
      </el-form>

      <template #footer>
        <div class="cq-foot">
          <span class="cq-foot-note">绑完立刻生效，不用重启适配器</span>
          <span class="cq-foot-actions">
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
          </span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览 / 角色管理 / 阶段总结的 A 套：画布上铺白砖，零描边零阴影，
   层次只靠明度差 + 间距；砖内再分块时才用 --surface-2/3。
   全部规则挂在 .qq-a 下，既锁住作用域，也压过 main.css 的 .card/.btn (0,1,0)。
   ══════════════════════════════════════════════════════════════ */

/* 顺序控制：有连接时「已接入的号」提到教程前面 */
.qq-body { display: flex; flex-direction: column; gap: var(--sp-4); }
.qq-body.has-list .conns { order: -1; }
.guide { display: flex; flex-direction: column; gap: var(--sp-4); }

.brick { border-radius: 10px; background: var(--surface); padding: 18px 20px 16px; }

/* 卡片标题：短标签，不跟正文抢 */
.card-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.card-h h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.card-sub { color: var(--dim); font-size: 12px; }

/* 区块标题（连接列表） */
.sec-label { display: flex; align-items: baseline; gap: 8px; margin-bottom: var(--sp-3); }
.sec-label h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.sec-label .count { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.sec-label .note { margin-left: auto; color: var(--dim); font-size: 12px; }

/* ── ① 流程图 ─────────────────────────────────────── */
.flow-fig { margin: 14px 0 0; }
.flow { display: flex; align-items: stretch; gap: 8px; }
/* 四块等宽：节点内容长短不一，flex:1 让它们齐平，箭头宽度独立。
   竖向居中 —— 说明文字断成两行的那块，图标和标题不会贴顶 */
.flow-node {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border-radius: 8px;
  background: var(--surface-3);
  padding: 14px 10px 12px;
  text-align: center;
}
/* 终点用品牌软底：整张图只上这一处颜色 */
.flow-node.is-end { background: var(--brand-soft); }
.flow-icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  font-size: 16px;
}
.flow-node.is-end .flow-icon { color: var(--brand); }
.flow-name { color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.4; }
.flow-desc { color: var(--dim); font-size: 12px; line-height: 1.55; }
.flow-node.is-end .flow-desc { color: #8f3a55; }
.flow-arrow { display: flex; flex: none; align-items: center; color: var(--faint); font-size: 16px; }
.flow-foot {
  margin: 12px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.75;
  max-width: 74ch;
}

/* ── ② 四步 ───────────────────────────────────────── */
.steps { display: flex; flex-direction: column; margin: 6px 0 0; padding: 0; list-style: none; }
.step {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 12px;
  border-top: 1px solid var(--surface-3);
  padding: 16px 0;
}
.step:first-child { border-top: 0; padding-top: 10px; }
.step:last-child { padding-bottom: 0; }
/* 圆形序号：品牌软底 + 品牌色字，纯装饰，所以只有 24px */
.step-no {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 700;
}
.step-body { min-width: 0; }
.step-body h3 { margin: 0 0 6px; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.4; }
/* 正文字号 14、行宽 68ch：这几段是要照着做的，别拉成一行 100 多字 */
.step-body p { max-width: 68ch; margin: 0 0 8px; color: var(--text-2); font-size: 14px; line-height: 1.75; }
.step-body p:last-child { margin-bottom: 0; }
.step-body strong { color: var(--text); font-weight: 600; }
.step-note { color: var(--dim) !important; font-size: 12px !important; line-height: 1.7 !important; }
/* 行内链接：不整体 flex，否则那句长文案会变成一个独立 flex item，
   窄屏时链接和正文各占一行、缩进对不上。图标单独抬 2px 跟基线走。 */
.step-line a,
.step-body a { display: inline-flex; align-items: center; gap: 4px; color: #bf3a63; font-weight: 600; }
.step-line a:hover,
.step-body a:hover { text-decoration: underline; text-underline-offset: 3px; }
.step-line .el-icon { margin-right: 2px; font-size: 13px; vertical-align: -2px; }
.sep { margin: 0 5px; color: var(--faint); }

/* 协议端二选一：选中态只换底色，不加描边。
   宽度跟着内容收在 640：两个 300 的卡配一行说明刚好，拉满 1100 会像两条横幅 */
.pick { display: grid; max-width: 640px; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.pick-option {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  transition: background .14s var(--ease);
}
.pick-option:hover { background: var(--surface-3); }
.pick-option.active { background: var(--brand-soft); }
.pick-name { display: flex; align-items: center; gap: 6px; color: var(--text); font-size: 14px; font-weight: 600; }
.pick-option.active .pick-name { color: var(--brand-strong); }
.pick-badge {
  border-radius: 999px;
  background: var(--brand-btn);
  padding: 2px 6px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
}
.pick-desc { color: var(--dim); font-size: 12px; line-height: 1.6; }

/* 折叠：默认只露一句话，想动手再展开 */
.step-more { margin-top: 10px; }
.step-more summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 6px 11px 6px 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}
.step-more summary::-webkit-details-marker { display: none; }
.step-more summary:hover { background: var(--surface-3); }
.step-more .caret { display: inline-flex; color: var(--faint); font-size: 12px; transition: transform .14s var(--ease); }
.step-more[open] .caret { transform: rotate(90deg); }
.mini {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0 0;
  padding-left: 20px;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.7;
}
.mini li { max-width: 66ch; }
.mini li::marker { color: var(--brand); font-weight: 700; }

/* 警告块：左竖条 + 软底。文字用 #8f5c05（4.7:1），--amber 只有 4.26:1 */
.warn {
  display: flex;
  gap: 7px;
  max-width: 68ch !important;
  margin-top: 10px;
  border-radius: 8px;
  background: var(--amber-soft);
  padding: 8px 11px;
  color: #8f5c05 !important;
  font-size: 12px !important;
  line-height: 1.7 !important;
}

.cmd {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 8px 11px;
  color: var(--text-2);
  cursor: pointer;
  transition: background .14s var(--ease);
}
.cmd:hover { background: var(--brand-soft); color: var(--brand-strong); }
.cmd .el-icon { color: var(--faint); font-size: 13px; }
.cmd:hover .el-icon { color: var(--brand); }

/* ── ③ 排查清单 ───────────────────────────────────── */
.fix-list { display: flex; flex-direction: column; margin: 8px 0 0; }
/* 症状 / 原因两列：症状最长也就 12 个字，给 0.62 列就够 ——
   1:1 会在中间留一条 250px 的空沟，右边那列反而变窄 */
.fix-row {
  display: grid;
  grid-template-columns: minmax(0, 0.62fr) minmax(0, 1.38fr);
  gap: 8px 20px;
  align-items: baseline;
  border-top: 1px solid var(--surface-3);
  padding: 9px 0;
}
.fix-row:first-child { border-top: 0; }
.fix-row dt { color: var(--text-2); font-size: 14px; font-weight: 600; }
.fix-row dd { margin: 0; color: var(--dim); font-size: 14px; line-height: 1.7; }

/* 行内代码：整页统一一处，别在各段里各写一遍 */
.qq-a code,
.brick code,
.cmd code {
  border-radius: 4px;
  background: var(--surface-3);
  padding: 1px 5px;
  color: var(--text-2);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.flow-node.is-end code,
.flow-node code { background: rgba(255, 255, 255, .7); }
.cmd code { background: none; padding: 0; color: inherit; font-size: 14px; }

/* ── 连接卡 ───────────────────────────────────────── */
.conn-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: var(--sp-4); align-items: start; }
.conn-card {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 18px 12px;
}
.conn-card.is-skeleton { gap: 10px; }
.conn-head { display: flex; align-items: flex-start; gap: 11px; }
.conn-icon {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 17px;
}
.conn-id { min-width: 0; flex: 1; }
.conn-name { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.conn-sub { margin: 2px 0 0; color: var(--dim); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }

/* 三个时点并排：值和标签都在同一条基线上，不画分隔线 */
.conn-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin: 14px 0 0;
  border-top: 1px solid var(--surface-3);
  padding-top: 12px;
}
.conn-facts dt { color: var(--dim); font-size: 12px; }
.conn-facts dd { margin: 2px 0 0; color: var(--text-2); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.conn-facts dd code { background: none; padding: 0; font-size: 12px; }

.conn-bind { margin-top: 14px; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.bind-h { display: flex; align-items: baseline; gap: 6px; color: var(--dim); font-size: 12px; font-weight: 600; }
.bind-h .n { font-variant-numeric: tabular-nums; }
.bind-empty { margin: 6px 0 0; color: var(--text-2); font-size: 14px; line-height: 1.6; }
.bind-list { display: flex; flex-direction: column; margin: 4px 0 0; padding: 0; list-style: none; }
.bind-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.bind-id { min-width: 0; flex: 1; }
.bind-id b { display: block; color: var(--text-2); font-size: 14px; font-weight: 600; }
.bind-id span { color: var(--dim); font-size: 12px; }

.conn-foot { display: flex; align-items: center; gap: 4px; margin-top: 12px; border-top: 1px solid var(--surface-3); padding-top: 8px; }
.conn-foot .grow { flex: 1; }

/* 文字按钮：卡片上的动作一律降调，主色只留给 hover */
.abtn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 8px;
  background: none;
  padding: 0 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.abtn .el-icon { color: var(--faint); font-size: 14px; }
.abtn:hover { background: var(--surface-2); color: var(--brand-strong); }
.abtn:hover .el-icon { color: var(--brand); }
.abtn.is-lead { margin-top: 4px; background: var(--surface-2); }

/* 危险动作：常态灰、hover 才红。删除不该和主操作一样响 */
.tlink {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 7px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.tlink .el-icon { font-size: 13px; }
.tlink.is-danger:hover { background: var(--red-soft); color: var(--red); }

/* 空态：一行说完 + 右边给按钮。不做 240px 高的大白块 ——
   这一屏真正要读的是下面的流程图，空态抢走一半高度反而把人挡住。 */
.qq-empty {
  display: flex;
  align-items: center;
  gap: 14px;
  border-radius: 10px;
  background: var(--surface);
  padding: 16px 18px;
}
.empty-icon {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20px;
}
.empty-copy { min-width: 0; flex: 1; }
.empty-copy h3 { margin: 0; color: var(--text); font-size: 14px; font-weight: 700; }
.empty-copy p { margin: 3px 0 0; color: var(--dim); font-size: 12px; line-height: 1.65; }
.qq-empty .btn.primary { flex: none; }

/* 页头按钮：A 套的次要按钮是纯文字，hover 才出下划线 */
.qq-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.qq-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
.qq-a .btn.primary { background: var(--brand-btn); color: #fff; padding: 0 14px; }
.qq-a .btn.primary:hover { background: var(--brand-btn-h); color: #fff; text-decoration: none; }

/* ── 弹窗：三组（身份 / 地址与 Token / 群聊），每组一个小标题 ──────
   弹窗是 teleport 出去的，外壳样式在 main.css；这里只管插槽里自己的元素，
   Element 的 .el-form-item 要靠 :deep —— 插槽内容带本组件的 scope id，能命中。 */
.cq-form { display: flex; flex-direction: column; gap: 18px; }
.cq-form :deep(.el-form-item) { margin-bottom: 0; }
.cq-form :deep(.el-form-item__content) { min-width: 0; }
.cq-id { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 16px; }
.cq-pair { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 0 16px; }

/* 分组：一条 1px 的 --surface-3 起头，比加卡片边框轻。
   组内 10、组间 18 —— 组距必须大于组内距，否则看起来是六个平行字段 */
.cq-sec { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--surface-3); padding-top: 16px; }
.cq-sec.is-first { border-top: 0; padding-top: 0; }
.cq-sec-h { display: flex; align-items: baseline; gap: 10px; }
/* 小标题要压过字段标签（12/500）：14/700 + 同色，只差字号和字重 */
.cq-sec-h span { color: var(--text-2); font-size: 14px; font-weight: 700; }
.cq-fill { margin-left: auto; border: 0; background: none; padding: 0; color: var(--brand-strong); font-size: 12px; font-weight: 600; cursor: pointer; }
.cq-fill:hover { text-decoration: underline; }
.cq-hint { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.cq-hint strong { color: var(--text-2); font-weight: 600; }
.cq-hint em { color: var(--brand-strong); font-style: normal; }

.cq-warn {
  display: flex;
  gap: 7px;
  border-radius: 8px;
  background: var(--amber-soft);
  padding: 8px 10px;
  color: #8f5c05;
  font-size: 12px;
  line-height: 1.7;
}
.cq-warn .el-icon { margin-top: 2px; flex: none; font-size: 14px; }

.cq-check :deep(.el-checkbox) { height: 20px; }

.cq-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cq-foot-note { color: var(--dim); font-size: 12px; text-align: left; }
.cq-foot-actions { display: flex; }

/* ── 自适应 ───────────────────────────────────────── */
@media (max-width: 1080px) {
  .conn-grid { grid-template-columns: minmax(0, 1fr); }
  .fix-row { grid-template-columns: minmax(0, 1fr); gap: 3px; }
}
/* 流程图横向排到 900 才折：1080 的视口里 4 块各还有 180，竖排反而更像一个列表 */
@media (max-width: 900px) {
  .flow { flex-direction: column; }
  /* 竖排时箭头要朝下：转 90° 比换图标省事，也不会错位 */
  .flow-arrow { justify-content: center; padding: 1px 0; }
  .flow-arrow .el-icon { transform: rotate(90deg); }
  .flow-node { flex-direction: row; gap: 10px; align-items: center; padding: 11px 12px; text-align: left; }
  /* 名字定宽：竖排时四个说明文字才能左对齐，不然每个节点各起一行 */
  .flow-node .flow-name { flex: 0 0 auto; min-width: 88px; }
  .flow-node .flow-desc { flex: 1; }
}
@media (max-width: 720px) {
  .brick { padding: 16px 15px 14px; }
  .conn-card { padding: 14px 15px 10px; }
  .conn-facts { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .sec-label .note { display: none; }
  .conn-foot { flex-wrap: wrap; }
  .pick { grid-template-columns: minmax(0, 1fr); }
  .step { grid-template-columns: 24px minmax(0, 1fr); gap: 10px; }
  .flow-node { flex-wrap: wrap; }
  /* 空态换行：文案先占满一行，按钮落到下一行、和文案左边缘对齐 */
  .qq-empty { flex-wrap: wrap; align-items: flex-start; row-gap: 10px; }
  .empty-copy { flex-basis: calc(100% - 54px); }
  .qq-empty .btn.primary { margin-left: 54px; }
}
@media (max-width: 560px) {
  .cq-id,
  .cq-pair { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .cq-foot { flex-direction: column-reverse; align-items: stretch; gap: 10px; }
  .cq-foot-actions { justify-content: flex-end; }
  .cq-foot-note { text-align: center; }
}
</style>
