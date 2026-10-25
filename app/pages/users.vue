<script setup lang="ts">
import { Clock, Refresh, UserFilled } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type AdminUser = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  characterCount: number;
  lastActiveAt: string | null;
};

const loading = ref(true);
const users = ref<AdminUser[]>([]);
const resetting = ref(false);
const dialogVisible = ref(false);
const resetTarget = ref<AdminUser | null>(null);
const resetPassword = ref("");

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function formatDateTime(value: string | null) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "从未";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const adminCount = computed(() => users.value.filter((item) => item.role === "ADMIN").length);
const disabledCount = computed(() => users.value.filter((item) => item.status === "DISABLED").length);

function labelOf(user: AdminUser) {
  return user.displayName || user.email || user.username;
}

async function loadUsers() {
  loading.value = true;
  try {
    const response = await $fetch<{ users: AdminUser[] }>("/api/admin/users");
    users.value = response.users;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取用户列表。"));
  } finally {
    loading.value = false;
  }
}

type AuditItem = { id: string; action: string; createdAt: string; actor: string | null; details: unknown };
const auditItems = ref<AuditItem[]>([]);
const actionLabels: Record<string, string> = {
  "auth.login": "登录",
  "auth.login_failed": "登录失败",
  "auth.logout": "退出登录",
  "auth.register": "注册账号",
  "auth.password_changed": "修改密码",
  "auth.session_revoked": "撤销会话",
  "auth.sessions_revoked": "退出其他设备",
};

async function loadAudit() {
  try {
    const response = await $fetch<{ items: AuditItem[] }>("/api/admin/audit?limit=30");
    auditItems.value = response.items;
  } catch {
    // 审计读取失败不影响用户管理主功能。
  }
}

async function toggleStatus(user: AdminUser) {
  const next = user.status === "ACTIVE" ? "DISABLED" : "ACTIVE";
  const confirmed = await ElMessageBox.confirm(
    next === "DISABLED" ? `停用后「${labelOf(user)}」会立即退出登录且无法再登录，确定？` : `重新启用「${labelOf(user)}」的账号？`,
    next === "DISABLED" ? "停用账号" : "启用账号",
    { confirmButtonText: next === "DISABLED" ? "停用" : "启用", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;

  try {
    await $fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: "PATCH", body: { status: next } });
    ElMessage.success(next === "DISABLED" ? "账号已停用。" : "账号已启用。");
    await loadUsers();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "操作失败，请稍后重试。"));
  }
}

function openReset(user: AdminUser) {
  resetTarget.value = user;
  resetPassword.value = "";
  dialogVisible.value = true;
}

async function submitReset() {
  if (resetting.value || !resetTarget.value) return;
  const password = resetPassword.value;
  if (password.length < 10) {
    ElMessage.warning("新密码至少 10 个字符。");
    return;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    ElMessage.warning("新密码必须同时包含字母和数字。");
    return;
  }
  resetting.value = true;
  try {
    await $fetch(`/api/admin/users/${encodeURIComponent(resetTarget.value.id)}`, {
      method: "PATCH",
      body: { password },
    });
    ElMessage.success("密码已重置，请把新密码告知该用户。");
    resetTarget.value = null;
    resetPassword.value = "";
    dialogVisible.value = false;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "重置失败，请稍后重试。"));
  } finally {
    resetting.value = false;
  }
}

