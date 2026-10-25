<script setup lang="ts">
import { Refresh, VideoPlay, Clock, Tickets, Collection, ChatLineRound, Camera, Setting, Promotion } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type BiliReport = {
  id: string;
  roundIndex: number;
  pickedCount: number;
  content: string;
  createdAt: string;
};

type BiliSeen = {
  bvid: string;
  title: string;
  author: string;
  result: string;
  reason: string;
  seenAt: string;
};

type BiliBinding = {
  bindingId: string;
  characterId: string;
  characterName: string;
  pickedToday: number;
  remaining: number;
  perDay: number;
  reports: BiliReport[];
  seenToday: BiliSeen[];
};

type BiliAccount = {
  connectionId: string;
  displayName: string;
  dataHome: string;
  biliBin: string;
  duty: {
    perDay: number;
    peakValley: boolean;
    noon: boolean;
    night: boolean;
    keywords: string[];
    zone: string;
    frames: number;
    autoComment: boolean;
    commentPerRound: number;
    mentionName: string;
    dmMode: "only" | "both" | "off";
  };
  nextWindow: "noon" | "night" | null;
  bindings: BiliBinding[];
};

type DashboardData = {
  today: string;
  accounts: BiliAccount[];
};

const loading = ref(false);
const dashboard = ref<DashboardData>({ today: "", accounts: [] });

// ── B站扫码登录 ──────────────────────────────────────────
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
    // 二维码过期：停止轮询，提示重新生成
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

/** 封面缓存：bvid → pic URL，懒加载；失败回退渐变占位。 */
const coverCache = reactive<Record<string, string>>({});
const coverBroken = reactive<Record<string, boolean>>({});

const COVER_GRADIENTS = [
  ['#3f6091', '#21324d'],
  ['#5d3f86', '#382253'],
  ['#2f6b5e', '#1a3b34'],
  ['#8a5a2b', '#4a2e16'],
];

function coverStyle(index: number) {
  const [c1, c2] = COVER_GRADIENTS[index % COVER_GRADIENTS.length]!;
  return { background: `linear-gradient(135deg, ${c1}, ${c2})` };
}

async function resolveCover(bvid: string) {
  if (coverCache[bvid] || coverBroken[bvid]) return;
  try {
    const data = await $fetch<{ bvid: string; pic: string | null }>("/api/admin/bili/cover", {
      query: { bvid },
    });
    if (data.pic) {
      coverCache[bvid] = data.pic;
    } else {
      coverBroken[bvid] = true;
    }
  } catch {
    coverBroken[bvid] = true;
  }
}

function seenCover(bvid: string, index: number) {
  if (coverCache[bvid]) return {};
  const [c1, c2] = COVER_GRADIENTS[index % COVER_GRADIENTS.length]!;
  return { background: `linear-gradient(135deg, ${c1}, ${c2})` };
}

/** 页面数据加载后，为所有已看视频批量拉封面。 */
async function loadCovers() {
  const bvids = dashboard.value.accounts.flatMap((account) =>
    account.bindings.flatMap((binding) => binding.seenToday.map((v) => v.bvid)),
  );
  await Promise.all([...new Set(bvids)].map((bvid) => resolveCover(bvid)));
}

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

function windowLabel(window: "noon" | "night" | null) {
  if (window === "noon") return "中午 12-14 点";
  if (window === "night") return "夜间 18-次日 9 点";
  return "—";
}

function windowActiveLabel(account: BiliAccount) {
  return account.nextWindow ? `下次窗口 ${windowLabel(account.nextWindow)}` : "当前不在谷时窗口内";
}

/** 把报告正文里 "### BV号" 段落拆成「挑中的视频」列表。 */
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

async function loadDashboard() {
  loading.value = true;
  try {
    dashboard.value = await $fetch<DashboardData>("/api/admin/bili/dashboard");
    await loadCovers();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取 B站工作台数据。"));
  } finally {
    loading.value = false;
  }
}

// ── 值班设置 ──────────────────────────────────────────
const ZONES = ["all", "anime", "music", "dance", "game", "knowledge", "tech", "sports", "car", "life", "food", "animal", "kichiku", "fashion", "ent", "film", "original", "rookie"];

