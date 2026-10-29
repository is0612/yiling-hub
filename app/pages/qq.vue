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
  CopyDocument,
  Delete,
  Download,
  FolderOpened,
  Plus,
  Refresh,
  Right,
  Setting,
  User,
  VideoPlay,
  Warning,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { ChainActionKind } from "~/utils/qq-channel";
import type { Character } from "~/utils/mock-data";

useHead({ title: "QQ 渠道 · 忆灵小窝" });

type GroupChatSettings = {
  mode: "mention" | "ambient" | "all";
  batchWindowSeconds: number;
  mentionWindowSeconds: number;
  minGapSeconds: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  ambientChance: number;
  aliases: string[];
};

type ChannelBinding = {
  id: string;
  characterId: string;
  characterName: string;
  routingKey: string | null;
  /** 群聊限流窗口（分钟）与窗口内上限；上限 0 = 不限。 */
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  /** 群聊是否仅被 @ 时才回复（后端已回退到连接默认值）。 */
  replyOnlyWhenMentioned: boolean;
  /** 群聊怎么回：模式 + 攒批/闸门参数，后端已解析好默认值。 */
  groupChat: GroupChatSettings;
  /** 主人能否在群里触发刷一轮 B站（后端已回退到连接默认值）。 */
  groupBiliRunEnabled: boolean;
};
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
const hasLoadError = computed(() => Boolean(error.value));

/**
 * 链路轨只画一条：网关端口、适配器进程本来就是整台机器共用的一份，
 * 多个号时按第一个号画，其余号的差别只在「有没有绑角色」。
 */
const primaryConnection = computed(() => connections.value[0] ?? null);
const primaryBinding = computed(() => primaryConnection.value?.bindings[0] ?? null);

/**
 * 一张卡对应一条绑定（角色 ↔ 号/群）：群号、群聊回复、限流、刷 B站 都是绑定级，
 * 跟着绑定走；发表情、主动找话是角色级，多绑定时在每张卡里复用（改的是同一个角色）。
 * 角色基本只有一个，所以通常就一张卡。
 */
const boundBindings = computed(() => {
  const result: Array<{ binding: ChannelBinding; connection: QqConnection; character: Character }> = [];
  for (const connection of connections.value) {
    for (const binding of connection.bindings) {
      const character = characters.value.find((item) => item.id === binding.characterId);
      if (character) result.push({ binding, connection, character });
    }
  }
  return result;
});

async function refreshCharacters() {
  await loadCharacters();
}

/** 角色卡里改了绑定级或角色级字段，都回来刷新一次（连接列表 + 角色列表）。 */
async function onBehaviorSaved() {
  await refresh();
  await refreshCharacters();
}

// ── 这条链路上的两个进程 ────────────────────────────────
/**
 * SnowLuma（网关本体）+ 适配器（yarn onebot:run）+ 网关端口通不通，一次拿到。
 * 三样分开显示，是因为它们的失败长得一模一样：日志里都是连不上 3001，
 * 但可能是「网关没启动」「网关起了 WS 节点没开」「适配器没起」三件完全不同的事。
 */
type SnowlumaStatus = {
  home: string;
  /** 目录从哪来：saved=页面上填过 env=环境变量 process/scan=自动找到 default=没找到，用的默认值 */
  source: "saved" | "env" | "process" | "scan" | "default";
  /** start.bat 在不在 */
  installed: boolean;
  running: boolean;
  panelPort: number;
};
type RuntimeStatus = {
  adapter: { running: boolean; pid?: number; startedAt?: string };
  snowluma: SnowlumaStatus;
  /** 适配器要连的那个端口通不通；读不到连接配置时为 null */
  gateway: { wsUrl: string; host: string; port: number; reachable: boolean } | null;
};

const runtime = ref<RuntimeStatus | null>(null);
const adapterStatus = computed(() => runtime.value?.adapter ?? null);
const snowluma = computed(() => runtime.value?.snowluma ?? null);
const gateway = computed(() => runtime.value?.gateway ?? null);
/** 运行时状态没拿到之前不判断断点，否则首帧会先闪一下「全部灰掉」 */
const runtimeReady = computed(() => runtime.value !== null);

const adapterStarting = ref(false);
const snowlumaStarting = ref(false);
const homeEditing = ref(false);
const homeSaving = ref(false);
const homeDraft = ref("");
let runtimePollTimer: ReturnType<typeof setTimeout> | null = null;

function clockOf(value?: string) {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return ` · 从 ${pad(at.getHours())}:${pad(at.getMinutes())} 起`;
}

const adapterStateText = computed(() => {
  const status = adapterStatus.value;
  if (!status) return "正在检查…";
  if (!status.running) return "未运行";
  return `运行中 · PID ${status.pid}${clockOf(status.startedAt)}`;
});

const snowlumaStateText = computed(() => {
  const status = snowluma.value;
  if (!status) return "正在检查…";
  if (!status.installed) return "没找到程序";
  return status.running ? `已启动 · 面板 ${status.panelPort}` : "未启动";
});

/** 只有「它自己认出来」的才标，用户填的和默认值不用解释 */
const snowlumaSourceLabel = computed(() => {
  switch (snowluma.value?.source) {
    case "process": return "自动找到 · 已运行的进程";
    case "scan": return "自动找到 · 扫出来的";
    case "env": return "来自 SNOWLUMA_HOME";
    default: return "";
  }
});

async function loadRuntime() {
  try {
    runtime.value = await $fetch<RuntimeStatus>("/api/admin/channels/onebot/runtime");
    if (!homeEditing.value) homeDraft.value = runtime.value.snowluma.home;
  } catch {
    runtime.value = null;
  }
}

