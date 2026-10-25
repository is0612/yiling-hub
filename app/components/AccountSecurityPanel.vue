<script setup lang="ts">
import { Monitor, Refresh, SwitchButton, Unlock } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { FormInstance, FormRules } from "element-plus";

type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

type AuthSessionRow = {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  device: { label: string; kind: DeviceKind };
};

const sessions = ref<AuthSessionRow[]>([]);
const sessionMode = ref<"session" | "local-dev">("session");
const loadingSessions = ref(false);
const revokingId = ref("");
const revokingOthers = ref(false);

const formRef = ref<FormInstance>();
const changingPassword = ref(false);
const passwordForm = reactive({ current: "", next: "", confirm: "" });

const passwordRules: FormRules = {
  current: [{ required: true, message: "请输入当前密码", trigger: "blur" }],
  next: [
    { required: true, message: "请输入新密码", trigger: "blur" },
    { min: 10, max: 128, message: "新密码长度需为 10 至 128 个字符", trigger: "blur" },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (!value) return callback();
        if (!/[A-Za-z]/.test(value)) return callback(new Error("新密码必须包含至少一个字母"));
        if (!/[0-9]/.test(value)) return callback(new Error("新密码必须包含至少一个数字"));
        return callback();
      },
      trigger: "blur",
    },
  ],
  confirm: [
    { required: true, message: "请再次输入新密码", trigger: "blur" },
    {
      validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
        if (value !== passwordForm.next) return callback(new Error("两次输入的新密码不一致"));
        return callback();
      },
      trigger: "blur",
    },
  ],
};

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const otherSessionCount = computed(() => sessions.value.filter((session) => !session.current).length);

async function loadSessions() {
  loadingSessions.value = true;
  try {
    const response = await $fetch<{ mode: "session" | "local-dev"; sessions: AuthSessionRow[] }>("/api/auth/sessions");
    sessions.value = response.sessions;
    sessionMode.value = response.mode;
  } catch (error) {
    sessions.value = [];
    ElMessage.error(readErrorMessage(error, "无法读取登录设备列表。"));
  } finally {
    loadingSessions.value = false;
  }
}

async function submitPasswordChange() {
  if (changingPassword.value) return;
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  changingPassword.value = true;
  try {
    const result = await $fetch<{ changed: boolean; revokedSessions: number }>("/api/auth/password", {
      method: "POST",
      body: { currentPassword: passwordForm.current, newPassword: passwordForm.next },
    });
    passwordForm.current = "";
    passwordForm.next = "";
    passwordForm.confirm = "";
    formRef.value?.clearValidate();
    ElMessage.success(
      result.revokedSessions > 0
        ? `密码已更新，同时退出了另外 ${result.revokedSessions} 个登录设备。`
        : "密码已更新。",
    );
    await loadSessions();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "密码修改失败，请稍后重试。"));
  } finally {
    changingPassword.value = false;
  }
}

async function revokeSession(session: AuthSessionRow) {
  if (revokingId.value) return;
  const confirmed = await ElMessageBox.confirm(
    session.current ? "撤销当前会话会立即退出登录，确定继续？" : `确定要让「${session.device.label}」退出登录吗？`,
    "撤销登录设备",
    { confirmButtonText: "撤销", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  revokingId.value = session.id;
  try {
    const result = await $fetch<{ revoked: boolean; currentRevoked: boolean }>(
      `/api/auth/sessions/${encodeURIComponent(session.id)}`,
      { method: "DELETE" },
    );
    if (result.currentRevoked) {
      await navigateTo("/login");
      return;
    }
    ElMessage.success("该设备已退出登录。");
    await loadSessions();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "撤销失败，请稍后重试。"));
  } finally {
    revokingId.value = "";
  }
}

async function revokeOtherSessions() {
  if (revokingOthers.value) return;
  const confirmed = await ElMessageBox.confirm(
    "除当前设备外，所有已登录设备都会立即退出，确定继续？",
    "退出其他设备",
    { confirmButtonText: "全部退出", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  revokingOthers.value = true;
  try {
    const result = await $fetch<{ revoked: number }>("/api/auth/sessions/revoke-others", { method: "POST" });
    ElMessage.success(result.revoked > 0 ? `已退出 ${result.revoked} 个设备。` : "没有其他在线设备。");
    await loadSessions();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "操作失败，请稍后重试。"));
  } finally {
    revokingOthers.value = false;
  }
}

onMounted(loadSessions);
</script>

