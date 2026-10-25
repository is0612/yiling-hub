<script setup lang="ts">
import {
  ArrowRight, Bell, Camera, ChatDotRound, ChatLineRound, Clock, Close, CopyDocument,
  DataLine, Document, Expand, Fold, Folder, Grid, MessageBox, Operation,
  Promotion, Refresh, Search, Setting, Star, TrendCharts, User, VideoPlay, View,
} from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

useHead({ title: "B站值班台 · 忆灵小窝" });

// ── 数据类型 ───────────────────────────────────────────────
type BiliReport = { id: string; roundIndex: number; pickedCount: number; content: string; createdAt: string };
type BiliSeen = { bvid: string; title: string; author: string; result: string; reason: string; seenAt: string };
type BiliBinding = {
  bindingId: string; characterId: string; characterName: string;
  pickedToday: number; remaining: number; perDay: number;
  reports: BiliReport[]; seenToday: BiliSeen[];
};
type BiliAccount = {
  connectionId: string; displayName: string; dataHome: string; biliBin: string;
  duty: {
    perDay: number; peakValley: boolean; noon: boolean; night: boolean;
    keywords: string[]; zone: string; frames: number;
    autoComment: boolean; commentPerRound: number; mentionName: string;
    dmMode: "only" | "both" | "off";
  };
  nextWindow: "noon" | "night" | null;
  bindings: BiliBinding[];
};
type DashboardData = { today: string; accounts: BiliAccount[] };

type BiliCatalogParam = {
  key: string; label: string; pos?: boolean; flag?: string;
  type?: "text" | "int" | "bool" | "select"; default?: string; choices?: string[]; ph?: string;
};
type BiliCatalogItem = { id: string; label: string; argv: string[]; write?: boolean; kind?: string; params?: BiliCatalogParam[] };
type BiliCatalogGroup = { group: string; items: BiliCatalogItem[] };
type BiliRunResult = {
  code: number | null; json: unknown; stdout: string; stderr: string;
  elapsed: number; argv: string[]; timedOut: boolean;
};
type RunLogEntry = { id: string; label: string; argv: string[]; at: string; ok: boolean; seconds: number };

// ── 视图切换 ───────────────────────────────────────────────
const route = useRoute();
const router = useRouter();
const view = ref<"overview" | "history" | "command">("overview");
const activeCmd = ref<BiliCatalogItem | null>(null);

/** 侧栏收成 64px 图标栏：手动点「收起」，或窗口窄于 1180 自动收。 */
const railManual = ref(false);
const narrow = ref(false);
const rail = computed(() => railManual.value || narrow.value);

function goWorkbench(key: "overview" | "history") {
  view.value = key;
  activeCmd.value = null;
  void router.replace({ query: key === "history" ? { view: "history" } : {} });
}

function openCommand(item: BiliCatalogItem) {
  view.value = "command";
  activeCmd.value = item;
  lastResult.value = null;
  for (const key of Object.keys(values)) delete values[key];
  for (const p of item.params ?? []) {
    values[p.key] = p.type === "bool" ? false : (p.default ?? "");
  }
  dryRun.value = true;
  void router.replace({ query: { cmd: item.id } });
}

/**
 * 目录里 kind 型条目（值班设置 / 发动态 / 她看过什么 / 她的札记 / 升级自检）的 argv 是空的，
 * 直接丢进运行器会跑出空命令，所以这里分派到对应的真实界面。
 */
function selectItem(item: BiliCatalogItem) {
  if (item.kind === "duty") {
    const account = dashboard.value.accounts[0];
    if (!account) {
      ElMessage.warning("还没有 B站 渠道连接，请先到「渠道管理」创建。");
      return;
    }
    openDutySettings(account);
    return;
  }
  if (item.kind === "seen" || item.kind === "journal") {
    goWorkbench("history");
    return;
  }
  if (item.kind === "dynamic") {
    const target = allItems.value.find((entry) => entry.id === "dynamic.post");
    if (target) {
      openCommand(target);
      return;
    }
  }
  openCommand(item);
}

function openCommandById(id: string) {
  const found = allItems.value.find((item) => item.id === id);
  if (found) selectItem(found);
  else ElMessage.warning(`命令目录里还没有 ${id}，可能 bili CLI 版本不同。`);
}

function isCmdActive(id: string) {
  return view.value === "command" && activeCmd.value?.id === id;
}

// ── 命令目录（侧栏「全部命令」） ──────────────────────────
const groups = ref<BiliCatalogGroup[]>([]);
const catalogLoading = ref(true);
const query = ref("");
const openedGroups = ref<string[]>([]);
const searchRef = ref<{ focus?: () => void } | null>(null);

// ── 菜单管理：只影响侧栏显示，命令表本身不动 ──────────────
const MENU_KEY = "yiling-hub:bili-menu";

/**
 * 存「隐藏清单」而不是「显示清单」：
 * 以后 bili CLI 多出来的命令默认可见，用户不用再去勾一次。
 */
const hiddenGroups = ref<string[]>([]);
const hiddenItems = ref<string[]>([]);

