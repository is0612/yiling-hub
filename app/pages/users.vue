<script setup lang="ts">
import { Refresh, UserFilled } from "@element-plus/icons-vue";
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

const loading = ref(false);
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
        <el-button
          :loading="loading"
          @click="loadUsers"
        >
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </template>
    </PageHeader>

    <section class="surface">
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
              <el-tag
                :type="(row as AdminUser).role === 'ADMIN' ? 'primary' : 'info'"
                effect="light"
                size="small"
              >
                {{ (row as AdminUser).role === "ADMIN" ? "管理员" : "用户" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="100"
          >
            <template #default="{ row }">
              <el-tag
                :type="(row as AdminUser).status === 'ACTIVE' ? 'success' : 'danger'"
                effect="light"
                size="small"
              >
                {{ (row as AdminUser).status === "ACTIVE" ? "正常" : "已停用" }}
              </el-tag>
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
              <el-button
                text
                size="small"
                type="primary"
                @click="openReset(row as AdminUser)"
              >
                重置密码
              </el-button>
              <el-button
                v-if="(row as AdminUser).status === 'ACTIVE'"
                text
                size="small"
                type="danger"
                @click="toggleStatus(row as AdminUser)"
              >
                停用
              </el-button>
              <el-button
                v-else
                text
                size="small"
                type="success"
                @click="toggleStatus(row as AdminUser)"
              >
                启用
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>

    <section
      class="surface"
      style="margin-top:16px"
    >
      <div class="audit-title">
        最近登录活动
      </div>
      <div
        v-if="!auditItems.length"
        class="audit-empty"
      >
        暂无记录。
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
    </section>

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
.users-table { min-height: 200px; }
.user-cell { display: flex; align-items: center; gap: 10px; }
.user-avatar { display: flex; width: 32px; height: 32px; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 10px; background: #f2f0ff; color: #786be4; font-size: 15px; }
.user-name { color: #48536d; font-size: 13px; font-weight: 700; }
.user-sub { margin-top: 2px; color: #9aa4b7; font-size: 11px; }
.reset-hint { margin: 0 0 12px; color: #8c97ac; font-size: 12px; line-height: 1.6; }
.audit-title { color: #48536d; font-size: 12px; font-weight: 800; margin-bottom: 8px; }
.audit-empty { padding: 16px 0; color: #b4bbc8; font-size: 11px; }
.audit-row { display: flex; align-items: center; gap: 14px; border-bottom: 1px solid #f0f2f7; padding: 9px 0; font-size: 12px; }
.audit-row:last-child { border-bottom: 0; }
.audit-action { color: #5f6a83; font-weight: 700; }
.audit-action.is-fail { color: #c45e76; }
.audit-actor { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #7d879c; }
.audit-time { color: #a3aabb; font-size: 11px; }
</style>