/** 点完按钮盯一段时间：起进程要几秒，端口起来才算真的好了 */
async function pollRuntime(deadline: number, ready: () => boolean) {
  await loadRuntime();
  if (ready() || Date.now() > deadline) return;
  runtimePollTimer = setTimeout(() => void pollRuntime(deadline, ready), 1000);
}

function readStatus(error: unknown) {
  return (error as { statusCode?: number }).statusCode;
}

async function startAdapter() {
  if (adapterStarting.value || adapterStatus.value?.running) return;
  adapterStarting.value = true;
  try {
    const result = await $fetch<{ message: string }>("/api/admin/channels/onebot/runtime/adapter", { method: "POST" });
    ElMessage.success(result.message);
    void pollRuntime(Date.now() + 10_000, () => adapterStatus.value?.running === true);
  } catch (error) {
    // 409 = 已经有一个在跑，不算失败
    if (readStatus(error) === 409) {
      ElMessage.info(readErrorMessage(error, "适配器已经在运行。"));
      await loadRuntime();
    } else {
      ElMessage.error(readErrorMessage(error, "启动失败，请手动运行 yarn onebot:run。"));
    }
  } finally {
    adapterStarting.value = false;
  }
}

async function startSnowluma() {
  if (snowlumaStarting.value || snowluma.value?.running) return;
  snowlumaStarting.value = true;
  try {
    const result = await $fetch<{ message: string }>("/api/admin/channels/onebot/runtime/snowluma", { method: "POST" });
    ElMessage.success(result.message);
    // 它要加载 QQ 客户端钩子，比适配器慢，给 40 秒
    void pollRuntime(Date.now() + 40_000, () => snowluma.value?.running === true);
  } catch (error) {
    if (readStatus(error) === 409) {
      ElMessage.info(readErrorMessage(error, "SnowLuma 已经在运行。"));
      await loadRuntime();
    } else {
      ElMessage.error(readErrorMessage(error, "启动失败，请手动双击 start.bat。"));
    }
  } finally {
    snowlumaStarting.value = false;
  }
}

function toggleHomeEdit() {
  homeEditing.value = !homeEditing.value;
  if (homeEditing.value && runtime.value) homeDraft.value = runtime.value.snowluma.home;
}

/** 刚装完没被扫到的时候再试一次：失败不进缓存，重拉就会重新找 */
async function rescanSnowluma() {
  await loadRuntime();
  if (snowluma.value && !snowluma.value.installed) {
    ElMessage.info("还是没找到，把目录手动填进来吧。");
  }
}

async function saveHome() {
  if (homeSaving.value) return;
  homeSaving.value = true;
  try {
    await $fetch("/api/admin/channels/onebot/runtime/snowluma", {
      method: "PUT",
      body: { home: homeDraft.value },
    });
    ElMessage.success("目录已记住。");
    homeEditing.value = false;
    await loadRuntime();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "这个目录用不了，看看里面有没有 start.bat。"));
  } finally {
    homeSaving.value = false;
  }
}

/**
 * 链路轨上只有一个修复动作，按断点分派到已有的处理函数 —— 不另开一套启动逻辑，
 * 免得「从轨道启动」和「从第 4 步启动」将来跑出两种行为。
 */
function onChainAction(kind: ChainActionKind) {
  const connection = primaryConnection.value;
  switch (kind) {
    case "start-gateway":
      void startSnowluma();
      break;
    case "start-adapter":
      void startAdapter();
      break;
    case "bind-character":
      if (connection) openBind(connection);
      break;
    case "edit-connection":
      if (connection) void openEdit(connection);
      break;
    case "open-steps":
      scrollToSteps();
      break;
  }
}