const dutyVisible = ref(false);
const dutySaving = ref(false);
const dutyTarget = ref<BiliAccount | null>(null);
const dutyForm = reactive({
  perDay: 5,
  peakValley: true,
  noon: true,
  night: true,
  keywordsText: "",
  zone: "all",
  frames: 0,
  dmMode: "only" as "only" | "both" | "off",
  autoComment: false,
  commentPerRound: 1,
  mentionName: "",
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
    const duty = {
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
    };
    await $fetch("/api/admin/bili/duty", {
      method: "PUT",
      body: { connectionId: dutyTarget.value.connectionId, duty },
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

// ── 现在跑一轮 ──────────────────────────────────────────
const running = ref<string | null>(null); // 正在跑的 bindingId

async function runNow(account: BiliAccount, binding: BiliBinding) {
  running.value = binding.bindingId;
  try {
    const result = await $fetch<{ ok: boolean; seconds: number; picked: number; skipped: number; error?: string }>("/api/admin/bili/run-round", {
      method: "POST",
      body: { connectionId: account.connectionId, bindingId: binding.bindingId },
    });
    if (result.ok) {
      ElMessage.success(`跑完了（${result.seconds}s），这轮挑中 ${result.picked} 条、跳过 ${result.skipped} 条。`);
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

onMounted(loadDashboard);
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / B站工作台"
      title="B站值班"
      description="把角色接到 B站 自动值班刷视频。这里汇总每天刷了几条、挑中了什么、还剩多少额度，替代 bili-desk 的「概览」页。"
    >
      <template #actions>
        <el-button
          type="primary"
          @click="loginVisible = true"
        >
          <el-icon><Camera /></el-icon>登录 B站
        </el-button>
        <el-button
          :loading="loading"
          @click="loadDashboard"
        >
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </template>
    </PageHeader>

    <div
      v-if="!dashboard.accounts.length"
      class="info-callout"
      style="margin-bottom:20px"
    >
      <el-icon><VideoPlay /></el-icon>
      <span>还没有 B站 账号。请先在「渠道管理 → 添加渠道 → B站」创建连接并绑定角色，值班跑一轮后这里就会有数据。</span>
    </div>

    <div
      v-loading="loading"
      class="bili-dashboard"
    >
      <section
        v-for="account in dashboard.accounts"
        :key="account.connectionId"
        class="bili-account"
      >
        <div class="bili-account-head">
          <div>
            <h2 class="bili-account-name">{{ account.displayName }}</h2>
            <p class="bili-account-meta">
              数据目录 {{ account.dataHome || '（默认）' }} · 每天上限 {{ account.duty.perDay }} 条
            </p>
          </div>
          <div class="bili-account-actions">
            <el-tag
              :type="account.nextWindow ? 'warning' : 'info'"
              effect="light"
              size="small"
            >
              {{ windowActiveLabel(account) }}
            </el-tag>
            <el-button
              size="small"
              @click="openDutySettings(account)"
            >
              <el-icon><Setting /></el-icon>值班设置
            </el-button>
          </div>
        </div>

        <div
          v-for="binding in account.bindings"
          :key="binding.bindingId"
          class="bili-binding"
        >
          <div class="metric-row" style="margin-bottom:14px">
            <span class="bili-binding-role">角色：{{ binding.characterName }}</span>
            <el-button
              type="primary"
              size="small"
              :loading="running === binding.bindingId"
              @click="runNow(account, binding)"
            >
              <el-icon><Promotion /></el-icon>{{ running === binding.bindingId ? '跑一轮中…' : '现在跑一轮' }}
            </el-button>
          </div>

          <!-- 概览卡片 -->
          <div class="bili-cards">
            <div class="bili-card">
              <div class="bili-card-icon bili-card-icon-blue"><el-icon><Collection /></el-icon></div>
              <div class="bili-card-body">
                <div class="bili-card-value">{{ binding.pickedToday }} <span class="bili-card-unit">/ {{ binding.perDay }} 条</span></div>
                <div class="bili-card-label">今日已刷</div>
              </div>
            </div>
            <div class="bili-card">
              <div class="bili-card-icon bili-card-icon-green"><el-icon><Tickets /></el-icon></div>
              <div class="bili-card-body">
                <div class="bili-card-value">{{ binding.remaining }} <span class="bili-card-unit">条</span></div>
                <div class="bili-card-label">剩余额度</div>
              </div>
            </div>
            <div class="bili-card">
              <div class="bili-card-icon bili-card-icon-amber"><el-icon><Clock /></el-icon></div>
              <div class="bili-card-body">
                <div class="bili-card-value">{{ binding.reports.length }} <span class="bili-card-unit">轮</span></div>
                <div class="bili-card-label">今日报告</div>
              </div>
            </div>
            <div class="bili-card">
              <div class="bili-card-icon bili-card-icon-rose"><el-icon><VideoPlay /></el-icon></div>
              <div class="bili-card-body">
                <div class="bili-card-value">{{ binding.seenToday.length }} <span class="bili-card-unit">条</span></div>
                <div class="bili-card-label">看过视频</div>
              </div>
            </div>
          </div>

          <!-- 今日报告 + 挑中的视频 -->
          <div class="bili-section">
            <h3 class="bili-section-title">
              <el-icon><ChatLineRound /></el-icon>今日报告
            </h3>
            <div
              v-if="!binding.reports.length"
              class="bili-empty"
            >
              今天还没跑过值班。等谷时窗口到了（或手动跑一轮）后，这里会自动写好当日小结。
            </div>
            <div
              v-for="report in binding.reports"
              :key="report.id"
              class="bili-report"
            >
              <div class="bili-report-meta">
                <span>第 {{ report.roundIndex }} 轮</span>
                <span class="bili-report-time">{{ formatTime(report.createdAt) }}</span>
                <span class="bili-report-count">挑中 {{ report.pickedCount }} 条</span>
              </div>
              <div
                v-if="report.pickedCount > 0"
                class="bili-picked-list"
              >
                <div
                  v-for="video in parsePickedVideos(report.content)"
                  :key="video.bvid"
                  class="bili-picked-item"
                >
                  <span class="bili-picked-bvid">{{ video.bvid }}</span>
                  <span class="bili-picked-text">{{ video.text || '（无标题）' }}</span>
                </div>
              </div>
              <div
                v-else
                class="bili-empty"
              >
                这一轮没有挑中的视频。
              </div>
            </div>
          </div>

          <!-- 她今天看了什么 -->
          <div class="bili-section">
            <h3 class="bili-section-title">
              <el-icon><VideoPlay /></el-icon>她今天看了什么
            </h3>
            <div
              v-if="!binding.seenToday.length"
              class="bili-empty"
            >
              今天还没有看过任何视频。
            </div>
            <div
              v-for="(video, idx) in binding.seenToday"
              :key="video.bvid"
              class="bili-seen-item"
            >
              <div
                class="bili-seen-cover"
                :style="seenCover(video.bvid, idx)"
              >
                <img
                  v-if="coverCache[video.bvid]"
                  :src="coverCache[video.bvid]"
                  alt=""
                  loading="lazy"
                  referrerpolicy="no-referrer"
                  @error="coverBroken[video.bvid] = true; delete coverCache[video.bvid]"
                />
                <span v-else>{{ (video.title || video.bvid).slice(0, 3) }}</span>
              </div>
              <el-tag
                :type="video.result === 'picked' ? 'success' : 'info'"
                effect="plain"
                size="small"
              >
                {{ video.result === 'picked' ? '挑中' : '跳过' }}
              </el-tag>
              <div class="bili-seen-info">
                <div class="bili-seen-title">{{ video.title || '（无标题）' }}</div>
                <div class="bili-seen-meta">
                  {{ video.bvid }} · {{ video.author || '未知 UP' }} · {{ video.reason || '' }}
                </div>
              </div>
              <span class="bili-seen-time">{{ formatTime(video.seenAt) }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>

    <el-dialog
      v-model="loginVisible"
      title="登录 B站"
      width="420px"
      :close-on-click-modal="false"
      @close="closeLogin"
    >
      <div class="bili-login">
        <template v-if="loginStatus === 'done'">
          <div class="bili-login-done">
            <el-icon class="bili-login-check"><ChatLineRound /></el-icon>
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
          <div class="bili-login-done">
            <p>登录失败，请确认 bili CLI 已安装并能访问网络。</p>
            <el-button @click="startLogin">
              重试
            </el-button>
          </div>
        </template>
        <template v-else>
          <div
            v-loading="loginLoading"
            class="bili-login-qr"
          >
            <img
              v-if="qrDataUrl"
              :src="qrDataUrl"
              alt="B站登录二维码"
              class="bili-login-qrimg"
              :class="{ 'bili-login-qrimg-expired': loginStatus === 'expired' }"
            />
            <div
              v-else
              class="bili-login-empty"
            >
              点击「生成二维码」开始登录
            </div>
            <p class="bili-login-hint">
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

    <el-dialog
      v-model="dutyVisible"
      title="值班设置"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form label-position="top">
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="每天最多挑几条（0-50）">
              <el-input-number
                v-model="dutyForm.perDay"
                :min="0"
                :max="50"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>

          <el-col :xs="24" :sm="12">
            <el-form-item label="峰谷时段自动刷">
              <el-switch v-model="dutyForm.peakValley" />
            </el-form-item>
          </el-col>

          <el-col :xs="24" :sm="12">
            <el-form-item label="中午窗口 12:00–14:00">
              <el-switch
                v-model="dutyForm.noon"
                :disabled="!dutyForm.peakValley"
              />
            </el-form-item>
          </el-col>

          <el-col :xs="24" :sm="12">
            <el-form-item label="夜间窗口 18:00–09:00">
              <el-switch
                v-model="dutyForm.night"
                :disabled="!dutyForm.peakValley"
              />
            </el-form-item>
          </el-col>

          <el-col :xs="24" :sm="12">
            <el-form-item label="投递方式">
              <el-radio-group v-model="dutyForm.dmMode">
                <el-radio-button value="only">只私信</el-radio-button>
                <el-radio-button value="both">私信 + 评论</el-radio-button>
                <el-radio-button value="off">都不发</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>

          <el-col :xs="24" :sm="12">
            <el-form-item label="热门分区">
              <el-select
                v-model="dutyForm.zone"
                style="width: 100%"
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

          <el-col :xs="24" :sm="12">
            <el-form-item label="每条视频抽几帧（0 = 不抽）">
              <el-input-number
                v-model="dutyForm.frames"
                :min="0"
                :max="30"
                controls-position="right"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>

          <el-col :xs="24" :sm="12">
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
                style="width: 100%"
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
        style="margin-bottom: 8px"
        title="公开评论会以该 B站 账号的身份真的发出去。"
      />

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
  </div>
</template>

<style scoped>
.bili-dashboard {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.bili-account {
  background: var(--surface, #fff);
  border: 1px solid var(--border, #eef0f3);
  border-radius: 12px;
  padding: 20px;
}
.bili-account-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}
.bili-account-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.bili-account-name {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 4px;
}
.bili-account-meta {
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
  margin: 0;
}
.bili-binding {
  border-top: 1px dashed var(--border, #eef0f3);
  padding-top: 16px;
  margin-top: 4px;
}
.bili-binding-role {
  font-size: 13px;
  color: var(--text-secondary, #8a919f);
}
.bili-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}
.bili-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border, #eef0f3);
  border-radius: 10px;
  background: var(--surface-subtle, #fafbfc);
}
.bili-card-icon {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.bili-card-icon-blue { background: #eef4ff; color: #3b82f6; }
.bili-card-icon-green { background: #e9f9ef; color: #22c55e; }
.bili-card-icon-amber { background: #fff5e6; color: #f59e0b; }
.bili-card-icon-rose { background: #ffeef0; color: #f43f5e; }
.bili-card-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}
.bili-card-unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #8a919f);
}
.bili-card-label {
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
  margin-top: 2px;
}
.bili-section {
  margin-top: 20px;
}
.bili-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.bili-empty {
  font-size: 13px;
  color: var(--text-secondary, #8a919f);
  padding: 16px;
  background: var(--surface-subtle, #fafbfc);
  border-radius: 8px;
}
.bili-report {
  border: 1px solid var(--border, #eef0f3);
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 12px;
}
.bili-report-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
  margin-bottom: 10px;
}
.bili-report-count {
  font-weight: 600;
  color: var(--text-primary, #1f2329);
}
.bili-picked-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bili-picked-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
}
.bili-picked-bvid {
  flex-shrink: 0;
  font-family: monospace;
  font-size: 12px;
  color: #3b82f6;
  background: #eef4ff;
  padding: 2px 6px;
  border-radius: 4px;
}
.bili-picked-text {
  line-height: 1.5;
}
.bili-seen-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border, #eef0f3);
}
.bili-seen-cover {
  flex-shrink: 0;
  width: 56px;
  height: 42px;
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
}
.bili-seen-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.bili-seen-item:last-child {
  border-bottom: none;
}
.bili-seen-info {
  flex: 1;
  min-width: 0;
}
.bili-seen-title {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bili-seen-meta {
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
  margin-top: 2px;
}
.bili-seen-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary, #8a919f);
}
@media (max-width: 768px) {
  .bili-cards {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 扫码登录 */
.bili-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 10px 0;
}
.bili-login-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.bili-login-qrimg {
  width: 220px;
  height: 220px;
  border: 1px solid var(--border, #eef0f3);
  border-radius: 8px;
}
.bili-login-qrimg-expired {
  opacity: 0.4;
  filter: grayscale(1);
}
.bili-login-empty {
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary, #8a919f);
  font-size: 13px;
  border: 1px dashed var(--border, #eef0f3);
  border-radius: 8px;
}
.bili-login-hint {
  font-size: 13px;
  color: var(--text-secondary, #8a919f);
  margin: 0;
}
.bili-login-done {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 20px 0;
}
.bili-login-check {
  font-size: 48px;
  color: #22c55e;
}
.bili-login-done p {
  margin: 0;
  font-size: 14px;
}
</style>