<template>
  <section class="surface form-section">
    <div class="form-title">
      <el-icon class="security-icon">
        <Unlock />
      </el-icon>账户与安全
    </div>

    <el-form
      ref="formRef"
      :model="passwordForm"
      :rules="passwordRules"
      label-position="top"
      @submit.prevent="submitPasswordChange"
    >
      <div class="password-grid">
        <el-form-item
          label="当前密码"
          prop="current"
        >
          <el-input
            v-model="passwordForm.current"
            type="password"
            show-password
            autocomplete="current-password"
            placeholder="请输入当前密码"
          />
        </el-form-item>
        <el-form-item
          label="新密码"
          prop="next"
        >
          <el-input
            v-model="passwordForm.next"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="至少 10 位，含字母与数字"
          />
        </el-form-item>
        <el-form-item
          label="确认新密码"
          prop="confirm"
        >
          <el-input
            v-model="passwordForm.confirm"
            type="password"
            show-password
            autocomplete="new-password"
            placeholder="再次输入新密码"
            @keyup.enter="submitPasswordChange"
          />
        </el-form-item>
      </div>
      <p class="form-help">
        修改密码后，其他所有登录设备会被立即注销，当前设备保持登录。
      </p>
      <div class="form-actions">
        <el-button
          type="primary"
          :loading="changingPassword"
          @click="submitPasswordChange"
        >
          更新密码
        </el-button>
      </div>
    </el-form>

    <el-divider />

    <div class="device-head">
      <div>
        <div class="device-title">
          <el-icon><Monitor /></el-icon>登录设备
        </div>
        <p class="form-help">
          {{ sessionMode === "local-dev"
            ? "当前是本地开发身份，这里只列出真实登录产生的会话。"
            : "只显示仍然有效的会话；撤销后该设备需要重新登录。" }}
        </p>
      </div>
      <div class="device-actions">
        <el-button
          text
          size="small"
          :loading="loadingSessions"
          @click="loadSessions"
        >
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
        <el-button
          size="small"
          :disabled="otherSessionCount === 0"
          :loading="revokingOthers"
          @click="revokeOtherSessions"
        >
          <el-icon><SwitchButton /></el-icon>退出其他设备
        </el-button>
      </div>
    </div>

    <div
      v-loading="loadingSessions"
      class="device-list"
    >
      <div
        v-if="!sessions.length"
        class="device-empty"
      >
        暂无有效的登录设备。
      </div>
      <div
        v-for="session in sessions"
        :key="session.id"
        class="device-row"
      >
        <div
          class="device-symbol"
          :class="'kind-' + session.device.kind"
        >
          <el-icon><Monitor /></el-icon>
        </div>
        <div class="device-copy">
          <div class="device-name">
            {{ session.device.label }}
            <span
              v-if="session.current"
              class="current-badge"
            >当前设备</span>
          </div>
          <div class="device-meta">
            最近活动 {{ formatDateTime(session.lastUsedAt) }} · 登录于 {{ formatDateTime(session.createdAt) }} · 到期 {{ formatDateTime(session.expiresAt) }}
          </div>
        </div>
        <el-button
          text
          size="small"
          class="device-revoke"
          :loading="revokingId === session.id"
          @click="revokeSession(session)"
        >
          撤销
        </el-button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.security-icon{font-size:18px;color:var(--primary)}
.form-title{display:flex;align-items:center;gap:9px;color:var(--ink-soft);font-size:14px;font-weight:800;margin-bottom:20px}
.password-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 14px}
.form-actions{display:flex;justify-content:flex-end;margin-top:6px}
.device-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.device-title{display:flex;align-items:center;gap:7px;color:var(--ink-soft);font-size:12px;font-weight:800}
.device-title .el-icon{color:var(--primary);font-size:14px}
.device-actions{display:flex;align-items:center;gap:6px}
.device-list{margin-top:14px;min-height:60px}
.device-empty{padding:22px 0;color:var(--muted);font-size:12px;text-align:center}
.device-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--line)}
.device-row:last-child{border-bottom:0}
.device-symbol{display:flex;width:34px;height:34px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:11px;background:var(--brand-soft);color:var(--primary);font-size:16px}
.device-symbol.kind-mobile,.device-symbol.kind-tablet{background:#eef6ff;color:#4b8ce0}
.device-copy{min-width:0;flex:1}
.device-name{display:flex;align-items:center;gap:8px;color:var(--ink-soft);font-size:12px;font-weight:700}
.current-badge{padding:2px 7px;border-radius:999px;background:var(--brand-soft);color:var(--brand-strong);font-size:12px;font-weight:700}
.device-meta{margin-top:4px;color:var(--muted);font-size:12px;line-height:1.6}
.device-revoke{color:var(--muted)}
@media(max-width:1000px){.password-grid{grid-template-columns:1fr}}
</style>