function readMenu() {
  try {
    const raw = localStorage.getItem(MENU_KEY);
    if (!raw) return;
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") return;
    const d = data as { hiddenGroups?: unknown; hiddenItems?: unknown };
    if (Array.isArray(d.hiddenGroups)) {
      hiddenGroups.value = d.hiddenGroups.filter((x): x is string => typeof x === "string");
    }
    if (Array.isArray(d.hiddenItems)) {
      hiddenItems.value = d.hiddenItems.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* 配置坏了就当全显示 */
  }
}

function writeMenu() {
  try {
    localStorage.setItem(
      MENU_KEY,
      JSON.stringify({ hiddenGroups: hiddenGroups.value, hiddenItems: hiddenItems.value }),
    );
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 某条命令是否被藏起来（整组隐藏也算） */
function isItemHidden(id: string) {
  if (hiddenItems.value.includes(id)) return true;
  const group = groups.value.find((g) => g.items.some((item) => item.id === id));
  return group ? hiddenGroups.value.includes(group.group) : false;
}

const menuTotal = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));

/** 侧栏真正渲染的集合：去掉隐藏的分组/命令，空组不留空行 */
const visibleGroups = computed(() =>
  groups.value
    .filter((g) => !hiddenGroups.value.includes(g.group))
    .map((g) => ({ ...g, items: g.items.filter((i) => !hiddenItems.value.includes(i.id)) }))
    .filter((g) => g.items.length > 0),
);
const visibleCount = computed(() => visibleGroups.value.reduce((n, g) => n + g.items.length, 0));
/** 命令目录读出来了，但全被藏了——需要给个能勾回来的入口 */
const menuEmpty = computed(() => !catalogLoading.value && groups.value.length > 0 && visibleCount.value === 0);

/** 管理弹窗：编辑态与已保存态分开，取消就什么都没发生 */
const menuOpen = ref(false);
const menuQuery = ref("");
const draftHiddenGroups = ref<string[]>([]);
const draftHiddenItems = ref<string[]>([]);

function openMenuManager() {
  draftHiddenGroups.value = [...hiddenGroups.value];
  draftHiddenItems.value = [...hiddenItems.value];
  menuQuery.value = "";
  menuOpen.value = true;
}

function menuFullOf(group: string) {
  return groups.value.find((g) => g.group === group);
}

/** 分组勾选三态：全显示 / 显示一部分 / 全隐藏 */
function menuGroupState(g: BiliCatalogGroup): "all" | "some" | "none" {
  if (draftHiddenGroups.value.includes(g.group)) return "none";
  const full = menuFullOf(g.group) ?? g;
  const hidden = full.items.filter((i) => draftHiddenItems.value.includes(i.id)).length;
  if (!hidden) return "all";
  return hidden === full.items.length ? "none" : "some";
}

function menuToggleGroup(group: string, show: boolean) {
  const ids = new Set((menuFullOf(group)?.items ?? []).map((i) => i.id));
  // 整组切换时清掉组内单条记录，免得留下互相矛盾的配置
  draftHiddenItems.value = draftHiddenItems.value.filter((id) => !ids.has(id));
  draftHiddenGroups.value = show
    ? draftHiddenGroups.value.filter((x) => x !== group)
    : [...new Set([...draftHiddenGroups.value, group])];
}

function menuToggleItem(id: string, show: boolean) {
  draftHiddenItems.value = show
    ? draftHiddenItems.value.filter((x) => x !== id)
    : [...new Set([...draftHiddenItems.value, id])];
}

const menuHiddenCount = computed(() => {
  const gs = new Set(draftHiddenGroups.value);
  const is = new Set(draftHiddenItems.value);
  let n = 0;
  for (const g of groups.value) {
    n += gs.has(g.group) ? g.items.length : g.items.filter((i) => is.has(i.id)).length;
  }
  return n;
});
const menuVisibleCount = computed(() => menuTotal.value - menuHiddenCount.value);
const menuAllShown = computed(() => menuTotal.value > 0 && menuHiddenCount.value === 0);

function menuToggleAll(show: boolean) {
  if (show) {
    draftHiddenGroups.value = [];
    draftHiddenItems.value = [];
  } else {
    draftHiddenGroups.value = groups.value.map((g) => g.group);
    draftHiddenItems.value = [];
  }
}

/** 弹窗内搜索：组名或命令命中就保留整组（45 条盲翻太费劲） */
const menuShownGroups = computed(() => {
  const q = menuQuery.value.trim().toLowerCase();
  if (!q) return groups.value;
  return groups.value
    .map((g) => ({
      ...g,
      items: g.items.filter((i) =>
        g.group.toLowerCase().includes(q)
        || i.label.toLowerCase().includes(q)
        || i.id.toLowerCase().includes(q)
        || i.argv.join(" ").toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
});

function saveMenu() {
  hiddenGroups.value = [...draftHiddenGroups.value];
  hiddenItems.value = [...draftHiddenItems.value];
  writeMenu();
  menuOpen.value = false;
  // 正在看的命令被藏起来了，退回概览，免得停在一个从侧栏进不去的页面
  if (activeCmd.value && isItemHidden(activeCmd.value.id)) goWorkbench("overview");
  ElMessage.success(`菜单已更新，侧栏显示 ${visibleCount.value} / ${menuTotal.value} 条命令。`);
}

const allItems = computed(() => groups.value.flatMap((g) => g.items));
const totalCmds = computed(() => allItems.value.length);

/** 分组图标：bili 的 9 个组各有语义，全用文件夹会看不出层级。 */
const GROUP_ICON: Record<string, unknown> = {
  刷B站: Promotion,
  账号: User,
  收件箱: MessageBox,
  发现: View,
  视频: VideoPlay,
  互动: ChatDotRound,
  动态: ChatLineRound,
  数据: DataLine,
  系统: Setting,
};
const groupIcon = (name: string) => GROUP_ICON[name] ?? Folder;

async function loadCatalog() {
  catalogLoading.value = true;
  try {
    const data = await $fetch<{ groups: BiliCatalogGroup[] }>("/api/admin/bili/catalog");
    groups.value = data.groups;
    // 深链：/bili?cmd=video.watch
    const deepLink = String(route.query.cmd || "");
    if (deepLink) {
      const item = allItems.value.find((entry) => entry.id === deepLink);
      if (item) {
        const group = groups.value.find((g) => g.items.some((entry) => entry.id === deepLink));
        if (group) openedGroups.value = [group.group];
        openCommand(item);
      }
    }
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取命令目录。"));
  } finally {
    catalogLoading.value = false;
  }
}

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return visibleGroups.value;
  return visibleGroups.value
    .map((g) => ({
      ...g,
      items: g.items.filter((i) =>
        i.label.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        i.argv.join(" ").toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
});

const searching = computed(() => Boolean(query.value.trim()));
function toggleGroup(group: string) {
  openedGroups.value = openedGroups.value.includes(group)
    ? openedGroups.value.filter((x) => x !== group)
    : [...openedGroups.value, group];
}
const isGroupOpen = (group: string) => searching.value || openedGroups.value.includes(group);

function focusSearch(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchRef.value?.focus?.();
  }
}

function onResize() {
  narrow.value = window.innerWidth < 1180;
}

// ── 常用（可取消固定的固定项，存 localStorage） ────────────
const PIN_KEY = "yiling-hub:bili-pins";
const DEFAULT_PINS = ["video.watch", "hot.rank", "feed.inbox", "duty.settings"];

const PIN_LABEL: Record<string, string> = {
  "video.watch": "看懂视频",
  "hot.rank": "排行榜",
  "feed.inbox": "收件箱",
  "duty.settings": "值班设置",
};
const PIN_ICON: Record<string, unknown> = {
  "video.watch": View,
  "hot.rank": TrendCharts,
  "feed.inbox": MessageBox,
  "duty.settings": Setting,
};

function readPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return [...DEFAULT_PINS];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [...DEFAULT_PINS];
  } catch {
    return [...DEFAULT_PINS];
  }
}

const pinKeys = ref<string[]>([...DEFAULT_PINS]);

function savePins() {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinKeys.value));
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 只渲染命令表里真的存在、且没被菜单管理藏起来的固定项。 */
const pins = computed(() =>
  pinKeys.value.flatMap((key) => {
    const item = allItems.value.find((i) => i.id === key);
    return item && !isItemHidden(key) ? [{ key, item }] : [];
  }),
);

const pinLabel = (item: BiliCatalogItem) => PIN_LABEL[item.id] ?? item.label;
const pinIcon = (item: BiliCatalogItem) => PIN_ICON[item.id] ?? Star;

function unpin(key: string, event: MouseEvent) {
  event.stopPropagation();
  pinKeys.value = pinKeys.value.filter((x) => x !== key);
  savePins();
}

function restorePins() {
  pinKeys.value = [...DEFAULT_PINS];
  savePins();
}

onMounted(() => {
  pinKeys.value = readPins();
  readMenu();
  window.addEventListener("keydown", focusSearch);
  window.addEventListener("resize", onResize);
  onResize();
  // 深链：/bili?view=history 直接落在运行记录
  if (route.query.view === "history") view.value = "history";
  void loadCatalog();
  void loadDashboard();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", focusSearch);
  window.removeEventListener("resize", onResize);
});

// ── 命令参数与执行 ────────────────────────────────────────
const values = reactive<Record<string, any>>({});
const dryRun = ref(true);
const busy = ref(false);
const lastResult = ref<BiliRunResult | null>(null);
const lastLabel = ref("");
const runLog = ref<RunLogEntry[]>([]);

const params = computed(() => activeCmd.value?.params ?? []);
const inputs = computed(() => params.value.filter((p) => p.type !== "bool"));
const toggles = computed(() => params.value.filter((p) => p.type === "bool"));
const isSelfCheck = computed(() => activeCmd.value?.kind === "selfcheck");

const argv = computed(() => {
  if (!activeCmd.value) return [];
  const out = [...activeCmd.value.argv];
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
  if (activeCmd.value.write && dryRun.value) out.push("--dry-run");
  return out;
});

const preview = computed(
  () => "bili " + argv.value.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "),
);

const missing = computed(() =>
  inputs.value.filter((p) => p.pos && !String(values[p.key] ?? "").trim()).map((p) => p.label),
);

/** 升级自检：本工作台没有 bili-desk 那个自检面板，用它背后真正跑的三条命令代替。 */
const SELF_CHECK = [
  { itemId: "schema", label: "全量命令表", desc: "确认 CLI 认识哪些子命令", argv: ["schema"] },
  { itemId: "skills.status", label: "技能安装状态", desc: "装没装、缺哪个技能", argv: ["skills", "status"] },
  { itemId: "asr.status", label: "语音转写状态", desc: "字幕/转写能不能用", argv: ["asr", "status"] },
];

async function execute(argvList: string[], itemId: string, label: string) {
  if (busy.value) return;
  if (!argvList.length) {
    ElMessage.warning("这条命令没有可执行的参数。");
    return;
  }
  busy.value = true;
  lastResult.value = null;
  lastLabel.value = label;
  try {
    const result = await $fetch<BiliRunResult>("/api/admin/bili/run", {
      method: "POST",
      body: { argv: argvList, itemId, allowWrite: argvList.includes("--dry-run") ? false : !dryRun.value },
    });
    lastResult.value = result;
    runLog.value = [
      {
        id: `${itemId}-${Date.now()}`,
        label,
        argv: result.argv,
        at: new Date().toISOString(),
        ok: result.code === 0,
        seconds: result.elapsed,
      },
      ...runLog.value,
    ].slice(0, 30);
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "命令执行失败。"));
  } finally {
    busy.value = false;
  }
}

async function runCommand() {
  if (!activeCmd.value) return;
  if (missing.value.length) {
    ElMessage.warning(`还差：${missing.value.join("、")}`);
    return;
  }
  await execute(argv.value, activeCmd.value.id, activeCmd.value.label);
}

function runSelfCheck(entry: (typeof SELF_CHECK)[number]) {
  void execute(entry.argv, entry.itemId, entry.label);
}

async function copyCmd() {
  try {
    await navigator.clipboard.writeText(preview.value);
    ElMessage.success("命令已复制。");
  } catch {
    ElMessage.warning("剪贴板不可用。");
  }
}

function resultSummary(result: BiliRunResult | null) {
  if (!result) return "";
  const json = result.json as { ok?: boolean; error?: { code?: string; message?: string }; data?: unknown } | null;
  if (json?.error) return `${json.error.code ?? "错误"}：${json.error.message ?? ""}`;
  if (Array.isArray(json?.data)) return `${json.data.length} 条结果`;
  if (json?.data && typeof json.data === "object") return `${Object.keys(json.data as object).length} 个字段`;
  return json?.ok ? "执行成功" : "无输出";
}

function formatResult(): string {
  const r = lastResult.value;
  if (!r) return "";
  if (r.json !== null && r.json !== undefined) return JSON.stringify(r.json, null, 2);
  if (r.stdout) return r.stdout.trim();
  if (r.stderr) return r.stderr.trim();
  return "（无输出）";
}

// ── 概览数据 ───────────────────────────────────────────────
const loading = ref(true);
const dashboard = ref<DashboardData>({ today: "", accounts: [] });
const lastRoundSeconds = ref<number | null>(null);

const bindings = computed(() => dashboard.value.accounts.flatMap((account) => account.bindings));

const totalPickedToday = computed(() => bindings.value.reduce((sum, b) => sum + b.pickedToday, 0));
const totalPerDay = computed(() =>
  bindings.value.reduce((sum, b) => sum + b.perDay, 0) || dashboard.value.accounts.reduce((sum, a) => sum + (a.duty.perDay ?? 0), 0),
);
const totalSeenToday = computed(() => bindings.value.reduce((sum, b) => sum + b.seenToday.length, 0));
const skippedSeen = computed(() =>
  bindings.value.reduce((sum, b) => sum + b.seenToday.filter((v) => v.result !== "picked").length, 0),
);
const totalRounds = computed(() => bindings.value.reduce((sum, b) => sum + b.reports.length, 0));

const quotaPct = computed(() =>
  totalPerDay.value > 0 ? Math.min(100, Math.round((totalPickedToday.value / totalPerDay.value) * 100)) : 0,
);

/** 时长拆成「数值 + 单位」两段：26px 数字后面跟 12px 单位，和 bili-desk 一致。 */
function dur(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return { v: "—", u: "" };
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return { v: String(s), u: "秒" };
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return { v: String(m), u: rest ? `分 ${rest} 秒` : "分钟" };
}
const lastRun = computed(() => dur(lastRoundSeconds.value));

const h1 = computed(() => {
  if (!bindings.value.length) return "先看看今天的情况";
  if (totalPerDay.value <= 0) return "值班还没设置每日条数";
  if (totalPickedToday.value >= totalPerDay.value) return `今天已经刷满 ${totalPerDay.value} 条`;
  return `今天刷了 ${totalPickedToday.value} 条，还剩 ${totalPerDay.value - totalPickedToday.value} 条配额`;
});

const lastHint = computed(() => {
  if (lastRoundSeconds.value !== null) return "最近一轮值班的耗时";
  if (totalRounds.value) return "上一轮耗时随重启清空了";
  return "还没有跑过值班";
});

const windowText = computed(() => {
  const account = dashboard.value.accounts[0];
  if (!account) return "";
  if (account.nextWindow) return `下次谷时窗口 ${windowLabel(account.nextWindow)}`;
  return account.duty.peakValley ? "当前在谷时窗口内" : "峰谷自动刷已关闭";
});

const subtitle = computed(() => {
  const bits: string[] = [];
  const w = windowText.value;
  if (w) bits.push(w);
  if (totalRounds.value) bits.push(`今天跑了 ${totalRounds.value} 轮`);
  bits.push(`判重表已记 ${totalSeenToday.value} 条`);
  const home = dashboard.value.accounts.find((a) => a.dataHome)?.dataHome;
  if (home) bits.push(`数据在 ${home}`);
  return bits.join(" · ");
});

/** 跨账号的「她今天看了什么」，取最新 3 条（和 bili-desk 首屏一致）。 */
const recentSeen = computed(() =>
  bindings.value
    .flatMap((b) => b.seenToday.map((video) => ({ ...video, characterName: b.characterName })))
    .sort((a, b) => new Date(b.seenAt).getTime() - new Date(a.seenAt).getTime())
    .slice(0, 3),
);

/** 跨账号的今日报告。 */
const recentReports = computed(() =>
  bindings.value
    .flatMap((b) => b.reports.map((report) => ({ ...report, characterName: b.characterName })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
);

const allSeen = computed(() =>
  bindings.value
    .flatMap((b) => b.seenToday.map((video) => ({ ...video, characterName: b.characterName })))
    .sort((a, b) => new Date(b.seenAt).getTime() - new Date(a.seenAt).getTime()),
);

const allReports = computed(() => recentReports.value);

/** 运行记录筛选：全部 / 今日报告 / 看过的视频 */
const historyFilter = ref<"all" | "report" | "seen">("all");

async function loadDashboard() {
  loading.value = true;
  try {
    dashboard.value = await $fetch<DashboardData>("/api/admin/bili/dashboard");
    await loadCovers();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取 B站 工作台数据。"));
  } finally {
    loading.value = false;
  }
}

async function refreshStatus() {
  await loadDashboard();
  ElMessage.success("状态已刷新。");
}

// ── 值班设置 ───────────────────────────────────────────────
const ZONES = ["all", "anime", "music", "dance", "game", "knowledge", "tech", "sports", "car", "life", "food", "animal", "kichiku", "fashion", "ent", "film", "original", "rookie"];

const dutyVisible = ref(false);
const dutySaving = ref(false);
const dutyTarget = ref<BiliAccount | null>(null);
const dutyForm = reactive({
  perDay: 5, peakValley: true, noon: true, night: true,
  keywordsText: "", zone: "all", frames: 0,
  dmMode: "only" as "only" | "both" | "off",
  autoComment: false, commentPerRound: 1, mentionName: "",
});

function openDutySettings(account: BiliAccount) {
  dutyTarget.value = account;
  const duty = account.duty;
  dutyForm.perDay = duty.perDay ?? 5;
  dutyForm.peakValley = duty.peakValley ?? true;
  dutyForm.noon = duty.noon ?? true;
  dutyForm.night = duty.night ?? true;
  dutyForm.keywordsText = (duty.keywords ?? []).join("\n");
  dutyForm.zone = duty.zone || "all";
  dutyForm.frames = duty.frames ?? 0;
  dutyForm.dmMode = duty.dmMode ?? "only";
  dutyForm.autoComment = duty.autoComment ?? false;
  dutyForm.commentPerRound = duty.commentPerRound ?? 1;
  dutyForm.mentionName = duty.mentionName ?? "";
  dutyVisible.value = true;
}

async function saveDuty() {
  if (!dutyTarget.value) return;
  dutySaving.value = true;
  try {
    await $fetch("/api/admin/bili/duty", {
      method: "PUT",
      body: {
        connectionId: dutyTarget.value.connectionId,
        duty: {
          perDay: dutyForm.perDay,
          peakValley: dutyForm.peakValley,
          noon: dutyForm.noon,
          night: dutyForm.night,
          keywords: dutyForm.keywordsText.split(/[,，\n]/).map((k) => k.trim()).filter(Boolean),
          zone: dutyForm.zone,
          frames: dutyForm.frames,
          dmMode: dutyForm.dmMode,
          autoComment: dutyForm.autoComment,
          commentPerRound: dutyForm.commentPerRound,
          mentionName: dutyForm.mentionName.trim(),
        },
      },
    });
    ElMessage.success("已保存，下一轮按新设置跑。");
    dutyVisible.value = false;
    await loadDashboard();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "保存值班设置失败。"));
  } finally {
    dutySaving.value = false;
  }
}

// ── 现在跑一轮 ─────────────────────────────────────────────
const running = ref<string | null>(null);

async function runRound() {
  const account = dashboard.value.accounts[0];
  const binding = account?.bindings[0];
  if (!account || !binding) {
    ElMessage.warning("还没有绑定角色的 B站 账号，先去「渠道管理」绑定一个角色。");
    return;
  }
  running.value = binding.bindingId;
  try {
    const result = await $fetch<{ ok: boolean; seconds: number; picked: number; skipped: number; error?: string }>(
      "/api/admin/bili/run-round",
      { method: "POST", body: { connectionId: account.connectionId, bindingId: binding.bindingId } },
    );
    lastRoundSeconds.value = result.seconds;
    if (result.ok) {
      ElMessage.success(`跑完了（${result.seconds}s），挑中 ${result.picked} 条、跳过 ${result.skipped} 条。`);
    } else {
      ElMessage.warning(result.error || "这一轮没跑成。");
    }
    await loadDashboard();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "执行失败。"));
  } finally {
    running.value = null;
  }
}

