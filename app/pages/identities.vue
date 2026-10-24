<script setup lang="ts">
import { Refresh, Link, Connection } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type ExternalIdentity = {
  id: string;
  platform: string;
  platformUid: string;
  displayName: string | null;
  status: "UNVERIFIED" | "VERIFIED" | "REVOKED";
  linkedUserId: string | null;
  linkedUsername: string | null;
  linkedEmail: string | null;
  verifiedAt: string | null;
  createdAt: string;
  characters: Array<{ characterId: string; characterName: string }>;
};

type AdminUser = { id: string; username: string; email: string | null; displayName: string | null };

const loading = ref(false);
const identities = ref<ExternalIdentity[]>([]);
const users = ref<AdminUser[]>([]);
const saving = ref(false);
const bindVisible = ref(false);
const bindTarget = ref<ExternalIdentity | null>(null);
const bindUserId = ref("");

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function platformLabel(platform: string) {
  return platform === "bili" ? "B站" : platform === "qq" ? "QQ" : platform === "wechat" ? "微信" : platform;
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const statusMap: Record<string, { label: string; type: "success" | "warning" | "danger" | "info" }> = {
  UNVERIFIED: { label: "未验证", type: "info" },
  VERIFIED: { label: "已绑定", type: "success" },
  REVOKED: { label: "已撤销", type: "danger" },
};

async function loadIdentities() {
  loading.value = true;
  try {
    const response = await $fetch<{ identities: ExternalIdentity[] }>("/api/admin/identities");
    identities.value = response.identities;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取外部身份列表。"));
  } finally {
    loading.value = false;
  }
}

async function loadUsers() {
  try {
    const response = await $fetch<{ users: AdminUser[] }>("/api/admin/users");
    users.value = response.users;
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取用户列表。"));
  }
}

function openBind(identity: ExternalIdentity) {
  bindTarget.value = identity;
  bindUserId.value = "";
  bindVisible.value = true;
}

async function submitBind() {
  if (saving.value || !bindTarget.value) return;
  if (!bindUserId.value) {
    ElMessage.warning("请选择要绑定的站内用户。");
    return;
  }
  saving.value = true;
  try {
    await $fetch(`/api/admin/identities/${encodeURIComponent(bindTarget.value.id)}/verify`, {
      method: "POST",
      body: { userId: bindUserId.value },
    });
    ElMessage.success("已绑定。该外部身份的私人记忆现在对该用户可读。");
    bindVisible.value = false;
    await loadIdentities();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "绑定失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}

async function unlink(identity: ExternalIdentity) {
  const confirmed = await ElMessageBox.confirm(
    `解绑后「${identity.displayName || identity.platformUid}」的私人记忆不再对该用户可读，确定？`,
    "解绑身份",
    { confirmButtonText: "解绑", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/identities/${encodeURIComponent(identity.id)}/unlink`, { method: "POST" });
    ElMessage.success("已解绑。");
    await loadIdentities();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "解绑失败，请稍后重试。"));
  }
}

async function revoke(identity: ExternalIdentity) {
  const confirmed = await ElMessageBox.confirm(
    `撤销后「${identity.displayName || identity.platformUid}」的私人记忆不再参与任何检索（数据保留），确定？`,
    "撤销身份",
    { confirmButtonText: "撤销", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/identities/${encodeURIComponent(identity.id)}/revoke`, { method: "POST" });
    ElMessage.success("已撤销。");
    await loadIdentities();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "撤销失败，请稍后重试。"));
  }
}

onMounted(async () => {
  await Promise.all([loadIdentities(), loadUsers()]);
});
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="系统管理 / 身份管理"
      title="跨平台身份"
      description="各平台外部用户跟角色互动时会被记录为「外部身份」。默认按平台隔离、不合并；管理员可显式把某个外部身份绑定到站内用户，打通跨平台私人记忆。"
    >
      <template #actions>
        <el-button
          :loading="loading"
          @click="loadIdentities"
        >
          <el-icon><Refresh /></el-icon>刷新
        </el-button>
      </template>
    </PageHeader>

    <div
      class="info-callout"
      style="margin-bottom:20px"
    >
      <el-icon><Connection /></el-icon>
      <span>只有显式「验证绑定」后，某个外部身份（如 B站 uid）的私人记忆才会对站内用户可读。昵称相同不会自动合并。</span>
    </div>

    <div
      v-loading="loading"
      class="identity-list"
    >
      <div
        v-if="!identities.length"
        class="identity-empty"
      >
        还没有外部身份。等角色在各平台产生互动后，这里会出现记录。
      </div>
      <article
        v-for="identity in identities"
        :key="identity.id"
        class="surface identity-card"
      >
        <div class="identity-head">
          <div class="identity-platform">
            {{ platformLabel(identity.platform) }}
          </div>
          <div class="identity-info">
            <div class="identity-name">
              {{ identity.displayName || identity.platformUid }}
            </div>
            <div class="identity-uid">
              {{ identity.platform }} · {{ identity.platformUid }}
            </div>
          </div>
          <el-tag
            :type="statusMap[identity.status]?.type ?? 'info'"
            effect="light"
            size="small"
          >
            {{ statusMap[identity.status]?.label ?? identity.status }}
          </el-tag>
        </div>

        <div class="metric-row">
          <span>关联角色</span>
          <span class="metric-value">{{ identity.characters.map((c) => c.characterName).join("、") || "—" }}</span>
        </div>
        <div class="metric-row">
          <span>绑定用户</span>
          <span class="metric-value">{{ identity.linkedUsername || identity.linkedEmail || "未绑定" }}</span>
        </div>
        <div class="metric-row">
          <span>首次出现</span>
          <span class="metric-value">{{ formatDateTime(identity.createdAt) }}</span>
        </div>

        <div
          style="display:flex;gap:8px;margin-top:14px"
        >
          <el-button
            v-if="identity.status !== 'VERIFIED' && identity.status !== 'REVOKED'"
            size="small"
            type="primary"
            @click="openBind(identity)"
          >
            <el-icon><Link /></el-icon>绑定到用户
          </el-button>
          <el-button
            v-if="identity.status === 'VERIFIED'"
            size="small"
            plain
            type="warning"
            @click="unlink(identity)"
          >
            解绑
          </el-button>
          <el-button
            v-if="identity.status !== 'REVOKED'"
            size="small"
            plain
            type="danger"
            @click="revoke(identity)"
          >
            撤销
          </el-button>
        </div>
      </article>
    </div>

    <el-dialog
      v-model="bindVisible"
      title="绑定外部身份到用户"
      width="440px"
    >
      <p
        style="color:#8b96ab;font-size:13px;margin:0 0 16px"
      >
        把「{{ bindTarget?.displayName || bindTarget?.platformUid }}」绑定到某个站内用户，之后该身份的私人记忆会在该用户与角色对话时被检索到。
      </p>
      <el-form label-position="top">
        <el-form-item label="站内用户">
          <el-select
            v-model="bindUserId"
            placeholder="选择要绑定的用户"
            style="width:100%"
          >
            <el-option
              v-for="user in users"
              :key="user.id"
              :label="user.displayName || user.email || user.username"
              :value="user.id"
            />
          </el-select>
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
.identity-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}
.identity-card{padding:20px}
.identity-empty{grid-column:1/-1;padding:40px 0;color:#a3aabb;font-size:12px;text-align:center}
.identity-head{display:flex;align-items:flex-start;gap:11px;min-height:52px}
.identity-platform{display:flex;width:42px;height:42px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:13px;background:#f0eeff;color:#786be4;font-size:13px;font-weight:700}
.identity-info{flex:1;min-width:0}
.identity-name{font-size:15px;font-weight:500;color:var(--color-text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.identity-uid{font-size:11px;color:#8b96ab;margin-top:2px;word-break:break-all}
@media(max-width:800px){.identity-list{grid-template-columns:1fr}}
</style>