onMounted(() => {
  loadUsers();
  loadAudit();
});
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / 用户管理"
      title="用户管理"
      description="查看使用本系统的账号与活动统计。这里只显示账号信息，不包含任何人的对话或记忆内容。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadUsers"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
      </template>
    </PageHeader>

    <div class="kpi-row is-three">
      <div class="kpi">
        <div class="k">
          全部账号
        </div>
        <div class="v">
          {{ users.length }}<small>个</small>
        </div>
        <div class="foot">
          只显示账号信息，不含对话与记忆内容
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          管理员
        </div>
        <div class="v">
          {{ adminCount }}<small>个</small>
        </div>
        <div class="foot">
          可管理用户、渠道与系统设置
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          已停用
        </div>
        <div class="v">
          {{ disabledCount }}<small>个</small>
        </div>
        <div class="foot">
          停用后无法登录，数据保留
        </div>
      </div>
    </div>

    <div class="card table-card">
      <div
        v-loading="loading"
        class="users-table"
      >
        <el-table
          :data="users"
          style="width: 100%"
        >
          <el-table-column
            label="账号"
            min-width="200"
          >
            <template #default="{ row }">
              <div class="user-cell">
                <div class="user-avatar">
                  <el-icon><UserFilled /></el-icon>
                </div>
                <div>
                  <div class="user-name">
                    {{ labelOf(row as AdminUser) }}
                  </div>
                  <div class="user-sub">
                    {{ (row as AdminUser).email || (row as AdminUser).username }}
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="角色"
            width="110"
          >
            <template #default="{ row }">
              <span
                class="pill"
                :class="(row as AdminUser).role === 'ADMIN' ? 'pill-purple' : 'pill-gray'"
              >{{ (row as AdminUser).role === "ADMIN" ? "管理员" : "用户" }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="100"
          >
            <template #default="{ row }">
              <span
                class="pill"
                :class="(row as AdminUser).status === 'ACTIVE' ? 'pill-green' : 'pill-rose'"
              >{{ (row as AdminUser).status === "ACTIVE" ? "正常" : "已停用" }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="角色数"
            width="90"
            align="center"
          >
            <template #default="{ row }">
              {{ (row as AdminUser).characterCount }}
            </template>
          </el-table-column>
          <el-table-column
            label="注册时间"
            width="150"
          >
            <template #default="{ row }">
              {{ formatDateTime((row as AdminUser).createdAt) }}
            </template>
          </el-table-column>
          <el-table-column
            label="最后活跃"
            width="150"
          >
            <template #default="{ row }">
              {{ formatDateTime((row as AdminUser).lastActiveAt) }}
            </template>
          </el-table-column>
          <el-table-column
            label="操作"
            width="170"
            fixed="right"
          >
            <template #default="{ row }">
              <div class="row-actions">
                <button
                  type="button"
                  class="card-link"
                  @click="openReset(row as AdminUser)"
                >
                  重置密码
                </button>
                <button
                  v-if="(row as AdminUser).status === 'ACTIVE'"
                  type="button"
                  class="card-link is-danger"
                  @click="toggleStatus(row as AdminUser)"
                >
                  停用
                </button>
                <button
                  v-else
                  type="button"
                  class="card-link is-ok"
                  @click="toggleStatus(row as AdminUser)"
                >
                  启用
                </button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <div class="sec-h">
      <h2>最近登录活动</h2>
      <span class="sub">{{ auditItems.length }} 条</span>
    </div>
    <div class="card audit-panel">
      <div
        v-if="!auditItems.length"
        class="card-empty"
      >
        <el-icon><Clock /></el-icon>
        <span>还没有登录记录</span>
        <span>账号登录、失败与登出都会留下审计记录</span>
      </div>
      <div
        v-for="item in auditItems"
        :key="item.id"
        class="audit-row"
      >
        <span
          class="audit-action"
          :class="{ 'is-fail': item.action === 'auth.login_failed' }"
        >
          {{ actionLabels[item.action] || item.action }}
        </span>
        <span class="audit-actor">
          {{ item.actor || "—" }}
        </span>
        <span class="audit-time">
          {{ formatDateTime(item.createdAt) }}
        </span>
      </div>
    </div>

    <el-dialog
      v-model="dialogVisible"
      title="重置密码"
      width="420px"
    >
      <p class="reset-hint">
        为「{{ resetTarget ? labelOf(resetTarget) : "" }}」设置一个新密码，对方登录后可自行修改。
      </p>
      <el-input
        v-model="resetPassword"
        type="password"
        show-password
        placeholder="至少 10 位，含字母与数字"
      />
      <template #footer>
        <el-button @click="dialogVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="resetting"
          @click="submitReset"
        >
          确认重置
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.table-card{padding:6px 0 4px}
.users-table{min-height:120px}
.user-cell{display:flex;align-items:center;gap:10px}
.user-avatar{display:flex;width:30px;height:30px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-sm);background:var(--brand-soft);color:var(--brand);font-size:14px}
.user-name{color:var(--text-2);font-size:14px;font-weight:600}
.user-sub{margin-top:2px;color:var(--faint);font-size:12px}
.row-actions{display:flex;align-items:center;gap:12px}
.card-link.is-danger{color:var(--red)}
.card-link.is-danger:hover{color:#b02338}
.card-link.is-ok{color:var(--green)}
.reset-hint{margin:0 0 12px;color:var(--dim);font-size:12px;line-height:1.7}

.audit-panel{padding:6px 18px 8px}
.audit-row{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding:10px 0;font-size:12px}
.audit-row:last-child{border-bottom:0}
.audit-action{flex:0 0 96px;color:var(--text-2);font-weight:600}
.audit-action.is-fail{color:var(--red)}
.audit-actor{min-width:0;flex:1;overflow:hidden;color:var(--dim);text-overflow:ellipsis;white-space:nowrap}
.audit-time{color:var(--faint);font-size:12px;white-space:nowrap}

@media(max-width:700px){
  .audit-action{flex:0 0 auto}
}
</style>