// ── 扫码登录 ───────────────────────────────────────────────
type BiliAuthStatus = { ok: boolean; user: unknown; error: { code?: string; message?: string; hint?: string } | null };

const loginVisible = ref(false);
const loginLoading = ref(false);
const qrDataUrl = ref("");
const loginStatus = ref<"idle" | "waiting" | "done" | "error" | "expired">("idle");
const loginUser = ref<unknown>(null);
let loginTimer: ReturnType<typeof setInterval> | null = null;

async function startLogin() {
  loginLoading.value = true;
  loginStatus.value = "idle";
  qrDataUrl.value = "";
  loginUser.value = null;
  try {
    const result = await $fetch<{ ok: boolean; code: number | null; stderr: string }>("/api/admin/bili/auth/login", { method: "POST" });
    if (!result.ok) {
      ElMessage.error(result.stderr || "发起登录失败，请确认 bili CLI 已安装。");
      loginStatus.value = "error";
      return;
    }
    const qr = await $fetch<{ dataUrl: string }>("/api/admin/bili/auth/qr");
    qrDataUrl.value = qr.dataUrl;
    loginStatus.value = "waiting";
    loginTimer = setInterval(pollLoginStatus, 2000);
  } catch (error) {
    loginStatus.value = "error";
    ElMessage.error(readErrorMessage(error, "发起登录失败。"));
  } finally {
    loginLoading.value = false;
  }
}

async function pollLoginStatus() {
  try {
    const status = await $fetch<BiliAuthStatus>("/api/admin/bili/auth/status");
    if (status.ok) {
      loginStatus.value = "done";
      loginUser.value = status.user;
      stopLoginTimer();
      ElMessage.success("B站 登录成功。");
      return;
    }
    if (status.error?.code === "login_expired") {
      loginStatus.value = "expired";
      stopLoginTimer();
      ElMessage.warning("二维码已过期，请重新生成。");
    }
  } catch {
    // 轮询失败忽略，等下一轮
  }
}

function stopLoginTimer() {
  if (loginTimer) {
    clearInterval(loginTimer);
    loginTimer = null;
  }
}

function closeLogin() {
  stopLoginTimer();
  loginVisible.value = false;
}

function userDisplay(user: unknown): string {
  if (user && typeof user === "object") {
    const record = user as Record<string, unknown>;
    const name = record.name ?? record.uname ?? record.nickname;
    if (typeof name === "string" && name) return name;
    const mid = record.mid ?? record.uid;
    if (mid !== undefined && mid !== null) return String(mid);
  }
  return "已登录";
}

onBeforeUnmount(stopLoginTimer);

// ── 封面 ───────────────────────────────────────────────────
const coverCache = reactive<Record<string, string>>({});
const coverBroken = reactive<Record<string, boolean>>({});

const COVER_GRADIENTS = [
  ["#3f6091", "#21324d"],
  ["#5d3f86", "#382253"],
  ["#2f6b5e", "#1a3b34"],
  ["#8a5a2b", "#4a2e16"],
];

function coverStyle(bvid: string, index: number) {
  if (coverCache[bvid]) return {};
  const [c1, c2] = COVER_GRADIENTS[index % COVER_GRADIENTS.length]!;
  return { "--c1": c1, "--c2": c2 };
}

async function resolveCover(bvid: string) {
  if (coverCache[bvid] || coverBroken[bvid]) return;
  try {
    const data = await $fetch<{ bvid: string; pic: string | null }>("/api/admin/bili/cover", { query: { bvid } });
    if (data.pic) coverCache[bvid] = data.pic;
    else coverBroken[bvid] = true;
  } catch {
    coverBroken[bvid] = true;
  }
}

async function loadCovers() {
  const bvids = bindings.value.flatMap((b) => b.seenToday.map((v) => v.bvid));
  await Promise.all([...new Set(bvids)].map((bvid) => resolveCover(bvid)));
}

// ── 小工具 ─────────────────────────────────────────────────
function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function windowLabel(window: "noon" | "night" | null) {
  if (window === "noon") return "中午 12–14 点";
  if (window === "night") return "夜间 18–次日 9 点";
  return "—";
}

function windowActiveLabel(account: BiliAccount) {
  return account.nextWindow ? `下次窗口 ${windowLabel(account.nextWindow)}` : "当前不在谷时窗口内";
}