/** 「没找到程序 / 小号掉线」没有一键解法，滚到第 2 步让人照着做 */
function scrollToSteps() {
  if (import.meta.server) return;
  document.getElementById("qq-steps")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

watch(error, (value) => {
  if (value) ElMessage.error(readErrorMessage(value, "无法读取渠道连接。"));
});

onMounted(loadRuntime);
onBeforeUnmount(() => {
  if (runtimePollTimer) clearTimeout(runtimePollTimer);
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

function ownerQqOf(connection: QqConnection) {
  return typeof connection.metadata?.ownerQq === "string" ? connection.metadata.ownerQq : "";
}

/**
 * 协议端只用 SnowLuma：自带网页面板（不用另装面板）、挂在本机已登录的 QQNT 客户端上。
 * 只有一种方案，就不需要「二选一」的选择器和它那套 tagline —— 直接落到唯一那份配置说明。
 */
type ProxyGuide = {
  name: string;
  repo: string;
  /** 配置 OneBot 的那个页面地址，不是面板首页。 */
  panel: string;
  /** 面板内按顺序完成的配置动作。 */
  steps: { title: string; detail: string }[];
  /** 最容易踩的那一处，单独高亮。 */
  warn: string;
};

const PROXY: ProxyGuide = {
  name: "SnowLuma",
  repo: "https://github.com/SnowLuma/SnowLuma/releases",
  panel: "http://127.0.0.1:5099/config",
  steps: [
    { title: "打开面板并登录", detail: "面板地址通常是上方链接。首次账号和密码在启动 SnowLuma 时打开的黑色终端窗口里；每台设备生成的登录信息不同。登录后先修改密码，再在左侧选中 QQ 小号。" },
    { title: "配置 WebSocket 服务端", detail: "切到「WS 服务端」。已有 3001 节点就直接使用；没有再新建，端口填 3001。" },
    { title: "配置 HTTP API", detail: "切到「HTTP API」。已有节点就把端口改为 3002；没有再新建。不要用 3000。" },
    { title: "分别复制两个 Token", detail: "复制 WS 节点和 HTTP 节点的授权 Token，分别填到 QQ 渠道的对应输入框。" },
    { title: "保存并重启 SnowLuma", detail: "WS 与 HTTP 的 Token 可能不同，不要填反。" },
  ],
  warn: "面板地址通常固定为 http://127.0.0.1:5099/config；启动终端里找的是首次登录账号和密码，不是地址。找不到时，重新启动 SnowLuma 并查看新打开的黑色终端窗口。已有同端口节点时请修改或复用，不要重复创建。",
};

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
  groupAnnouncementEnabled: false,
  ownerQq: "",
  ownerName: "",
});

function resetForm() {
  form.qqNumber = "";
  form.displayName = "";
  form.wsUrl = "";
  form.httpUrl = "";
  form.accessToken = "";
  form.httpToken = "";
  form.groupAnnouncementEnabled = false;
  form.ownerQq = "";
  form.ownerName = "";
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
  form.groupAnnouncementEnabled = connection.metadata?.groupAnnouncementEnabled === true;
  form.ownerQq = typeof connection.metadata?.ownerQq === "string" ? connection.metadata.ownerQq : "";
  form.ownerName = typeof connection.metadata?.ownerName === "string" ? connection.metadata.ownerName : "";
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

function reloadPending(connection: QqConnection) {
  const requested = connection.metadata?.onebotReloadRequestedAt;
  return typeof requested === "string" && requested !== connection.metadata?.onebotReloadAppliedAt;
}

/**
 * 提交重连请求后自动盯一会儿：适配器通常一两秒就重连完，但页面不会自己变 ——
 * 人只能在中间态（未连接 / 重连中）点刷新，正好看到「连接异常」那一帧，像是坏了。
 */
const reloadPolling = ref(false);
let reloadPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopReloadPolling() {
  if (reloadPollTimer) {
    clearTimeout(reloadPollTimer);
    reloadPollTimer = null;
  }
  reloadPolling.value = false;
}

async function pollReload(deadline: number) {
  if (Date.now() > deadline) {
    stopReloadPolling();
    // 15 秒还没被适配器消费，多半是适配器没在跑，而不是配置错了
    if (connections.value.some(reloadPending)) {
      ElMessage.warning("适配器一直没响应重连请求，确认 yarn onebot:run 正在运行。");
    }
    return;
  }
  if (!connections.value.some(reloadPending)) {
    stopReloadPolling();
    return;
  }
  reloadPollTimer = setTimeout(async () => {
    try {
      await refresh();
    } catch {
      // 这一轮读失败就等下一轮，别把人从轮询里踢出去
    }
    void pollReload(deadline);
  }, 1500);
}

function startReloadPolling() {
  if (import.meta.server) return;
  stopReloadPolling();
  reloadPolling.value = true;
  void pollReload(Date.now() + 15000);
}

onBeforeUnmount(stopReloadPolling);

async function submitConnection(reconnect = false) {
  if (saving.value) return;
  if (!form.qqNumber.trim()) {
    ElMessage.warning("请填写 QQ 号。");
    return;
  }
  saving.value = true;
  try {
    const saved = await $fetch<{ id: string }>("/api/admin/channels", {
      method: "POST",
      body: {
        platform: "qq-onebot",
        qqNumber: form.qqNumber.trim(),
        displayName: form.displayName.trim(),
        wsUrl: form.wsUrl.trim(),
        httpUrl: form.httpUrl.trim(),
        accessToken: form.accessToken,
        httpToken: form.httpToken,
        groupAnnouncementEnabled: form.groupAnnouncementEnabled,
        ownerQq: form.ownerQq.trim(),
        ownerName: form.ownerName.trim(),
      },
    });
    if (reconnect) {
      try {
        await $fetch(`/api/admin/channels/${encodeURIComponent(saved.id)}/reload`, { method: "POST" });
        ElMessage.success("设置已保存，重新连接请求已提交。请查看连接卡片的处理状态。");
      } catch (reloadError) {
        ElMessage.warning(readErrorMessage(reloadError, "设置已保存，但重新连接请求失败，请稍后重试。"));
      }
    } else {
      ElMessage.success("设置已保存。运行中的新版 QQ 适配器会自动读取新设置。");
    }
    editVisible.value = false;
    await refresh();
    if (reconnect) startReloadPolling();
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

/** 选中已绑定过的角色时带回原来的群号，避免重新保存把群号清掉。 */
function onBindCharacterChange(characterId: string) {
  const existing = bindTarget.value?.bindings.find((item) => item.characterId === characterId);
  bindForm.routingKey = existing?.routingKey ?? "";
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
      body: {
        characterId: bindForm.characterId,
        routingKey: bindForm.routingKey.trim(),
      },
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

async function copyText(text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(successMessage);
  } catch {
    ElMessage.warning("复制失败，请手动选中。");
  }
}

function copyCommand(command: string) {
  return copyText(command, "命令已复制。");
}

function copyInstallGuide() {
  const panelSteps = PROXY.steps
    .map((step, index) => `${index + 1}. ${step.title}：${step.detail}`)
    .join("\n");
  const prompt = [
    `请一步一步帮我在 Windows 上安装并配置 ${PROXY.name}，让它通过 OneBot v11 连接到本机 yiling-hub。`,
    "请先询问并检查我电脑上的 QQ 版本、协议端是否已安装和项目运行状态；每次只指导一个阶段，用简单中文说明需要做什么、在哪里操作、完成后如何确认。",
    `官方发布页：${PROXY.repo}`,
    `管理面板：${PROXY.panel}`,
    "配置目标：正向 WebSocket 服务端端口 3001；HTTP API 端口 3002（不要使用 3000）；按协议端要求配置 Token。",
    `面板配置要点：\n${panelSteps}`,
    "之后指导我在 yiling-hub 的 QQ 渠道添加 QQ 小号，地址使用 ws://127.0.0.1:3001 和 http://127.0.0.1:3002，绑定一个角色，再运行 yarn onebot:run。以出现 onebot-connected 并完成一条收发测试作为验收。",
    "安全要求：只使用上面的官方发布页，不下载来历不明的软件；不要替我登录 QQ、处理扫码/验证码或绕过安全提示；不要要求我把 QQ 密码、验证码、WS/HTTP Token、API Key 发给你。需要输入凭据时告诉我在本机哪个页面自行填写；运行命令、安装软件或修改配置前先解释影响并等我确认。",
  ].join("\n\n");
  return copyText(prompt, "AI 安装教程已复制。");
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
      <!-- 四段链路：有号才画 —— 没有号的时候「断在哪」这个问题还不成立 -->
      <QqChannelChain
        v-if="primaryConnection"
        class="chain-slot"
        :connection="primaryConnection"
        :binding="primaryBinding"
        :adapter="adapterStatus"
        :snowluma="snowluma"
        :gateway="gateway"
        :ready="runtimeReady"
        :panel-url="PROXY.panel"
        @action="onChainAction"
      />

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
          v-else-if="hasLoadError && !connections.length"
          class="qq-empty is-error"
          role="alert"
        >
          <span class="empty-icon is-error"><el-icon><Warning /></el-icon></span>
          <div class="empty-copy">
            <h3>连接列表暂时无法读取</h3>
            <p>检查管理员登录状态或服务连接后重试。当前不会影响已经运行的 OneBot 适配器。</p>
          </div>
          <button
            type="button"
            class="btn"
            :disabled="loading"
            @click="refresh()"
          >
            <el-icon><Refresh /></el-icon>重试
          </button>
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
            <!-- 一行说清「哪个号、通没通、绑了谁」；细节和删除收进下面的展开区 -->
            <div class="conn-row">
              <span class="conn-icon"><el-icon><ChatDotRound /></el-icon></span>

              <div class="conn-id">
                <div class="conn-name">
                  {{ connection.displayName }}
                  <span
                    v-if="!connection.appId"
                    class="conn-qq"
                  >未填 QQ 号</span>
                  <!-- 名字里已经带号就不重复显示一遍 -->
                  <span
                    v-else-if="!connection.displayName.includes(connection.appId)"
                    class="conn-qq"
                  >{{ connection.appId }}</span>
                  <span
                    class="pill"
                    :class="statusMap[connection.status]?.tone ?? 'pill-gray'"
                  >{{ statusMap[connection.status]?.label ?? connection.status }}</span>
                </div>
                <div class="conn-meta">
                  <span>最近活动 {{ formatDateTime(connection.lastEventAt) }}</span>
                  <span>主人 {{ ownerQqOf(connection) || "未设置" }}</span>
                </div>
              </div>

              <div class="conn-actions">
                <button
                  type="button"
                  class="abtn"
                  @click="openEdit(connection)"
                >
                  <el-icon><Setting /></el-icon>设置
                </button>
                <button
                  type="button"
                  class="abtn"
                  :class="{ 'is-lead': !connection.bindings.length }"
                  @click="openBind(connection)"
                >
                  <el-icon><User /></el-icon>{{ connection.bindings.length ? "添加绑定" : "绑定角色" }}
                </button>
              </div>
            </div>

            <details class="conn-more">
              <summary>
                <span
                  v-if="connection.bindings.length"
                  class="more-sum"
                >已绑定 {{ connection.bindings.length }} 个角色</span>
                <span
                  v-else
                  class="more-sum is-warn"
                >还没绑角色 · 消息进来没人接</span>
                <span class="grow" />
                <span class="more-hint">详情</span>
                <el-icon class="more-caret">
                  <Right />
                </el-icon>
              </summary>

              <div class="conn-more-body">
                <el-alert
                  v-if="connection.metadata?.onebotReloadRequestedAt"
                  class="reload-status"
                  :type="reloadPending(connection) ? 'warning' : 'info'"
                  :closable="false"
                  :title="reloadPending(connection) ? '等待适配器重新连接' : '适配器已按新设置连接过网关'"
                  :description="reloadPending(connection)
                    ? (reloadPolling
                      ? '正在自动刷新（每 1.5 秒），一般一两秒就完成。若 15 秒还停在这里，先确认 SnowLuma 在跑、3001 端口有监听。'
                      : '点「刷新」查看结果。若一直等待，请先启动 yarn onebot:run；旧版进程需手动关闭并启动一次。')
                    : '实际是否连通请查看上方连接状态；历史重连完成不代表当前在线。'"
                  show-icon
                />

                <ul
                  v-if="connection.bindings.length"
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
                <p
                  v-else
                  class="bind-empty"
                >
                  连接已保存，但还不会回复消息。绑定角色后即可开始接收对话。
                </p>

                <div class="conn-foot">
                  <button
                    type="button"
                    class="tlink is-danger"
                    @click="removeConnection(connection)"
                  >
                    <el-icon><Delete /></el-icon>删除连接
                  </button>
                </div>
              </div>
            </details>
          </article>
        </div>
      </section>

      <!-- 角色在这个渠道上的行为：群号、群聊回复、限流、刷B站是绑定级；发表情、主动找话是角色级 -->
      <section
        v-if="boundBindings.length"
        class="behave"
      >
        <div class="sec-label">
          <h2>角色在 QQ 上的行为</h2>
          <span class="count">{{ boundBindings.length }}</span>
          <span class="note">只对 QQ 生效，网页对话与 B站 不受影响</span>
        </div>
        <div class="behave-grid">
          <QqCharacterBehavior
            v-for="item in boundBindings"
            :key="item.binding.id"
            :binding-id="item.binding.id"
            :character-id="item.character.id"
            :character-name="item.character.name"
            :connection-id="item.connection.id"
            :connection-name="item.connection.displayName"
            :routing-key="item.binding.routingKey"
            :reply-window-minutes="item.binding.replyWindowMinutes"
            :reply-limit-per-window="item.binding.replyLimitPerWindow"
            :reply-only-when-mentioned="item.binding.replyOnlyWhenMentioned"
            :group-chat="item.binding.groupChat"
            :group-bili-run-enabled="item.binding.groupBiliRunEnabled"
            :emoji-enabled="item.character.emojiEnabled === true"
            :image-understanding="item.character.imageUnderstanding === true"
            :proactive="item.character.proactive"
            @saved="onBehaviorSaved"
          />
        </div>
      </section>

      <div class="guide">
        <!-- 只在第一次配的时候要看：有号了就默认收起，别一直占着首屏 -->
        <details
          id="qq-steps"
          class="brick guide-fold"
          :open="!hasConnections"
        >
          <summary>
            <h2>接入四步</h2>
            <span class="card-sub">第一次配置才需要；通了就不用再打开</span>
            <span class="grow" />
            <span class="fold-hint">展开</span>
            <el-icon class="fold-caret">
              <Right />
            </el-icon>
          </summary>

          <div class="guide-body">
            <div class="guide-tools">
              <button
                type="button"
                class="guide-copy"
                @click="copyInstallGuide"
              >
                <el-icon><CopyDocument /></el-icon>复制安装教程
              </button>
            </div>
            <ol class="steps">
              <li class="step">
                <span class="step-no">1</span>
                <div class="step-body">
                  <h3>下载并登录 QQ 小号</h3>
                  <p>
                    装 {{ PROXY.name }}（自带网页配置面板，不用另装面板），装好后用 QQ 客户端登录小号。
                    它是挂在这个已登录的客户端上收发消息的，所以那个窗口全程别关。
                  </p>
                  <p class="step-line">
                    <a
                      :href="PROXY.repo"
                      target="_blank"
                      rel="noopener noreferrer"
                    ><el-icon><Download /></el-icon>下载 {{ PROXY.name }}</a>
                    <span class="sep">·</span>选最新的 win-x64 包，自带 Node 运行时，不用另外装环境。
                  </p>
                  <p class="step-note">
                    建议使用小号，避免主号承担非官方协议的风控风险。
                  </p>
                </div>
              </li>

              <li class="step">
                <span class="step-no">2</span>
                <div class="step-body">
                  <h3>开启收发接口</h3>
                  <!-- 网关本体没起来的话，下面的面板链接点了也是白打，所以先解决它 -->
                  <div class="run-row">
                    <span
                      class="run-state"
                      :class="{
                        'is-on': snowluma?.running,
                        'is-warn': Boolean(snowluma?.installed) && !snowluma?.running,
                      }"
                    >
                      <span class="dot" />SnowLuma {{ snowlumaStateText }}
                      <span
                        v-if="snowlumaSourceLabel"
                        class="run-tag"
                      >{{ snowlumaSourceLabel }}</span>
                    </span>
                    <button
                      v-if="snowluma?.installed && !snowluma.running"
                      type="button"
                      class="abtn is-lead"
                      :disabled="snowlumaStarting"
                      @click="startSnowluma"
                    >
                      <el-icon><VideoPlay /></el-icon>
                      {{ snowlumaStarting ? "正在打开…" : "启动 SnowLuma" }}
                    </button>
                    <button
                      v-if="snowluma?.installed"
                      type="button"
                      class="tlink"
                      @click="toggleHomeEdit"
                    >
                      <el-icon><FolderOpened /></el-icon>换目录
                    </button>
                    <button
                      v-if="snowluma && !snowluma.installed"
                      type="button"
                      class="tlink"
                      @click="rescanSnowluma"
                    >
                      <el-icon><Refresh /></el-icon>重新找一遍
                    </button>
                  </div>
                  <p
                    v-if="snowluma && !snowluma.installed"
                    class="run-warn"
                  >
                    没找到 <code>{{ snowluma.home }}\start.bat</code>。自动找的时候扫过下载、桌面、文档、
                    Program Files 和各盘根目录下两层，都没中。把「一眼能看到 start.bat 的那一层」填到下面，
                    只填一次；刚装完还没被扫到的，点上面「重新找一遍」。
                  </p>
                  <div
                    v-if="snowluma && (!snowluma.installed || homeEditing)"
                    class="home-edit"
                  >
                    <input
                      v-model="homeDraft"
                      class="home-input"
                      spellcheck="false"
                      placeholder="D:\Tools\SnowLuma"
                      aria-label="SnowLuma 安装目录"
                    >
                    <button
                      type="button"
                      class="abtn is-lead"
                      :disabled="homeSaving"
                      @click="saveHome"
                    >
                      {{ homeSaving ? "保存中…" : "保存目录" }}
                    </button>
                  </div>
                  <p class="endpoint-intro">
                    打开协议端面板：<a
                      :href="PROXY.panel"
                      target="_blank"
                      rel="noopener noreferrer"
                    ><code>{{ PROXY.panel }}</code></a>
                  </p>
                  <ol class="endpoint-steps">
                    <li>
                      <span class="endpoint-index">1</span>
                      <span class="endpoint-copy"><b>开启 WebSocket 服务端</b><span>端口 <code>3001</code>，用于接收 QQ 消息</span></span>
                    </li>
                    <li>
                      <span class="endpoint-index">2</span>
                      <span class="endpoint-copy"><b>开启 HTTP API</b><span>端口 <code>3002</code>，用于发送 QQ 消息</span></span>
                    </li>
                    <li>
                      <span class="endpoint-index">3</span>
                      <span class="endpoint-copy"><b>设置并记下 Token</b><span>WS 与 HTTP 分别设置，两个值可能不同</span></span>
                    </li>
                  </ol>
                  <p class="endpoint-note">
                    HTTP 不要用 3000，这个端口通常被本站占用。
                  </p>
                  <details class="step-more">
                    <summary>
                      <span class="caret"><el-icon><Right /></el-icon></span>
                      {{ PROXY.name }} 面板配置细节
                    </summary>
                    <ol class="panel-steps">
                      <li
                        v-for="(step, index) in PROXY.steps"
                        :key="step.title"
                        class="panel-step"
                      >
                        <span class="panel-step-no">{{ index + 1 }}</span>
                        <div class="panel-step-copy">
                          <strong>{{ step.title }}</strong>
                          <p>{{ step.detail }}</p>
                        </div>
                      </li>
                    </ol>
                    <p class="warn">
                      {{ PROXY.warn }}
                    </p>
                  </details>
                </div>
              </li>

              <li class="step">
                <span class="step-no">3</span>
                <div class="step-body">
                  <h3>添加连接并绑定角色</h3>
                  <p>
                    填 QQ 号、WS 地址 <code>ws://127.0.0.1:3001</code>、HTTP 地址
                    <code>http://127.0.0.1:3002</code> 和协议端 Token。保存后绑定一个角色。
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
                  <h3>启动并测试</h3>
                  <p>
                    适配器是个独立进程，得一直开着才能收发。点下面的按钮会打开一个命令行窗口，
                    替你在项目根目录跑 <code>yarn onebot:run</code>；窗口里出现
                    <code>onebot-connected</code> 就通了，再用另一个 QQ 号发消息测试。
                  </p>
                  <div class="run-row">
                    <button
                      type="button"
                      class="abtn is-lead"
                      :disabled="adapterStarting || adapterStatus?.running"
                      @click="startAdapter"
                    >
                      <el-icon><VideoPlay /></el-icon>
                      {{ adapterStatus?.running ? "已在运行" : adapterStarting ? "正在打开…" : "启动适配器" }}
                    </button>
                    <button
                      type="button"
                      class="tlink"
                      @click="copyCommand('yarn onebot:run')"
                    >
                      <el-icon><CopyDocument /></el-icon>复制命令
                    </button>
                    <span
                      class="run-state"
                      :class="{ 'is-on': adapterStatus?.running }"
                    >
                      <span class="dot" />{{ adapterStateText }}
                    </span>
                    <span
                      v-if="gateway"
                      class="run-state"
                      :class="gateway.reachable ? 'is-on' : 'is-warn'"
                    >
                      <span class="dot" />{{ gateway.reachable
                        ? `网关 ${gateway.port} 已监听`
                        : `网关 ${gateway.port} 没人接` }}
                    </span>
                  </div>
                  <p
                    v-if="gateway && !gateway.reachable"
                    class="run-warn"
                  >
                    适配器要连的 <code>{{ gateway.port }}</code> 端口没有进程应答 ——
                    也就是 <strong>SnowLuma 没启动</strong>（或它里面的 WS 节点没开）。
                    回第 2 步点「启动 SnowLuma」，等面板能打开、日志里出现 <code>login detected</code>，
                    这边会自己连上。期间适配器日志会一直刷 <code>code=1006</code>，那是它在按
                    1/2/4/8/16/30 秒退避重试，不是坏了。
                  </p>
                  <p class="step-note">
                    关掉那个命令行窗口就等于停。已经手动开着适配器时不要再点（会开出第二个，两个抢同一条连接）。
                    窗口一闪就没的话，多半是 <code>yarn</code> 不在 PATH —— 按「复制命令」自己开终端跑，把报错贴出来。
                  </p>
                </div>
              </li>
            </ol>

            <!-- ③ 排查：症状在前、原因在后，比一长串「如果…」好扫 -->
            <section class="fix-block">
              <div class="fix-block-h">
                <h3>连不上，按这个顺序查</h3>
                <span>八成是前三样</span>
              </div>
              <dl class="fix-list">
                <div class="fix-row">
                  <dt>协议端日志里没有 <code>UIN=小号</code></dt>
                  <dd>小号还没在官方 QQ 客户端里登上，或者那个窗口被关了。</dd>
                </div>
                <div class="fix-row">
                  <dt>适配器日志一直刷 <code>code=1006</code></dt>
                  <dd>3001 上没人监听：SnowLuma 根本没启动，或它里面的 WS 节点没开。先跑 <code>start.bat</code> 再看面板。</dd>
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
                  <dd>到上面「角色在 QQ 上的行为」里，把「群聊里怎么回」改成「仅被 @ 时回复」。</dd>
                </div>
                <div class="fix-row">
                  <dt>想让她发表情 / 主动找话 / 刷 B站</dt>
                  <dd>都在上面「角色在 QQ 上的行为」里，不用去角色设置或连接设置。</dd>
                </div>
              </dl>
            </section>
          </div>
        </details>
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
        @submit.prevent="submitConnection(false)"
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
                :placeholder="editingId ? '留空 = 沿用原值' : 'HTTP 节点的授权 Token'"
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
            <span>主人</span>
          </div>
          <el-form-item label="主人 QQ 号（可留空）">
            <el-input
              v-model="form.ownerQq"
              maxlength="15"
              placeholder="只有这个 QQ 能让她去刷 B站"
            />
          </el-form-item>
          <el-form-item label="主人称呼（可留空）">
            <el-input
              v-model="form.ownerName"
              maxlength="60"
              placeholder="例如：烟火清凉；留空则用 QQ 昵称"
            />
          </el-form-item>
          <p class="cq-hint">
            留空主人 QQ = 群里的 B站 指令不会生效。主人称呼会写进对话上下文，让她认得出你；留空时用 QQ 昵称。
          </p>
        </div>

        <div class="cq-sec">
          <div class="cq-sec-h">
            <span>群管理（可选）</span>
          </div>
          <el-form-item class="cq-check">
            <el-checkbox v-model="form.groupAnnouncementEnabled">
              允许群主/管理员让她拟群公告
            </el-checkbox>
          </el-form-item>
          <p class="cq-hint">
            开启后，群里只有<strong>群主或管理员</strong> @ 她并说「写个群公告：主题」，她才会拟稿；
            草稿回复后，管理员回复「确认发布」才真正发出。普通成员说什么都不会触发。
          </p>
          <p class="cq-warn">
            <el-icon><Warning /></el-icon>
            <span>
              前提：QQ 里先把这个小号设为群管理员，否则发布会被拒绝。
              本期只开放群公告，不开放踢人、禁言等操作。
            </span>
          </p>
        </div>
      </el-form>

      <template #footer>
        <div class="cq-foot">
          <span class="cq-foot-note">
            {{ editingId ? "点击保存并重新连接，无需手动重启终端" : "首次使用仍需启动一次 yarn onebot:run" }}
          </span>
          <span class="cq-foot-actions">
            <el-button @click="editVisible = false">
              取消
            </el-button>
            <el-button
              type="primary"
              :loading="saving"
              :disabled="credLoading"
              @click="submitConnection(true)"
            >
              保存并重新连接
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
            @change="onBindCharacterChange"
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
          群聊回复策略、发言限流、刷 B站 这些在下面「角色在 QQ 上的行为」里按角色改。
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
/* 链路轨排在最前：它回答的是「为什么不通」，比号列表更该先看到 */
.qq-body.has-list .chain-slot { order: -2; }
/* 从链路轨跳过来时别贴着视口顶边 */
#qq-steps { scroll-margin-top: 16px; }
.guide { display: flex; flex-direction: column; gap: var(--sp-4); }

.brick { border-radius: 10px; background: var(--surface); padding: 18px 20px 16px; }

/* ── 接入四步：整块可折叠 ───────────────────────────── */
.guide-fold { padding: 0; }
.guide-fold > summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 15px 20px;
  list-style: none;
  cursor: pointer;
}
.guide-fold > summary::-webkit-details-marker { display: none; }
.guide-fold > summary h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.guide-fold > summary .grow { flex: 1; }
.guide-fold .fold-hint { color: var(--faint); font-size: 12px; opacity: .8; }
.guide-fold .fold-caret { color: var(--faint); font-size: 12px; transition: transform .16s var(--ease); }
.guide-fold[open] .fold-caret { transform: rotate(90deg); }
.guide-fold[open] .fold-hint { display: none; }
.guide-fold > summary:hover h2 { color: var(--brand-strong); }

.guide-body { border-top: 1px solid var(--surface-3); padding: 0 20px 16px; }
.guide-tools { display: flex; justify-content: flex-end; padding: 12px 0 0; }

/* 排查清单折进来以后只是个小节，不再单独一张砖 */
.fix-block { margin-top: 18px; border-top: 1px solid var(--surface-3); padding-top: 14px; }
.fix-block-h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.fix-block-h h3 { margin: 0; color: var(--text-2); font-size: 13px; font-weight: 700; }
.fix-block-h span { color: var(--dim); font-size: 12px; }

/* 卡片标题：短标签，不跟正文抢 */
.card-h { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.card-title-group { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.card-h h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.card-sub { color: var(--dim); font-size: 12px; }
.guide-copy {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--surface-3);
  border-radius: 7px;
  background: var(--surface);
  padding: 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), border-color .14s var(--ease), color .14s var(--ease);
}
.guide-copy:hover { border-color: var(--brand); background: var(--brand-soft); color: var(--brand-strong); }
.guide-copy .el-icon { font-size: 14px; }
.guide-copy:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* 区块标题（连接列表） */
.sec-label { display: flex; align-items: baseline; gap: 8px; margin-bottom: var(--sp-3); }
.sec-label h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.sec-label .count { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.sec-label .note { margin-left: auto; color: var(--dim); font-size: 12px; }

/* 第 4 步：启动按钮 + 复制命令 + 运行状态同一行 */
.run-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0 0; }
.run-state { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; }
.run-state .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
.run-state.is-on { color: #0b7a54; }
.run-state.is-on .dot { background: var(--green); }
.run-state.is-warn { color: #8f5c05; }
.run-state.is-warn .dot { background: #d79a2b; }
/* 「自动找到」标：路径不是用户填的就说一声，省得他以为自己填过 */
.run-tag { margin-left: 2px; border-radius: 999px; background: var(--surface-2); padding: 1px 7px; color: var(--dim); font-size: 12px; }
/* 网关没接上：这不是错误弹窗该干的事，写成一块常驻的说明 */
.run-warn {
  margin: 10px 0 0;
  border-radius: 8px;
  background: #fdf6e7;
  padding: 10px 12px;
  color: #7a4f06;
  font-size: 12px;
  line-height: 1.8;
}
.run-warn code { background: rgba(255, 255, 255, .75); border-radius: 4px; padding: 1px 4px; }

/* 目录输入只在「找不到 start.bat」或点了「换目录」时出现，所以不值得占一整行版面 */
.home-edit { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
.home-input {
  flex: 1 1 280px;
  min-width: 0;
  height: 34px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 0 10px;
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.home-input::placeholder { color: var(--dim); }
.home-input:focus { outline: 2px solid var(--brand); outline-offset: -2px; background: var(--surface-3); }

/* 行为卡：一张卡一个角色，宽度封顶 760 —— 开关型设置拉满全宽会被中间的空白扯散 */
/* 角色卡一列排：里面是刻度 + 四格仪表，半宽会把仪表挤散 */
.behave-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); }

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
.endpoint-intro { margin-bottom: 10px !important; }
.endpoint-steps {
  display: grid;
  gap: 8px;
  max-width: 620px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.endpoint-steps li {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 52px;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 8px 12px;
}
.endpoint-index {
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
.endpoint-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.endpoint-copy b { color: var(--text); font-size: 14px; font-weight: 600; }
.endpoint-copy > span { color: var(--dim); font-size: 12px; line-height: 1.5; }
.endpoint-note { margin-top: 8px !important; color: #8f5c05 !important; font-size: 12px !important; }
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
.panel-steps {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.panel-step {
  position: relative;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 10px;
  padding: 0 0 14px;
}
.panel-step:not(:last-child)::before {
  position: absolute;
  top: 25px;
  bottom: 0;
  left: 12px;
  width: 2px;
  background: var(--surface-3);
  content: "";
}
.panel-step-no {
  z-index: 1;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 700;
}
.panel-step-copy { min-width: 0; padding-top: 2px; }
.panel-step-copy strong { color: var(--text); font-size: 14px; font-weight: 700; }
.panel-step-copy p { max-width: 66ch; margin: 3px 0 0; color: var(--text-2); font-size: 14px; line-height: 1.65; }

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
.cmd code { background: none; padding: 0; color: inherit; font-size: 14px; }

/* ── 连接卡 ───────────────────────────────────────── */
/* 一行式的账号卡不需要并排：一列铺满，宽度和上下两张卡对齐 */
.conn-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-3); align-items: start; }
.conn-card {
  border-radius: 10px;
  background: var(--surface);
  padding: 13px 15px 11px;
}
.conn-card.is-skeleton { display: flex; flex-direction: column; gap: 10px; }
.reload-status { margin: 10px 0 0; }

/* 一行：图标 / 名字 + 号 + 状态 / 右侧动作 —— 账号卡不该比它承载的信息更高 */
.conn-row { display: flex; align-items: center; gap: 12px; }
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
.conn-name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text); font-size: 15px; font-weight: 700; line-height: 1.35; }
.conn-qq { color: var(--dim); font-size: 12px; font-weight: 500; font-family: ui-monospace, Consolas, monospace; }
.conn-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 3px; color: var(--dim); font-size: 12px; line-height: 1.5; }
.conn-actions { display: flex; flex: none; align-items: center; gap: 4px; }

/* 详情：一行摘要 + 展开区。绑定列表、重连提示、删除都收在这里 */
.conn-more { margin-top: 10px; border-top: 1px solid var(--surface-3); }
.conn-more > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 0 0;
  color: var(--dim);
  font-size: 12px;
  cursor: pointer;
  list-style: none;
}
.conn-more > summary::-webkit-details-marker { display: none; }
.conn-more > summary .grow { flex: 1; }
.conn-more .more-sum { color: var(--text-2); font-weight: 600; }
.conn-more .more-sum.is-warn { color: #8f5c05; }
.conn-more .more-hint { opacity: .75; }
.conn-more .more-caret { font-size: 12px; transition: transform .16s var(--ease); }
.conn-more[open] .more-caret { transform: rotate(90deg); }
.conn-more > summary:hover .more-hint,
.conn-more > summary:hover .more-sum { color: var(--brand-strong); }
.conn-more-body { padding-top: 4px; }

/* 绑定与删除：平时折起来，展开才出现 */
.bind-list { display: flex; flex-direction: column; margin: 8px 0 0; padding: 0; list-style: none; }
.bind-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--surface-3); }
.bind-row:first-child { border-top: 0; }
.bind-id { min-width: 0; flex: 1; }
.bind-id b { display: block; color: var(--text-2); font-size: 14px; font-weight: 600; }
.bind-id span { color: var(--dim); font-size: 12px; }
.bind-empty { margin: 8px 0 0; color: var(--text-2); font-size: 13px; line-height: 1.6; }

.conn-foot { display: flex; align-items: center; gap: 4px; margin-top: 10px; border-top: 1px solid var(--surface-3); padding-top: 8px; }
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
   这一屏真正要读的是下面的接入步骤，空态抢走一半高度反而把人挡住。 */
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
.qq-empty .btn.primary,
.qq-empty > .btn { flex: none; }
.qq-empty.is-error { background: var(--red-soft); }
.empty-icon.is-error { background: #fff; color: var(--red); }

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
@media (max-width: 720px) {
  .brick { padding: 16px 15px 14px; }
  .conn-card { padding: 12px 13px 10px; }
  /* 窄屏把动作放到第二行，别把名字挤成两行 */
  .conn-row { flex-wrap: wrap; row-gap: 10px; }
  .conn-actions { width: 100%; justify-content: flex-end; }
  .sec-label .note { display: none; }
  .conn-foot { flex-wrap: wrap; }
  .behave-grid { grid-template-columns: minmax(0, 1fr); }
  .step { grid-template-columns: 24px minmax(0, 1fr); gap: 10px; }
  .endpoint-steps li { grid-template-columns: 24px minmax(0, 1fr); padding: 8px 10px; }
  /* 空态换行：文案先占满一行，按钮落到下一行、和文案左边缘对齐 */
  .qq-empty { flex-wrap: wrap; align-items: flex-start; row-gap: 10px; }
  .empty-copy { flex-basis: calc(100% - 54px); }
  .qq-empty .btn.primary,
  .qq-empty > .btn { margin-left: 54px; }
}
@media (max-width: 560px) {
  .cq-id,
  .cq-pair { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .cq-foot { flex-direction: column-reverse; align-items: stretch; gap: 10px; }
  .cq-foot-actions { justify-content: flex-end; }
  .cq-foot-note { text-align: center; }
}
</style>