function parsePickedVideos(content: string): Array<{ bvid: string; text: string }> {
  const blocks = content.split(/\n(?=###\s)/).filter((block) => block.trim());
  const result: Array<{ bvid: string; text: string }> = [];
  for (const block of blocks) {
    const match = block.match(/^###\s*(\S+)\s*([\s\S]*)$/);
    if (!match) continue;
    result.push({ bvid: match[1]!, text: match[2]!.trim() });
  }
  return result;
}

function isPicked(result: string) {
  return result === "picked";
}
</script>

<template>
  <div class="page-wrap desk-wrap">
    <div
      class="bd"
      :class="{ 'is-rail': rail }"
    >
      <!-- ── 侧栏 260px：工作台 / 常用 / 全部命令 ───────────── -->
      <aside class="bd-side">
        <div class="bd-side-head">
          <el-input
            ref="searchRef"
            v-model="query"
            :placeholder="`搜索 ${visibleCount} 条命令`"
            clearable
            title="按 Ctrl K 直接定位到这里"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
            <template #suffix>
              <kbd class="bd-kbd">Ctrl K</kbd>
            </template>
          </el-input>
        </div>

        <div class="bd-side-scroll">
          <!-- ① 工作台：视图入口，不是命令 -->
          <div class="bd-sec-label">
            工作台
          </div>
          <button
            class="bd-nav-ov"
            :class="{ on: view === 'overview' }"
            type="button"
            title="概览"
            @click="goWorkbench('overview')"
          >
            <el-icon><Grid /></el-icon>
            <span>概览</span>
          </button>
          <button
            class="bd-nav-ov"
            :class="{ on: view === 'history' }"
            type="button"
            title="运行记录"
            @click="goWorkbench('history')"
          >
            <el-icon><Clock /></el-icon>
            <span>运行记录</span>
            <span
              v-if="runLog.length"
              class="cnt"
            >{{ runLog.length }}</span>
          </button>

          <!-- ② 常用：日常 90% 的操作都在这里，可以取消固定 -->
          <template v-if="!searching">
            <div class="bd-sec-label">
              常用<span class="cnt">{{ pins.length }} 条</span>
            </div>
            <button
              v-for="p in pins"
              :key="p.key"
              class="bd-pin"
              :class="{ on: isCmdActive(p.item.id) }"
              type="button"
              :title="p.item.id"
              @click="selectItem(p.item)"
            >
              <el-icon class="pi">
                <component :is="pinIcon(p.item)" />
              </el-icon>
              <span class="pl">{{ pinLabel(p.item) }}</span>
              <span
                class="bd-pin-mark"
                title="取消固定"
                @click="unpin(p.key, $event)"
              >
                <el-icon><Close /></el-icon>
              </span>
            </button>
            <div
              v-if="!pins.length"
              class="bd-side-empty"
            >
              <template v-if="menuEmpty">
                常用栏里的命令也被藏起来了<br>
                <button
                  type="button"
                  @click="openMenuManager"
                >
                  点这里勾回来
                </button>
              </template>
              <template v-else>
                常用栏空了<br>
                <button
                  type="button"
                  @click="restorePins"
                >
                  恢复默认 4 条
                </button>
              </template>
            </div>
          </template>

          <!-- ③ 全部命令：就地折叠，不弹窗 -->
          <div class="bd-sec-label">
            全部命令<span class="cnt">{{ filteredGroups.length }} 组 · {{ visibleCount }} 条</span>
          </div>
          <el-skeleton
            v-if="catalogLoading"
            :rows="4"
            animated
          />
          <div
            v-for="g in filteredGroups"
            :key="g.group"
            class="bd-grp-wrap"
            :class="{ open: isGroupOpen(g.group) }"
          >
            <button
              class="bd-grp"
              type="button"
              :title="g.group"
              @click="toggleGroup(g.group)"
            >
              <el-icon class="gi">
                <component :is="groupIcon(g.group)" />
              </el-icon>
              <span class="grn">{{ g.group }}</span>
              <span class="cnt">{{ g.items.length }}</span>
              <el-icon class="chev">
                <ArrowRight />
              </el-icon>
            </button>
            <div class="bd-items">
              <button
                v-for="it in g.items"
                :key="it.id"
                class="bd-item"
                :class="{ on: isCmdActive(it.id) }"
                type="button"
                :title="it.id"
                @click="selectItem(it)"
              >
                <span class="lb">{{ it.label }}</span>
                <span
                  v-if="it.write"
                  class="bd-wtag"
                >写</span>
              </button>
            </div>
          </div>

          <div
            v-if="!catalogLoading && !groups.length"
            class="bd-side-empty"
          >
            命令目录还没读出来<br>
            刷新一下页面再试
          </div>
          <div
            v-else-if="menuEmpty && !searching"
            class="bd-side-empty"
          >
            菜单都被藏起来了<br>
            <button
              type="button"
              @click="openMenuManager"
            >
              点这里勾回来
            </button>
          </div>
          <div
            v-else-if="searching && !filteredGroups.length"
            class="bd-side-empty"
          >
            没有匹配「{{ query }}」的命令<br>共 {{ visibleCount }} 条
          </div>
        </div>

        <div class="bd-side-foot">
          <NuxtLink
            to="/"
            class="bd-foot-btn"
            title="回到忆灵小窝总览"
          >
            <el-icon><Document /></el-icon><span>回小窝</span>
          </NuxtLink>
          <button
            type="button"
            title="管理菜单：只显示你在用的命令"
            @click="openMenuManager"
          >
            <el-icon><Operation /></el-icon><span>管理菜单</span>
          </button>
          <button
            type="button"
            :title="rail ? '展开侧栏' : '收起侧栏，把宽度让给内容'"
            @click="railManual = !railManual"
          >
            <el-icon>
              <Expand v-if="rail" />
              <Fold v-else />
            </el-icon>
            <span>{{ rail ? "展开" : "收起" }}</span>
          </button>
        </div>
      </aside>

      <!-- ── 工作区：概览 / 运行记录 / 命令台 ───────────────── -->
      <main class="bd-work">
        <div class="bd-in">
          <!-- ① 概览 -->
          <template v-if="view === 'overview'">
            <div class="bd-crumb">
              工作台 <span>/</span> <b>概览</b>
            </div>

            <div class="bd-pageh">
              <div>
                <h1>{{ h1 }}</h1>
                <p>{{ subtitle }}</p>
              </div>
              <div class="ph-r">
                <button
                  class="bd-btn"
                  type="button"
                  @click="loginVisible = true"
                >
                  <el-icon><Camera /></el-icon>登录 B站
                </button>
                <button
                  class="bd-btn"
                  type="button"
                  :disabled="loading"
                  @click="refreshStatus"
                >
                  <el-icon><Refresh /></el-icon>刷新状态
                </button>
                <button
                  class="bd-btn primary lg"
                  type="button"
                  :disabled="running !== null"
                  @click="runRound"
                >
                  <el-icon><VideoPlay /></el-icon>{{ running ? "正在跑…" : "现在跑一轮" }}
                </button>
              </div>
            </div>

            <!-- 还没接入渠道 -->
            <div
              v-if="!loading && !dashboard.accounts.length"
              class="bd-empty-block"
            >
              <div class="halo">
                <el-icon :size="22">
                  <VideoPlay />
                </el-icon>
              </div>
              <h4>还没有 B站 渠道连接</h4>
              <p>先到「渠道管理 → 添加渠道 → B站 值班」创建连接并绑定角色，值班跑一轮后这里就会有数据。</p>
              <button
                class="bd-btn primary"
                type="button"
                @click="navigateTo('/channels')"
              >
                去创建连接
              </button>
            </div>

            <template v-else>
              <!-- KPI 四格 -->
              <div
                v-if="loading"
                class="bd-kpi-row"
              >
                <div
                  v-for="i in 4"
                  :key="i"
                  class="bd-kpi"
                >
                  <div
                    class="bd-sk"
                    style="height:12px;width:46%;margin-bottom:10px"
                  />
                  <div
                    class="bd-sk"
                    style="height:26px;width:58%;margin-bottom:10px"
                  />
                  <div
                    class="bd-sk"
                    style="height:10px;width:74%"
                  />
                </div>
              </div>
              <div
                v-else
                class="bd-kpi-row"
              >
                <div class="bd-kpi">
                  <div class="k">
                    <el-icon><Clock /></el-icon>今日进度
                  </div>
                  <div class="v">
                    {{ totalPickedToday }}<small>/ {{ totalPerDay || "—" }} 条</small>
                  </div>
                  <div class="bar">
                    <i :style="{ width: quotaPct + '%' }" />
                  </div>
                  <div class="foot">
                    {{ totalPerDay ? `已用 ${quotaPct}% 配额` : "还没设置每日条数" }}
                  </div>
                </div>

                <button
                  class="bd-kpi is-action"
                  type="button"
                  title="点「收件箱」跑一次获取未读"
                  @click="openCommandById('feed.inbox')"
                >
                  <div class="k">
                    <el-icon><Bell /></el-icon>待处理消息
                  </div>
                  <div class="v">
                    <span class="na">—</span>
                  </div>
                  <div class="foot">
                    点「收件箱」拉一次才有未读数
                  </div>
                </button>

                <div class="bd-kpi">
                  <div class="k">
                    <el-icon><View /></el-icon>判重跳过
                  </div>
                  <div class="v">
                    {{ skippedSeen }}<small>条</small>
                  </div>
                  <div class="foot">
                    今天看过 {{ totalSeenToday }} 条，跳过 {{ skippedSeen }} 条
                  </div>
                </div>

                <div class="bd-kpi">
                  <div class="k">
                    <el-icon><DataLine /></el-icon>本轮耗时
                  </div>
                  <div class="v">
                    <span
                      v-if="lastRun.v === '—'"
                      class="na"
                    >—</span>
                    <template v-else>
                      {{ lastRun.v }}<small>{{ lastRun.u }}</small>
                    </template>
                  </div>
                  <div class="foot">
                    {{ lastHint }}
                  </div>
                </div>
              </div>

              <!-- 左：她今天看了什么 + 今日报告 / 右：快速开始 + 最近运行 -->
              <div class="bd-home-cols">
                <div>
                  <div class="bd-sec-h">
                    <h2>她今天看了什么</h2>
                    <span
                      v-if="totalSeenToday"
                      class="sub"
                    >{{ totalPickedToday }} 条采纳 · {{ skippedSeen }} 条跳过</span>
                    <button
                      class="more"
                      type="button"
                      @click="goWorkbench('history')"
                    >
                      全部记录<el-icon><ArrowRight /></el-icon>
                    </button>
                  </div>
                  <div class="bd-card">
                    <div
                      v-for="(video, idx) in recentSeen"
                      :key="video.bvid"
                      class="bd-wrow"
                      @click="goWorkbench('history')"
                    >
                      <div
                        class="bd-mcover"
                        :style="coverStyle(video.bvid, idx)"
                      >
                        <img
                          v-if="coverCache[video.bvid]"
                          :src="coverCache[video.bvid]"
                          alt=""
                          loading="lazy"
                          referrerpolicy="no-referrer"
                          @error="coverBroken[video.bvid] = true; delete coverCache[video.bvid]"
                        >
                        <span v-else>{{ (video.title || video.bvid).slice(0, 3) }}</span>
                      </div>
                      <div class="bd-wb">
                        <div class="wt">
                          {{ video.title || "（无标题）" }}
                        </div>
                        <div class="wm">
                          <span>{{ video.author || "未知 UP" }}</span>
                          <i class="sep" />
                          <span>{{ video.characterName }}</span>
                          <span
                            class="bd-badge"
                            :class="isPicked(video.result) ? 'ok' : 'mute'"
                          >{{ isPicked(video.result) ? "挑中" : "跳过" }}</span>
                        </div>
                      </div>
                      <el-icon class="arw">
                        <ArrowRight />
                      </el-icon>
                    </div>
                    <div
                      v-if="!recentSeen.length"
                      class="bd-empty-mini"
                    >
                      <el-icon><View /></el-icon>
                      <span>判重表里还没有今天的记录</span>
                      <span>跑一轮值班，她看过什么就会记在这里</span>
                    </div>
                  </div>

                  <div class="bd-sec-h">
                    <h2>今日报告</h2>
                    <span class="sub">{{ totalRounds ? `${totalRounds} 轮` : "" }}</span>
                    <button
                      class="more"
                      type="button"
                      @click="goWorkbench('history')"
                    >
                      看全部记录<el-icon><ArrowRight /></el-icon>
                    </button>
                  </div>
                  <div class="bd-card">
                    <article
                      v-for="report in recentReports.slice(0, 2)"
                      :key="report.id"
                      class="bd-report"
                    >
                      <div class="bd-rm is-head">
                        <span>第 {{ report.roundIndex }} 轮</span>
                        <span>{{ report.characterName }}</span>
                        <span>{{ formatDateTime(report.createdAt) }}</span>
                        <span>挑中 <b>{{ report.pickedCount }} 条</b></span>
                      </div>
                      <div
                        v-if="parsePickedVideos(report.content).length"
                        class="bd-picks"
                      >
                        <div
                          v-for="video in parsePickedVideos(report.content)"
                          :key="video.bvid"
                          class="bd-pick"
                        >
                          <code>{{ video.bvid }}</code>
                          <span>{{ video.text || "（无标题）" }}</span>
                        </div>
                      </div>
                      <p
                        v-else
                        class="bd-muted"
                      >
                        这一轮没有挑中的视频。
                      </p>
                    </article>
                    <div
                      v-if="!recentReports.length"
                      class="bd-empty-mini"
                    >
                      <el-icon><ChatLineRound /></el-icon>
                      <span>今天还没有报告</span>
                      <span>跑一轮之后，这里会是她写的当日小结</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div class="bd-sec-h">
                    <h2>快速开始</h2>
                  </div>
                  <div class="bd-card">
                    <div class="bd-qlist">
                      <button
                        v-for="link in pins"
                        :key="link.key"
                        class="bd-qirow"
                        type="button"
                        @click="selectItem(link.item)"
                      >
                        <span class="qic"><el-icon><component :is="pinIcon(link.item)" /></el-icon></span>
                        <span class="qn">{{ pinLabel(link.item) }}</span>
                        <code class="qc">{{ link.item.id }}</code>
                        <el-icon class="arw">
                          <ArrowRight />
                        </el-icon>
                      </button>
                    </div>
                  </div>

                  <div class="bd-sec-h">
                    <h2>最近运行</h2>
                    <button
                      class="more"
                      type="button"
                      @click="goWorkbench('history')"
                    >
                      全部记录<el-icon><ArrowRight /></el-icon>
                    </button>
                  </div>
                  <div class="bd-card">
                    <div
                      v-for="entry in runLog.slice(0, 4)"
                      :key="entry.id"
                      class="bd-rrow"
                      @click="goWorkbench('history')"
                    >
                      <span
                        class="rdot"
                        :class="entry.ok ? 'ok' : 'err'"
                      />
                      <div class="rmain">
                        <div class="rc">
                          bili {{ entry.argv.join(" ") }}
                        </div>
                        <div class="rs">
                          {{ entry.label }}
                        </div>
                      </div>
                      <span class="rt">{{ entry.seconds }}s · {{ formatTime(entry.at) }}</span>
                    </div>
                    <div
                      v-if="!runLog.length"
                      class="bd-empty-mini"
                    >
                      <el-icon><Operation /></el-icon>
                      <span>这次启动还没跑过命令</span>
                      <span>上面「快速开始」挑一条试试</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 账号与角色：多账号/绑定关系只在这里能看全 -->
              <div class="bd-sec-h">
                <h2>账号与角色</h2>
                <span class="sub">{{ dashboard.today }}</span>
              </div>
              <div class="bd-card bd-accounts">
                <div
                  v-for="account in dashboard.accounts"
                  :key="account.connectionId"
                  class="bd-account"
                >
                  <div class="bd-account-row">
                    <span class="bd-account-name">{{ account.displayName }}</span>
                    <span class="bd-badge mute">{{ windowActiveLabel(account) }}</span>
                    <span class="bd-account-meta">
                      数据目录 {{ account.dataHome || "（默认）" }} · 每天上限 {{ account.duty.perDay }} 条
                    </span>
                    <button
                      class="bd-btn is-sm"
                      type="button"
                      @click="openDutySettings(account)"
                    >
                      <el-icon><Setting /></el-icon>值班设置
                    </button>
                  </div>
                  <div
                    v-if="!account.bindings.length"
                    class="bd-account-empty"
                  >
                    这个账号还没绑定角色，值班不会产生对话。去
                    <NuxtLink to="/channels">
                      渠道管理
                    </NuxtLink> 绑定一个。
                  </div>
                  <div
                    v-for="binding in account.bindings"
                    :key="binding.bindingId"
                    class="bd-binding"
                  >
                    <span class="bd-binding-role">{{ binding.characterName }}</span>
                    <span class="bd-binding-stat">今日 {{ binding.pickedToday }} / {{ binding.perDay }} 条</span>
                    <span class="bd-binding-stat">剩余 {{ binding.remaining }} 条</span>
                    <span class="bd-binding-stat">{{ binding.reports.length }} 轮报告</span>
                    <span class="bd-binding-stat">{{ binding.seenToday.length }} 条看过</span>
                  </div>
                </div>
              </div>
            </template>
          </template>

          <!-- ② 运行记录 -->
          <template v-else-if="view === 'history'">
            <div class="bd-crumb">
              工作台 <span>/</span> <b>运行记录</b>
            </div>
            <div class="bd-pageh">
              <div>
                <h1>今天的值班记录</h1>
                <p>{{ allReports.length }} 轮报告 · {{ allSeen.length }} 条看过的视频 · 最新的在最前</p>
              </div>
              <div class="ph-r">
                <button
                  class="bd-btn"
                  type="button"
                  :disabled="loading"
                  @click="refreshStatus"
                >
                  <el-icon><Refresh /></el-icon>刷新状态
                </button>
              </div>
            </div>

            <div class="bd-filters">
              <button
                class="bd-chip"
                :class="{ on: historyFilter === 'all' }"
                type="button"
                @click="historyFilter = 'all'"
              >
                全部<span class="n">{{ allReports.length + allSeen.length }}</span>
              </button>
              <button
                class="bd-chip"
                :class="{ on: historyFilter === 'report' }"
                type="button"
                @click="historyFilter = 'report'"
              >
                今日报告<span class="n">{{ allReports.length }}</span>
              </button>
              <button
                class="bd-chip"
                :class="{ on: historyFilter === 'seen' }"
                type="button"
                @click="historyFilter = 'seen'"
              >
                看过的视频<span class="n">{{ allSeen.length }}</span>
              </button>
            </div>

            <div
              v-if="!allReports.length && !allSeen.length"
              class="bd-empty-block"
            >
              <div class="halo">
                <el-icon :size="22">
                  <Clock />
                </el-icon>
              </div>
              <h4>今天还没有记录</h4>
              <p>回概览点「现在跑一轮」，或等谷时窗口到了自动跑，这里就会有报告和看过的视频。</p>
              <button
                class="bd-btn primary"
                type="button"
                @click="goWorkbench('overview')"
              >
                回概览
              </button>
            </div>

            <template v-else>
              <template v-if="historyFilter !== 'seen'">
                <div
                  v-if="allReports.length"
                  class="bd-sec-h"
                >
                  <h2>今日报告</h2>
                </div>
                <div
                  v-if="allReports.length"
                  class="bd-card"
                >
                  <article
                    v-for="report in allReports"
                    :key="report.id"
                    class="bd-report"
                  >
                    <div class="bd-rm is-head">
                      <span>第 {{ report.roundIndex }} 轮</span>
                      <span>{{ report.characterName }}</span>
                      <span>{{ formatDateTime(report.createdAt) }}</span>
                      <span>挑中 <b>{{ report.pickedCount }} 条</b></span>
                    </div>
                    <div
                      v-if="parsePickedVideos(report.content).length"
                      class="bd-picks"
                    >
                      <div
                        v-for="video in parsePickedVideos(report.content)"
                        :key="video.bvid"
                        class="bd-pick"
                      >
                        <code>{{ video.bvid }}</code>
                        <span>{{ video.text || "（无标题）" }}</span>
                      </div>
                    </div>
                    <p
                      v-else
                      class="bd-muted"
                    >
                      这一轮没有挑中的视频。
                    </p>
                  </article>
                </div>
              </template>

              <template v-if="historyFilter !== 'report'">
                <div
                  v-if="allSeen.length"
                  class="bd-sec-h"
                >
                  <h2>今天看过的视频</h2>
                  <span class="sub">{{ allSeen.length }} 条</span>
                </div>
                <div
                  v-if="allSeen.length"
                  class="bd-card"
                >
                  <div
                    v-for="(video, idx) in allSeen"
                    :key="video.bvid"
                    class="bd-wrow"
                  >
                    <div
                      class="bd-mcover"
                      :style="coverStyle(video.bvid, idx)"
                    >
                      <img
                        v-if="coverCache[video.bvid]"
                        :src="coverCache[video.bvid]"
                        alt=""
                        loading="lazy"
                        referrerpolicy="no-referrer"
                        @error="coverBroken[video.bvid] = true; delete coverCache[video.bvid]"
                      >
                      <span v-else>{{ (video.title || video.bvid).slice(0, 3) }}</span>
                    </div>
                    <div class="bd-wb">
                      <div class="wt">
                        {{ video.title || "（无标题）" }}
                      </div>
                      <div class="wm">
                        <span>{{ video.author || "未知 UP" }}</span>
                        <i class="sep" />
                        <span>{{ video.characterName }}</span>
                        <i class="sep" />
                        <span class="bd-mono">{{ video.bvid }}</span>
                        <span
                          v-if="video.reason"
                          class="bd-reason"
                        >{{ video.reason }}</span>
                      </div>
                    </div>
                    <span
                      class="bd-badge"
                      :class="isPicked(video.result) ? 'ok' : 'mute'"
                    >{{ isPicked(video.result) ? "挑中" : "跳过" }}</span>
                    <span class="bd-seen-time">{{ formatTime(video.seenAt) }}</span>
                  </div>
                </div>
              </template>

              <div
                v-if="historyFilter === 'report' && !allReports.length"
                class="bd-empty-block is-compact"
              >
                <div class="halo">
                  <el-icon :size="22">
                    <ChatLineRound />
                  </el-icon>
                </div>
                <h4>今天还没有报告</h4>
                <p>跑一轮值班之后，这里会是她写的当日小结。切回「全部」还能看到今天看过的视频。</p>
                <button
                  class="bd-btn"
                  type="button"
                  @click="historyFilter = 'all'"
                >
                  看全部记录
                </button>
              </div>
              <div
                v-if="historyFilter === 'seen' && !allSeen.length"
                class="bd-empty-block is-compact"
              >
                <div class="halo">
                  <el-icon :size="22">
                    <View />
                  </el-icon>
                </div>
                <h4>判重表里还没有今天的记录</h4>
                <p>跑一轮值班，她看过什么就会记在这里，跳过和挑中都算。</p>
                <button
                  class="bd-btn"
                  type="button"
                  @click="historyFilter = 'all'"
                >
                  看全部记录
                </button>
              </div>
            </template>
          </template>

          <!-- ③ 命令台 / 升级自检 -->
          <template v-else>
            <div
              v-if="activeCmd"
              class="bd-crumb"
            >
              <span>{{ activeCmd.kind ? "面板" : "命令" }}</span>
              <span>/</span>
              <b>{{ activeCmd.label }}</b>
            </div>

            <template v-if="activeCmd">
              <div class="bd-cmd-h">
                <div class="cmd-ic">
                  <el-icon>
                    <Promotion v-if="activeCmd.write" />
                    <Operation v-else-if="isSelfCheck" />
                    <Setting v-else />
                  </el-icon>
                </div>
                <div class="hm">
                  <h2 class="cmd-title">
                    {{ activeCmd.label }}
                    <span
                      v-if="activeCmd.write"
                      class="bd-tag-w"
                    >写操作</span>
                  </h2>
                  <div class="cmd-sub">
                    <code v-if="activeCmd.argv.length">bili {{ activeCmd.argv.join(" ") }}</code>
                    <span v-if="isSelfCheck">本地 CLI 自检：跑下面三条确认环境</span>
                  </div>
                </div>
                <div class="ph-r">
                  <button
                    class="bd-btn"
                    type="button"
                    @click="goWorkbench('overview')"
                  >
                    回概览
                  </button>
                </div>
              </div>

              <!-- 升级自检：三条真实命令 -->
              <div
                v-if="isSelfCheck"
                class="bd-card"
              >
                <div class="bd-qlist">
                  <button
                    v-for="entry in SELF_CHECK"
                    :key="entry.itemId"
                    class="bd-qirow"
                    type="button"
                    :disabled="busy"
                    @click="runSelfCheck(entry)"
                  >
                    <span class="qic"><el-icon><Operation /></el-icon></span>
                    <span class="qn">
                      {{ entry.label }}
                      <em class="bd-qdesc">{{ entry.desc }}</em>
                    </span>
                    <code class="qc">bili {{ entry.argv.join(" ") }}</code>
                    <el-icon class="arw">
                      <ArrowRight />
                    </el-icon>
                  </button>
                </div>
              </div>

              <!-- 普通命令：参数 + 运行条 -->
              <template v-else>
                <div class="bd-panel">
                  <div class="bd-panel-body">
                    <div
                      v-if="params.length"
                      class="bd-fields"
                    >
                      <div
                        v-for="p in inputs"
                        :key="p.key"
                        class="bd-fld"
                        :class="{ wide: p.pos }"
                      >
                        <label class="fl">{{ p.label }}<i v-if="p.pos">*</i></label>
                        <el-select
                          v-if="p.type === 'select'"
                          v-model="values[p.key]"
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
                        class="bd-fld"
                      >
                        <label class="fl">{{ p.label }}</label>
                        <el-switch v-model="values[p.key]" />
                      </div>
                    </div>
                    <p
                      v-else
                      class="bd-muted"
                      style="margin:0"
                    >
                      这条命令没有参数，直接运行。
                    </p>
                  </div>

                  <div class="bd-runbar">
                    <el-icon class="ri">
                      <Promotion />
                    </el-icon>
                    <code :title="preview">{{ preview }}</code>
                    <span
                      v-if="activeCmd.write && dryRun"
                      class="dry"
                    >已加 --dry-run</span>
                    <button
                      class="bd-icon-btn"
                      type="button"
                      title="复制命令"
                      @click="copyCmd"
                    >
                      <el-icon><CopyDocument /></el-icon>
                    </button>
                    <el-checkbox
                      v-if="activeCmd.write"
                      v-model="dryRun"
                      size="small"
                    >
                      安全预览
                    </el-checkbox>
                    <button
                      class="bd-btn primary"
                      type="button"
                      :disabled="busy || missing.length > 0"
                      @click="runCommand"
                    >
                      <el-icon><VideoPlay /></el-icon>{{ busy ? "执行中" : "运行" }}
                    </button>
                  </div>
                </div>
                <p
                  v-if="missing.length"
                  class="bd-muted"
                  style="margin:8px 0 0"
                >
                  还差：{{ missing.join("、") }}
                </p>
              </template>

              <!-- 最新结果 -->
              <template v-if="lastResult">
                <div class="bd-sec-h">
                  <h2>最新结果</h2>
                  <span class="sub">{{ lastLabel }}</span>
                  <span
                    class="bd-result-tag"
                    :class="lastResult.code === 0 ? 'ok' : 'err'"
                  >{{ lastResult.code === 0 ? "成功" : lastResult.code === null ? "无退出码" : `退出码 ${lastResult.code}` }} · {{ lastResult.elapsed }}s</span>
                </div>
                <div class="bd-card">
                  <div class="bd-result-head">
                    <code>bili {{ lastResult.argv.join(" ") }}</code>
                    <span class="bd-muted">{{ resultSummary(lastResult) }}</span>
                  </div>
                  <pre class="bd-code">{{ formatResult() }}</pre>
                </div>
              </template>
            </template>

            <div
              v-else
              class="bd-empty-block"
            >
              <div class="halo">
                <el-icon :size="22">
                  <Operation />
                </el-icon>
              </div>
              <h4>从左边挑一条命令</h4>
              <p>日常操作在侧栏「常用」里；想知道今天怎么样，回概览看。</p>
              <button
                class="bd-btn"
                type="button"
                @click="goWorkbench('overview')"
              >
                回概览
              </button>
            </div>
          </template>
        </div>
      </main>
    </div>

    <!-- 值班设置 -->
    <el-dialog
      v-model="dutyVisible"
      title="值班设置"
      width="660px"
      :close-on-click-modal="false"
    >
      <div class="bd-dialog-body">
        <el-form label-position="top">
          <el-row :gutter="16">
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="每天最多挑几条（0-50）">
                <el-input-number
                  v-model="dutyForm.perDay"
                  :min="0"
                  :max="50"
                  controls-position="right"
                  style="width:100%"
                />
              </el-form-item>
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="峰谷时段自动刷">
                <el-switch v-model="dutyForm.peakValley" />
              </el-form-item>
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="中午窗口 12:00–14:00">
                <el-switch
                  v-model="dutyForm.noon"
                  :disabled="!dutyForm.peakValley"
                />
              </el-form-item>
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="夜间窗口 18:00–09:00">
                <el-switch
                  v-model="dutyForm.night"
                  :disabled="!dutyForm.peakValley"
                />
              </el-form-item>
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="投递方式">
                <el-radio-group v-model="dutyForm.dmMode">
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
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="热门分区">
                <el-select
                  v-model="dutyForm.zone"
                  style="width:100%"
                  filterable
                  allow-create
                >
                  <el-option
                    v-for="zone in ZONES"
                    :key="zone"
                    :label="zone === 'all' ? '全站' : zone"
                    :value="zone"
                  />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="每条视频抽几帧（0 = 不抽）">
                <el-input-number
                  v-model="dutyForm.frames"
                  :min="0"
                  :max="30"
                  controls-position="right"
                  style="width:100%"
                />
              </el-form-item>
            </el-col>
            <el-col
              :xs="24"
              :sm="12"
            >
              <el-form-item label="自动公开评论">
                <el-switch v-model="dutyForm.autoComment" />
              </el-form-item>
            </el-col>
            <el-col
              v-if="dutyForm.autoComment"
              :xs="24"
              :sm="12"
            >
              <el-form-item label="@ 谁（留空 = 不 @ 任何人）">
                <el-input
                  v-model="dutyForm.mentionName"
                  placeholder="例如：没有喵i"
                />
              </el-form-item>
            </el-col>
            <el-col
              v-if="dutyForm.autoComment"
              :xs="24"
              :sm="12"
            >
              <el-form-item label="每轮最多几条评论">
                <el-input-number
                  v-model="dutyForm.commentPerRound"
                  :min="0"
                  :max="20"
                  controls-position="right"
                  style="width:100%"
                />
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="关注关键词（每行一个，可留空；留空则只看热榜和推荐流）">
                <el-input
                  v-model="dutyForm.keywordsText"
                  type="textarea"
                  :rows="3"
                  placeholder="例如：DeepSeek&#10;AI 绘画"
                />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>

        <el-alert
          v-if="dutyForm.autoComment"
          type="warning"
          :closable="false"
          show-icon
          title="公开评论会以该 B站 账号的身份真的发出去。"
        />
      </div>
      <template #footer>
        <el-button @click="dutyVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="dutySaving"
          @click="saveDuty"
        >
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 扫码登录 -->
    <el-dialog
      v-model="loginVisible"
      title="登录 B站"
      width="420px"
      :close-on-click-modal="false"
      @close="closeLogin"
    >
      <div class="bd-login">
        <template v-if="loginStatus === 'done'">
          <div class="bd-login-done">
            <el-icon class="bd-login-check">
              <ChatLineRound />
            </el-icon>
            <p>已登录：{{ userDisplay(loginUser) }}</p>
            <el-button
              type="primary"
              @click="loginVisible = false"
            >
              完成
            </el-button>
          </div>
        </template>
        <template v-else-if="loginStatus === 'error'">
          <div class="bd-login-done">
            <p>登录失败，请确认 bili CLI 已安装并能访问网络。</p>
            <el-button @click="startLogin">
              重试
            </el-button>
          </div>
        </template>
        <template v-else>
          <div
            v-loading="loginLoading"
            class="bd-login-qr"
          >
            <img
              v-if="qrDataUrl"
              :src="qrDataUrl"
              alt="B站登录二维码"
              class="bd-login-qrimg"
              :class="{ expired: loginStatus === 'expired' }"
            >
            <div
              v-else
              class="bd-login-empty"
            >
              点击「生成二维码」开始登录
            </div>
            <p class="bd-muted">
              {{ loginStatus === 'expired' ? '二维码已过期，请重新生成' : loginStatus === 'waiting' ? '请用 B站 App 扫码登录' : '扫码登录后即可使用 B站 全部功能' }}
            </p>
            <el-button
              v-if="loginStatus !== 'waiting'"
              type="primary"
              :loading="loginLoading"
              @click="startLogin"
            >
              {{ loginStatus === 'expired' ? '重新生成二维码' : '生成二维码' }}
            </el-button>
          </div>
        </template>
      </div>
    </el-dialog>

    <!-- 管理菜单：只影响侧栏显示，命令表本身一条都不动 -->
    <el-dialog
      v-model="menuOpen"
      width="680px"
      :close-on-click-modal="false"
    >
      <template #header>
        <div class="bd-menu-h">
          <span>管理菜单</span>
          <span class="bd-menu-hsub">已选 {{ menuVisibleCount }} / {{ menuTotal }} 条</span>
        </div>
      </template>

      <p class="bd-menu-hint">
        勾上要用的，取消勾就藏起来 —— 改动只影响显示，命令本身都还在，随时能勾回来。
      </p>

      <div class="bd-menu-mgr">
        <div class="bd-menu-bar">
          <el-checkbox
            :model-value="menuAllShown"
            :indeterminate="!menuAllShown && menuVisibleCount > 0"
            @change="(v: string | number | boolean) => menuToggleAll(Boolean(v))"
          >
            全选
          </el-checkbox>
          <el-input
            v-model="menuQuery"
            size="small"
            placeholder="搜组名 / 命令名 / 命令…"
            clearable
            class="bd-menu-search"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <span class="bd-menu-cnt">显示 {{ menuVisibleCount }} / {{ menuTotal }}</span>
        </div>

        <div
          v-for="g in menuShownGroups"
          :key="g.group"
          class="bd-menu-grp"
        >
          <div class="bd-menu-grp-h">
            <el-checkbox
              :model-value="menuGroupState(g) === 'all'"
              :indeterminate="menuGroupState(g) === 'some'"
              @change="(v: string | number | boolean) => menuToggleGroup(g.group, Boolean(v))"
            >
              <b :class="{ 'is-off': draftHiddenGroups.includes(g.group) }">{{ g.group }}</b>
            </el-checkbox>
            <span class="bd-menu-badge">{{ (menuFullOf(g.group) ?? g).items.length }}</span>
          </div>
          <div class="bd-menu-items">
            <el-checkbox
              v-for="it in g.items"
              :key="it.id"
              class="bd-menu-item"
              :model-value="!draftHiddenGroups.includes(g.group) && !draftHiddenItems.includes(it.id)"
              :disabled="draftHiddenGroups.includes(g.group)"
              @change="(v: string | number | boolean) => menuToggleItem(it.id, Boolean(v))"
            >
              <span
                class="bd-menu-label"
                :class="{ 'is-off': draftHiddenGroups.includes(g.group) || draftHiddenItems.includes(it.id) }"
              >{{ it.label }}</span>
              <code class="bd-menu-cmd">{{ it.argv.join(" ") }}</code>
            </el-checkbox>
          </div>
        </div>

        <div
          v-if="!menuTotal"
          class="bd-menu-empty"
        >
          <el-icon :size="22">
            <Operation />
          </el-icon>
          <p>命令表还没加载出来</p>
        </div>
        <div
          v-else-if="!menuShownGroups.length"
          class="bd-menu-empty"
        >
          <el-icon :size="22">
            <Search />
          </el-icon>
          <p>没找到「{{ menuQuery }}」相关的命令</p>
        </div>
      </div>

      <template #footer>
        <div class="bd-menu-foot">
          <span class="bd-menu-foottip">配置存在本机浏览器，换台机器需要重新勾。</span>
          <el-button @click="menuOpen = false">
            取消
          </el-button>
          <el-button
            type="primary"
            @click="saveMenu"
          >
            保存
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════
   B站值班台 —— 完全对齐 bili-desk 的设计契约：
   · 外壳锁死一屏，两栏各自内部滚动，整页不滚
   · 底色 #f4f6f9，卡片才用纯白 —— 靠明度差分层
   · 字号只有六档 12 / 14 / 16 / 18 / 22 / 26，最小 12px
   · 圆角只两档：容器 10 / 控件 8，另加药丸 999
   · 主色 #d94a76 只用于图标/选中/进度；实心按钮用 #c9416b
   ══════════════════════════════════════════════════════════ */
.desk-wrap {
  --bd-bg: #f4f6f9;
  --bd-surface: #fff;
  --bd-surface-2: #f8f9fb;
  --bd-surface-3: #f1f3f7;
  --bd-line: #e6e9ef;
  --bd-line-strong: #dbe0e9;
  --bd-text: #101620;
  --bd-text-2: #454f5e;
  --bd-dim: #68717f;
  --bd-faint: #9aa3b1;
  --bd-brand: #d94a76;
  --bd-brand-btn: #c9416b;
  --bd-brand-btn-h: #b8375f;
  --bd-brand-strong: #bf3a63;
  --bd-brand-soft: #fdf0f4;
  --bd-brand-line: #f6d3df;
  --bd-green: #0f8f63;
  --bd-red: #c92b41;
  --bd-amber: #b5813f;
  --bd-radius: 10px;
  --bd-radius-sm: 8px;
  --bd-radius-xs: 6px;
  --bd-ease: cubic-bezier(.2, .7, .3, 1);
  --bd-sh1: 0 1px 2px rgba(16, 24, 40, .05);
  --bd-grad-brand: linear-gradient(135deg, #ff8fae 0%, #ef5f8b 100%);
  --side-w: 260px;

  max-width: none;
  padding: 0;
}
.desk-wrap button { font-family: inherit; }

.bd {
  display: flex;
  height: calc(100vh - var(--topbar-h, 56px));
  background: var(--bd-bg);
  overflow: hidden;
}

/* ── 侧栏 260px 贴边满高 ─────────────────────────────── */
.bd-side {
  display: flex;
  width: var(--side-w);
  flex: none;
  flex-direction: column;
  height: 100%;
  border-right: 1px solid var(--bd-line);
  background: var(--bd-surface);
}
.bd-side-head { flex: none; padding: 12px 12px 6px; }
.bd-side-head :deep(.el-input__wrapper) {
  min-height: 36px;
  padding: 1px 10px;
  border-radius: var(--bd-radius-sm);
  background: var(--bd-surface-2);
  box-shadow: 0 0 0 1px var(--bd-line-strong) inset;
}
.bd-side-head :deep(.el-input__wrapper:hover) { box-shadow: 0 0 0 1px #c6cdd8 inset; }
.bd-side-head :deep(.el-input__wrapper.is-focus) {
  background: #fff;
  box-shadow: 0 0 0 1px var(--bd-brand) inset, 0 0 0 3px rgba(217, 74, 118, .13);
}
.bd-side-head :deep(.el-input__inner) { font-size: 14px; }
.bd-side-head :deep(.el-input__prefix) { color: var(--bd-faint); }
.bd-kbd {
  border: 1px solid var(--bd-line-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fff;
  padding: 2px 5px;
  color: var(--bd-faint);
  font: 12px/1 Consolas, monospace;
  white-space: nowrap;
}

.bd-side-scroll {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 2px 10px 12px;
}
.bd-side-scroll::-webkit-scrollbar { width: 8px; }
.bd-side-scroll::-webkit-scrollbar-thumb { border-radius: 4px; background: #dfe3ea; }

.bd-sec-label {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 14px 8px 5px;
  color: var(--bd-faint);
  font-size: 12px;
  font-weight: 700;
}
.bd-sec-label .cnt {
  margin-left: auto;
  color: #b3bac6;
  font: 400 12px/1 Consolas, monospace;
}

.bd-nav-ov {
  display: flex;
  width: 100%;
  height: 34px;
  align-items: center;
  gap: 9px;
  margin-top: 2px;
  border: 0;
  border-radius: 7px;
  background: none;
  padding: 0 8px;
  color: #59616f;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background .13s var(--bd-ease), color .13s var(--bd-ease);
}
.bd-nav-ov:hover { background: var(--bd-surface-2); color: var(--bd-text); }
.bd-nav-ov.on { background: var(--bd-brand-soft); color: var(--bd-brand-strong); }
.bd-nav-ov :deep(.el-icon) { flex: none; color: var(--bd-faint); font-size: 16px; }
.bd-nav-ov.on :deep(.el-icon) { color: var(--bd-brand); }
.bd-nav-ov .cnt {
  margin-left: auto;
  color: #b3bac6;
  font: 400 12px/1 Consolas, monospace;
}
.bd-nav-ov.on .cnt { color: var(--bd-brand-strong); opacity: .75; }

/* 常用：可取消固定 */
.bd-pin {
  position: relative;
  display: flex;
  width: 100%;
  height: 32px;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 7px;
  background: none;
  padding: 0 8px;
  color: #59616f;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background .13s var(--bd-ease), color .13s var(--bd-ease);
}
.bd-pin:hover { background: var(--bd-surface-2); color: var(--bd-text); }
.bd-pin.on { background: var(--bd-brand-soft); color: var(--bd-brand-strong); font-weight: 600; }
.bd-pin :deep(.el-icon.pi) { flex: none; color: var(--bd-faint); font-size: 14px; }
.bd-pin.on :deep(.el-icon.pi) { color: var(--bd-brand); }
.bd-pin .pl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-pin-mark {
  display: flex;
  width: 18px;
  height: 18px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: #c3c9d3;
  cursor: pointer;
  opacity: 0;
  transition: opacity .13s var(--bd-ease), background .13s var(--bd-ease);
}
.bd-pin:hover .bd-pin-mark { opacity: 1; }
.bd-pin-mark:hover { background: #ffe6ec; color: var(--bd-brand-strong); }
.bd-pin-mark :deep(.el-icon) { font-size: 12px; }

/* 全部命令：就地折叠树 */
.bd-grp-wrap { margin-top: 1px; }
.bd-grp {
  display: flex;
  width: 100%;
  height: 34px;
  align-items: center;
  gap: 9px;
  border: 0;
  border-radius: 7px;
  background: none;
  padding: 0 8px;
  color: #59616f;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: background .13s var(--bd-ease), color .13s var(--bd-ease);
}
.bd-grp:hover { background: var(--bd-surface-2); color: var(--bd-text); }
.bd-grp :deep(.el-icon.gi) { flex: none; color: #a5adb9; font-size: 16px; }
.bd-grp .grn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-grp .cnt { color: #b3bac6; font: 400 12px/1 Consolas, monospace; }
.bd-grp :deep(.el-icon.chev) { color: #c3c9d3; font-size: 12px; transition: transform .2s var(--bd-ease); }
.bd-grp-wrap.open .bd-grp :deep(.el-icon.chev) { transform: rotate(90deg); }

.bd-items { display: none; position: relative; padding: 2px 0 5px; }
.bd-grp-wrap.open .bd-items { display: block; }
/* 1px 树形引导线：让子项和组名有层级差 */
.bd-grp-wrap.open .bd-items::before {
  position: absolute;
  top: 5px;
  bottom: 9px;
  left: 27px;
  width: 1px;
  border-radius: 1px;
  background: var(--bd-line);
  content: "";
}

.bd-item {
  position: relative;
  display: flex;
  width: 100%;
  height: 32px;
  align-items: center;
  gap: 7px;
  border: 0;
  border-radius: 7px;
  background: none;
  padding: 0 8px 0 50px;
  color: #59616f;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background .13s var(--bd-ease), color .13s var(--bd-ease);
}
.bd-item:hover { background: var(--bd-surface-2); color: var(--bd-text); }
.bd-item.on { background: var(--bd-brand-soft); color: var(--bd-brand-strong); font-weight: 600; }
.bd-item.on::before {
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 0;
  width: 2px;
  border-radius: 2px;
  background: var(--bd-brand);
  content: "";
}
.bd-item .lb { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-wtag {
  flex: none;
  border: 1px solid currentColor;
  border-radius: 3px;
  padding: 2px 4px;
  color: var(--bd-amber);
  font-size: 12px;
  line-height: 1;
  opacity: .85;
}

.bd-side-empty {
  padding: 16px 10px;
  color: var(--bd-dim);
  font-size: 12px;
  line-height: 1.8;
  text-align: center;
}
.bd-side-empty button {
  margin-top: 6px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--bd-brand-strong);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
}

.bd-side-foot {
  display: flex;
  flex: none;
  gap: 4px;
  border-top: 1px solid var(--bd-line);
  padding: 8px 10px;
}
.bd-side-foot > * {
  display: flex;
  height: 32px;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 7px;
  background: none;
  color: var(--bd-dim);
  font-size: 12px;
  text-decoration: none;
  cursor: pointer;
  transition: background .13s var(--bd-ease), color .13s var(--bd-ease);
}
.bd-side-foot > *:hover { background: var(--bd-surface-2); color: var(--bd-text); }
.bd-side-foot :deep(.el-icon) { font-size: 14px; }

/* ── 工作区：独立滚动 ─────────────────────────────────── */
.bd-work {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
}
.bd-work::-webkit-scrollbar { width: 10px; }
.bd-work::-webkit-scrollbar-thumb { border-radius: 5px; background: #d8dde5; }
.bd-in { max-width: 1220px; margin: 0 auto; padding: 20px 28px 52px; }

/* ── 通用排版件 ───────────────────────────────────────── */
.bd-crumb {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
  color: var(--bd-faint);
  font-size: 12px;
}
.bd-crumb b { color: var(--bd-text-2); font-weight: 500; }

.bd-pageh { display: flex; align-items: flex-end; gap: 14px; margin-bottom: 18px; }
.bd-pageh h1 {
  margin: 0;
  color: var(--bd-text);
  font-size: 22px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: -.015em;
}
.bd-pageh p { margin: 5px 0 0; color: var(--bd-dim); font-size: 14px; }
.bd-pageh .ph-r {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding-bottom: 2px;
}
.bd-pageh .ph-r > * { white-space: nowrap; }

.bd-sec-h { display: flex; align-items: center; gap: 10px; margin: 22px 0 11px; }
.bd-sec-h:first-child { margin-top: 0; }
.bd-sec-h h2 { margin: 0; color: var(--bd-text-2); font-size: 14px; font-weight: 700; }
.bd-sec-h .sub { color: var(--bd-faint); font: 400 12px/1 Consolas, monospace; }
.bd-sec-h .more {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  border: 0;
  background: none;
  padding: 0;
  color: var(--bd-brand-strong);
  font-size: 12px;
  cursor: pointer;
}
.bd-sec-h .more:hover { text-decoration: underline; }
.bd-sec-h .more :deep(.el-icon) { font-size: 12px; }

.bd-card {
  border: 1px solid var(--bd-line);
  border-radius: var(--bd-radius);
  background: var(--bd-surface);
  box-shadow: var(--bd-sh1);
  overflow: hidden;
}
.bd-muted { color: var(--bd-dim); font-size: 12px; }

/* ── 按钮（外壳与概览页用，面板内仍是 Element Plus） ────── */
.bd-btn {
  display: inline-flex;
  height: 36px;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--bd-line-strong);
  border-radius: var(--bd-radius-sm);
  background: #fff;
  padding: 0 14px;
  color: var(--bd-text-2);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--bd-ease), border-color .14s var(--bd-ease), color .14s var(--bd-ease);
}
.bd-btn:hover { border-color: #cbd2dd; background: var(--bd-surface-2); color: var(--bd-text); }
.bd-btn.primary {
  border-color: var(--bd-brand-btn);
  background: var(--bd-brand-btn);
  color: #fff;
  box-shadow: 0 8px 18px -12px rgba(201, 65, 107, .95);
}
.bd-btn.primary:hover { border-color: var(--bd-brand-btn-h); background: var(--bd-brand-btn-h); color: #fff; }
.bd-btn.lg { height: 38px; padding: 0 18px; }
.bd-btn.is-sm { height: 30px; padding: 0 10px; font-size: 12px; }
.bd-btn:disabled { opacity: .5; cursor: not-allowed; }
.bd-btn :deep(.el-icon) { font-size: 14px; }
.bd-icon-btn {
  display: inline-flex;
  width: 36px;
  height: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bd-line-strong);
  border-radius: var(--bd-radius-sm);
  background: #fff;
  color: var(--bd-text-2);
  cursor: pointer;
  transition: background .14s var(--bd-ease), border-color .14s var(--bd-ease), color .14s var(--bd-ease);
}
.bd-icon-btn:hover { border-color: #cbd2dd; background: var(--bd-surface-2); color: var(--bd-text); }
.bd-icon-btn :deep(.el-icon) { font-size: 14px; }

/* ── 概览：KPI 四格 ───────────────────────────────────── */
.bd-kpi-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.bd-kpi {
  display: block;
  border: 1px solid var(--bd-line);
  border-radius: var(--bd-radius);
  background: var(--bd-surface);
  box-shadow: var(--bd-sh1);
  padding: 14px 16px 15px;
  text-align: left;
}
.bd-kpi.is-action { cursor: pointer; transition: border-color .14s var(--bd-ease), background .14s var(--bd-ease); }
.bd-kpi.is-action:hover { border-color: var(--bd-brand-line); background: #fffafb; }
.bd-kpi .k { display: flex; align-items: center; gap: 6px; color: var(--bd-dim); font-size: 12px; }
.bd-kpi .k :deep(.el-icon) { color: var(--bd-faint); font-size: 14px; }
.bd-kpi .v {
  display: flex;
  align-items: baseline;
  gap: 4px;
  margin-top: 6px;
  color: var(--bd-text);
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
  line-height: 1.15;
}
.bd-kpi .v small { color: var(--bd-faint); font-size: 12px; font-weight: 500; letter-spacing: 0; }
/* 没有数据的指标用浅色破折号，别让 26px 的黑横线看着像分割线 */
.bd-kpi .v .na { color: #cdd3dc; }
.bd-kpi .bar { height: 5px; margin-top: 9px; border-radius: 3px; background: var(--bd-surface-3); overflow: hidden; }
.bd-kpi .bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #e86b92, var(--bd-brand)); }
.bd-kpi .foot { margin-top: 7px; color: var(--bd-faint); font-size: 12px; line-height: 1.55; }

/* ── 概览：左栏 / 右栏 ────────────────────────────────── */
.bd-home-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

/* 她今天看了什么 */
.bd-wrow {
  display: flex;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid var(--bd-line);
  padding: 11px 14px;
  cursor: pointer;
  transition: background .13s var(--bd-ease);
}
.bd-wrow:last-child { border-bottom: 0; }
.bd-wrow:hover { background: var(--bd-surface-2); }
.bd-mcover {
  position: relative;
  display: grid;
  width: 76px;
  height: 44px;
  flex: none;
  place-items: center;
  overflow: hidden;
  border-radius: 5px;
  background: linear-gradient(135deg, var(--c1, #cfd8e6), var(--c2, #8ea4c4));
  color: rgba(255, 255, 255, .96);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -.02em;
}
.bd-mcover::after {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 90% at 18% 8%, rgba(255, 255, 255, .4), transparent 62%);
  content: "";
}
.bd-mcover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.bd-mcover span { position: relative; z-index: 1; }
.bd-wb { min-width: 0; flex: 1; }
.bd-wb .wt {
  overflow: hidden;
  color: var(--bd-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bd-wb .wm { display: flex; align-items: center; gap: 7px; margin-top: 3px; color: var(--bd-faint); font-size: 12px; }
.bd-wb .wm .sep { width: 2px; height: 2px; flex: none; border-radius: 50%; background: #cbd1db; }
.bd-wrow > :deep(.el-icon.arw) { flex: none; color: #cbd1db; font-size: 14px; }

.bd-badge {
  display: inline-flex;
  height: 18px;
  align-items: center;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.bd-badge.ok { background: #e8f6f0; color: var(--bd-green); }
.bd-badge.mute { background: var(--bd-surface-3); color: var(--bd-dim); }
.bd-seen-time { flex: none; color: var(--bd-faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.bd-mono { color: var(--bd-faint); font-family: Consolas, monospace; font-size: 12px; }
.bd-reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 今日报告 */
.bd-report { border-bottom: 1px solid var(--bd-line); padding: 14px 16px; }
.bd-report:last-child { border-bottom: 0; }
.bd-rm { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; color: var(--bd-faint); font-size: 12px; }
.bd-rm.is-head { margin-bottom: 9px; padding-bottom: 9px; border-bottom: 1px dashed var(--bd-line); }
.bd-rm b { color: var(--bd-text-2); font-weight: 600; }
.bd-picks { display: flex; flex-direction: column; gap: 6px; }
.bd-pick { display: flex; align-items: flex-start; gap: 8px; font-size: 14px; line-height: 1.6; color: var(--bd-text-2); }
.bd-pick code {
  flex: none;
  border-radius: 4px;
  background: var(--bd-brand-soft);
  padding: 1px 5px;
  color: var(--bd-brand-strong);
  font-family: Consolas, monospace;
  font-size: 12px;
}
.bd-report .bd-muted { margin: 0; font-size: 14px; color: var(--bd-dim); line-height: 1.8; }

/* 快速开始 */
.bd-qlist { padding: 5px; }
.bd-qirow {
  display: flex;
  width: 100%;
  min-height: 40px;
  align-items: center;
  gap: 10px;
  border: 0;
  border-radius: 7px;
  background: none;
  padding: 7px 9px;
  text-align: left;
  cursor: pointer;
  transition: background .13s var(--bd-ease);
}
.bd-qirow:hover { background: var(--bd-surface-2); }
.bd-qirow:disabled { opacity: .55; cursor: not-allowed; }
.bd-qirow .qic {
  display: grid;
  width: 26px;
  height: 26px;
  flex: none;
  place-items: center;
  border-radius: 6px;
  background: var(--bd-brand-soft);
  color: var(--bd-brand);
}
.bd-qirow .qic :deep(.el-icon) { font-size: 14px; }
.bd-qirow .qn { flex: 1; color: var(--bd-text-2); font-size: 14px; line-height: 1.35; }
.bd-qdesc { display: block; margin-top: 3px; color: var(--bd-faint); font-size: 12px; font-style: normal; line-height: 1.4; }
.bd-qirow .qc { color: var(--bd-faint); font-family: Consolas, monospace; font-size: 12px; }
.bd-qirow :deep(.el-icon.arw) { flex: none; color: #cbd1db; font-size: 12px; opacity: 0; transition: opacity .13s var(--bd-ease); }
.bd-qirow:hover :deep(.el-icon.arw) { opacity: 1; }

/* 最近运行 */
.bd-rrow {
  display: flex;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid var(--bd-line);
  padding: 11px 14px;
  cursor: pointer;
  transition: background .13s var(--bd-ease);
}
.bd-rrow:last-child { border-bottom: 0; }
.bd-rrow:hover { background: var(--bd-surface-2); }
.bd-rrow .rdot { width: 7px; height: 7px; flex: none; border-radius: 50%; }
.bd-rrow .rdot.ok { background: var(--bd-green); }
.bd-rrow .rdot.err { background: var(--bd-red); }
.bd-rrow .rmain { min-width: 0; flex: 1; }
.bd-rrow .rc {
  overflow: hidden;
  color: var(--bd-text);
  font-family: Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bd-rrow .rs { overflow: hidden; margin-top: 2px; color: var(--bd-dim); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.bd-rrow .rt { flex: none; color: var(--bd-faint); font-size: 12px; font-variant-numeric: tabular-nums; }

/* 空状态（卡片内） */
.bd-empty-mini {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 30px 16px;
  color: var(--bd-faint);
  font-size: 12px;
  line-height: 1.7;
  text-align: center;
}
.bd-empty-mini :deep(.el-icon) { color: #cdd3dc; font-size: 22px; }
.bd-empty-mini span:first-of-type { color: var(--bd-text-2); font-size: 14px; font-weight: 600; }

/* 账号与角色 */
.bd-accounts { padding: 4px 0; }
.bd-account { border-bottom: 1px solid var(--bd-line); padding: 12px 16px; }
.bd-account:last-child { border-bottom: 0; }
.bd-account-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.bd-account-name { color: var(--bd-text); font-size: 14px; font-weight: 700; }
.bd-account-meta { flex: 1; min-width: 0; color: var(--bd-dim); font-size: 12px; overflow-wrap: anywhere; }
.bd-account-empty { margin-top: 8px; color: var(--bd-dim); font-size: 12px; line-height: 1.7; }
.bd-account-empty a { color: var(--bd-brand-strong); font-weight: 700; }
.bd-binding {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-top: 8px;
  border-radius: var(--bd-radius-sm);
  background: var(--bd-surface-2);
  padding: 8px 10px;
}
.bd-binding-role { color: var(--bd-text-2); font-size: 12px; font-weight: 700; }
.bd-binding-stat { color: var(--bd-dim); font-size: 12px; }

/* ── 运行记录：筛选 chip ──────────────────────────────── */
.bd-filters { display: flex; align-items: center; gap: 6px; margin: 2px 0 14px; }
.bd-chip {
  display: inline-flex;
  height: 30px;
  align-items: center;
  border: 1px solid var(--bd-line);
  border-radius: 999px;
  background: var(--bd-surface);
  padding: 0 12px;
  color: var(--bd-text-2);
  font-size: 12px;
  cursor: pointer;
  transition: all .14s var(--bd-ease);
}
.bd-chip:hover { border-color: var(--bd-line-strong); background: var(--bd-surface-2); }
.bd-chip.on { border-color: var(--bd-text); background: var(--bd-text); color: #fff; font-weight: 600; }
.bd-chip .n { margin-left: 4px; font-size: 12px; font-variant-numeric: tabular-nums; opacity: .65; }
.bd-chip.on .n { opacity: .8; }

/* ── 命令台 ───────────────────────────────────────────── */
.bd-cmd-h { display: flex; align-items: flex-start; gap: 12px; margin: 10px 0 14px; }
.bd-cmd-h .cmd-ic {
  display: grid;
  width: 38px;
  height: 38px;
  flex: none;
  place-items: center;
  border-radius: var(--bd-radius-sm);
  background: var(--bd-brand-soft);
  color: var(--bd-brand);
}
.bd-cmd-h .cmd-ic :deep(.el-icon) { font-size: 18px; }
.bd-cmd-h .hm { min-width: 0; flex: 1; }
.bd-cmd-h .cmd-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--bd-text);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -.015em;
}
.bd-cmd-h .cmd-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; margin-top: 4px; color: var(--bd-dim); font-size: 12px; }
.bd-cmd-h .cmd-sub code { color: var(--bd-text-2); font-family: Consolas, monospace; font-size: 12px; }
.bd-cmd-h .ph-r { margin-left: auto; display: flex; gap: 8px; }
.bd-tag-w {
  border: 1px solid var(--bd-amber);
  border-radius: 3px;
  padding: 2px 5px;
  color: var(--bd-amber);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  opacity: .9;
}

.bd-panel { border: 1px solid var(--bd-line); border-radius: var(--bd-radius); background: var(--bd-surface); box-shadow: var(--bd-sh1); }
.bd-panel-body { padding: 16px 16px 4px; }
.bd-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px 16px; }
.bd-fld { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
.bd-fld.wide { grid-column: 1 / -1; }
.bd-fld .fl { display: flex; align-items: center; gap: 3px; color: var(--bd-dim); font-size: 12px; font-weight: 500; }
.bd-fld .fl i { color: var(--bd-brand); font-style: normal; }
.bd-fld :deep(.el-input__wrapper),
.bd-fld :deep(.el-select__wrapper) { border-radius: var(--bd-radius-xs, 6px); box-shadow: 0 0 0 1px var(--bd-line-strong) inset; }
.bd-fld :deep(.el-input__inner),
.bd-fld :deep(.el-select__placeholder) { font-size: 14px; }
.bd-fld :deep(.el-switch) { height: 26px; }

.bd-runbar {
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid var(--bd-line);
  margin-top: 4px;
  padding: 10px 16px;
}
.bd-runbar .ri { flex: none; color: var(--bd-faint); font-size: 14px; }
.bd-runbar code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  border-radius: 6px;
  background: var(--bd-surface-2);
  padding: 6px 9px;
  color: var(--bd-text-2);
  font-family: Consolas, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bd-runbar .dry { flex: none; color: var(--bd-amber); font-size: 12px; }
.bd-runbar :deep(.el-checkbox__label) { font-size: 12px; }

.bd-result-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; border-bottom: 1px solid var(--bd-line); padding: 10px 16px; }
.bd-result-head code { color: var(--bd-text-2); font-family: Consolas, monospace; font-size: 12px; }
.bd-result-tag { margin-left: auto; }
.bd-result-tag.ok { color: var(--bd-green); font-size: 12px; font-weight: 600; }
.bd-result-tag.err { color: var(--bd-red); font-size: 12px; font-weight: 600; }
.bd-code {
  max-height: 460px;
  margin: 0;
  padding: 15px 17px;
  overflow: auto;
  color: #33404f;
  font-family: Consolas, monospace;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 空状态（整页） ───────────────────────────────────── */
.bd-empty-block {
  display: flex;
  min-height: 320px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--bd-line-strong);
  border-radius: var(--bd-radius);
  background: var(--bd-surface);
  padding: 44px 24px;
  text-align: center;
}
.bd-empty-block .halo {
  display: grid;
  width: 52px;
  height: 52px;
  place-items: center;
  margin-bottom: 16px;
  border-radius: 14px;
  background: var(--bd-grad-brand);
  box-shadow: 0 14px 30px -16px rgba(217, 74, 118, .75);
  color: #fff;
}
.bd-empty-block h4 { margin: 0 0 7px; color: var(--bd-text); font-size: 16px; font-weight: 700; }
.bd-empty-block p { max-width: 460px; margin: 0; color: var(--bd-dim); font-size: 14px; line-height: 1.8; }
.bd-empty-block .bd-btn { margin-top: 16px; }
.bd-empty-block.is-compact { min-height: 220px; padding: 32px 24px; }

/* 骨架屏 */
.bd-sk {
  border-radius: 5px;
  background: linear-gradient(90deg, var(--bd-surface-3) 25%, #e9edf3 37%, var(--bd-surface-3) 63%);
  background-size: 400% 100%;
  animation: bd-shimmer 1.3s ease infinite;
}
@keyframes bd-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0 50%; }
}

/* ── 收起态：64px 图标栏 ─────────────────────────────── */
.bd.is-rail .bd-side { width: 64px; }
.bd.is-rail .bd-side-head { padding: 12px 8px 6px; }
.bd.is-rail .bd-side-head :deep(.el-input) { display: none; }
.bd.is-rail .bd-sec-label,
.bd.is-rail .bd-pin .pl,
.bd.is-rail .bd-pin-mark,
.bd.is-rail .bd-grp .grn,
.bd.is-rail .bd-grp .cnt,
.bd.is-rail .bd-grp :deep(.el-icon.chev),
.bd.is-rail .bd-items,
.bd.is-rail .bd-side-foot span,
.bd.is-rail .bd-nav-ov span { display: none; }
.bd.is-rail .bd-nav-ov,
.bd.is-rail .bd-pin,
.bd.is-rail .bd-grp { height: 36px; justify-content: center; gap: 0; padding: 0; }
.bd.is-rail .bd-side-foot { flex-direction: column; padding: 8px 6px; }
.bd.is-rail .bd-side-foot > * { flex: none; width: 100%; }

/* ── 弹窗 ─────────────────────────────────────────────── */
.bd-dialog-body { max-height: 58vh; overflow-y: auto; padding-right: 4px; }
.bd-login { display: flex; flex-direction: column; align-items: center; padding: 6px 0; }
.bd-login-qr { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.bd-login-qrimg { width: 220px; height: 220px; border: 1px solid var(--bd-line); border-radius: var(--bd-radius-sm); }
.bd-login-qrimg.expired { opacity: .4; filter: grayscale(1); }
.bd-login-empty {
  display: flex;
  width: 220px;
  height: 220px;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--bd-line-strong);
  border-radius: var(--bd-radius-sm);
  color: var(--bd-dim);
  font-size: 12px;
  text-align: center;
}
.bd-login-done { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 18px 0; }
.bd-login-check { color: var(--bd-green); font-size: 40px; }
.bd-login-done p { margin: 0; color: var(--bd-text-2); font-size: 14px; }

/* ── 管理菜单弹窗 ─────────────────────────────────────── */
.bd-menu-h { display: flex; align-items: baseline; gap: 8px; }
.bd-menu-h > span:first-child { color: var(--bd-text); font-size: 16px; font-weight: 700; }
.bd-menu-hsub { color: var(--bd-faint); font-size: 12px; }
.bd-menu-hint {
  margin: 0 0 12px;
  color: var(--bd-dim);
  font-size: 12px;
  line-height: 1.7;
  text-wrap: pretty;
}

.bd-menu-mgr { max-height: 56vh; overflow-y: auto; padding-right: 6px; }
/* 45+ 条命令，滚到底还能勾全选 */
.bd-menu-bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--bd-line);
  background: var(--bd-surface);
  padding: 4px 2px 10px;
}
.bd-menu-search { flex: 1; min-width: 120px; }
.bd-menu-cnt { flex: none; color: var(--bd-dim); font-size: 12px; white-space: nowrap; }

.bd-menu-grp { padding: 8px 2px; }
.bd-menu-grp + .bd-menu-grp { border-top: 1px dashed var(--bd-line); }
.bd-menu-grp-h { display: flex; align-items: center; gap: 8px; }
.bd-menu-grp-h b { color: var(--bd-text); font-size: 14px; }
.bd-menu-grp-h b.is-off { color: var(--bd-faint); }
.bd-menu-badge {
  border-radius: 4px;
  background: var(--bd-surface-3);
  padding: 2px 5px;
  color: var(--bd-faint);
  font: 12px/1 Consolas, monospace;
}

/* 每条命令一行：名称靠左、命令行靠右，两列对齐不挤 */
.bd-menu-items { display: flex; flex-direction: column; gap: 1px; padding: 6px 0 2px 24px; }
.bd-menu-items :deep(.el-checkbox.bd-menu-item) { width: 100%; height: 28px; margin-right: 0; }
.bd-menu-items :deep(.el-checkbox__label) {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding-left: 8px;
  color: var(--bd-text-2);
  font-size: 14px;
  line-height: 1.4;
}
.bd-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-menu-label.is-off { color: var(--bd-faint); }
.bd-menu-cmd {
  flex: 0 1 auto;
  max-width: 48%;
  overflow: hidden;
  color: var(--bd-faint);
  font: 12px/1 Consolas, monospace;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bd-menu-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 0; color: var(--bd-dim); }
.bd-menu-empty p { margin: 0; font-size: 12px; }

.bd-menu-foot { display: flex; align-items: center; gap: 8px; }
.bd-menu-foottip { margin-right: auto; color: var(--bd-faint); font-size: 12px; }

/* ── 自适应 ───────────────────────────────────────────── */
@media (max-width: 1280px) {
  .bd-home-cols { grid-template-columns: minmax(0, 1fr); }
  .bd-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  /* 标题与按钮挤在一行会把副标题压成两行，索性上下排 */
  .bd-pageh { flex-direction: column; align-items: stretch; }
  .bd-pageh .ph-r { margin-left: 0; }
}
@media (max-width: 1180px) {
  .bd-side { width: 64px; }
  .bd-in { padding: 18px 20px 44px; }
}
@media (max-width: 900px) {
  .bd { height: calc(100vh - 52px); }
  .bd-pageh { flex-direction: column; align-items: stretch; }
  .bd-pageh .ph-r { margin-left: 0; }
  .bd-fields { grid-template-columns: minmax(0, 1fr); }
  .bd-runbar { flex-wrap: wrap; }
}
@media (max-width: 640px) {
  .bd-kpi-row { grid-template-columns: minmax(0, 1fr); }
  .bd-in { padding: 16px 14px 36px; }
  .bd-pageh h1 { font-size: 18px; }
}
</style>
